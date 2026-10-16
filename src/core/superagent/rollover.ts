/**
 * Conversation rollover for a superagent's main (manifest `main.rollover`,
 * which needs `"memory": true`).
 *
 * While the main is idle and its prompt cache still warm, agentbox asks it
 * for a handoff (`checkpointIfDue`): a short JSON summary it saves in its
 * memory journal. A later message that finds the main cold, or fuller than
 * `contextPct`, starts a fresh main from that handoff, the memory and the
 * live state it takes over (`deliver`), and the main is handed over to it
 * (`Fleet.handOver`, the same handover a program asks for). A missing or
 * stale handoff never drops a message: it goes to the old main as before.
 *
 * Each step is journaled before it is taken (`SuperagentState.rollover`):
 * the old process is stopped and proven gone before the successor starts;
 * the successor is proven started (its transcript exists) before the old
 * main's waits, cards, PR claims and sessions move; a restart finishes or
 * undoes what it finds.
 */
import { existsSync } from "node:fs";
import { isKeepWarmNote } from "../cache";
import { moveCards } from "../cards";
import { getDb, getSessionRecord, listOpenWaits, updateSessionRecord } from "../db";
import { FleetError, newSessionId, type Fleet, type SpawnRequest } from "../fleet";
import { movePrClaims, unfinishedClaims } from "../prclaims";
import { transcriptFile } from "../providers/types";
import type { ProviderId, Session } from "../types";
import { describe as describeWait } from "../waits";
import { journalOf, memoryCommand } from "./memory";
import { patchState, stateOf, type Checkpoint, type Selection } from "./state";

import { CHECKPOINT_MARK } from "./marks";
export { CHECKPOINT_MARK } from "./marks";
/** A handoff is asked for while at least this much of the cache's life is left. */
const CHECKPOINT_WARM_MS = 3 * 60_000;
/** A request with no handoff after this long, the main idle, failed. */
const CHECKPOINT_WAIT_MS = 15 * 60_000;

export type Policy = { idleMin: number; contextPct: number };

/** What the rollover asks of the hub about a superagent. */
export interface RolloverHost {
  /** Enabled superagents with rollover on, and their main now. */
  rolling(): { name: string; main: string | null; policy: Policy }[];
  /** Every registered superagent: a journal left by a restart is finished
   *  whatever its manifest says now. */
  names(): string[];
  /** The superagent whose main (now, or before a rollover in progress) is `id`. */
  byMain(id: string): { name: string; main: string | null; policy: Policy | null; enabled: boolean } | null;
  /** How its fresh main is started: `main.start`, its cwd resolved. */
  startSpec(name: string): Partial<SpawnRequest> & { provider: ProviderId | "auto" };
  /** The first prompt of the fresh main that continues `old`. */
  opening(name: string, text: string, from: { old: string; memory: string; work: string }, session: string): string;
  /** The main changed (the board and the Agents page follow). */
  changed(): void;
}

const live = (s: Session | undefined) => !!s && (s.host !== "none" || !!s.pid);

export class Rollover {
  /** Superagents with a rollover running in this process. */
  private rollingNow = new Set<string>();
  /** The session activity a handoff was last asked at: asked once per quiet spell. */
  private looked = new Map<string, number>();
  /** How long a successor has to write its transcript. */
  proofMs = 60_000;

  constructor(
    private readonly fleet: Fleet,
    private readonly host: RolloverHost,
  ) {}

  /** Fleet asks before resuming a session: one replaced by a successor never runs beside it. */
  replacedBy(id: string): string | null {
    const a = this.host.byMain(id);
    if (!a) return null;
    const r = stateOf(a.name).rollover;
    if (r?.from === id && r.phase === "spawning") return r.to;
    return stateOf(a.name).rolled?.[id] ? this.fleet.heir(id) : null;
  }

  /**
   * Fleet's hook before a message reaches a session. For a superagent's main
   * that is cold (`Session.cacheWarmUntil`) or fuller than its policy allows,
   * with a handoff saved after its last real prompt and nothing running that
   * a stop would lose, start the successor with the message. Otherwise the
   * message goes to the main as before.
   */
  async deliver(id: string, text: string, attempt?: () => void): Promise<boolean> {
    const a = this.host.byMain(id);
    if (!a) return false;
    const st = stateOf(a.name);
    if (st.rollover?.from === id) throw new FleetError(409, `this conversation is being continued in ${st.rollover.to}; try again in a moment`);
    if (a.main !== id) {
      // A message to a main it replaced goes to the one now current.
      if (!a.main || this.fleet.heir(id) !== a.main) return false;
      await this.fleet.send(a.main, text, attempt, true);
      return true;
    }
    if (!a.enabled || !a.policy || this.rollingNow.has(a.name)) return false;
    const s = this.fleet.sessions().find((x) => x.id === id);
    if (!s || s.status === "running" || s.status === "blocked" || s.status === "closed" || s.queued.length || s.question) return false;
    const pct = s.contextUsed && s.contextLimit ? (100 * s.contextUsed) / s.contextLimit : 0;
    const why = Date.now() > s.cacheWarmUntil ? "cold" : pct >= a.policy.contextPct ? "context" : null;
    if (!why) return false;
    // Only a handoff saved after the last real prompt starts a successor.
    const handoff = await this.freshHandoff(a.name, id);
    if (!handoff || (await this.fleet.stopHold(id))) return false;
    this.rollingNow.add(a.name);
    try {
      return await this.rollover(a.name, s, handoff, why, text, attempt);
    } finally {
      this.rollingNow.delete(a.name);
    }
  }

  /** A rollover runs for it now, in this process or journaled. */
  busy(name: string): boolean {
    return this.rollingNow.has(name) || !!stateOf(name).rollover;
  }

  /** The handoff saved on request in `session`, when nothing real reached it since. */
  private async freshHandoff(name: string, session: string): Promise<string | null> {
    const c = stateOf(name).checkpoint;
    if (!c || c.session !== session || c.state !== "saved" || !c.handoff) return null;
    return (await this.lastPrompt(session)) === c.request ? c.handoff : null;
  }

  /**
   * The checkpoint request the conversation's newest prompt is, or null when
   * its newest prompt is real: the user's, an agent's, a wait's or a card's.
   * Keep-warm notes are skipped. Not found in the tail counts as real.
   */
  private async lastPrompt(session: string): Promise<string | null> {
    const page = await this.fleet.timeline(session, null, 80).catch(() => null);
    for (const e of [...(page?.events ?? [])].reverse()) {
      if (e.kind !== "user") continue;
      const at = e.text.indexOf(CHECKPOINT_MARK);
      if (at >= 0) return /^ ([0-9a-f-]{36})\]/.exec(e.text.slice(at + CHECKPOINT_MARK.length))?.[1] ?? null;
      if (!isKeepWarmNote(e.text)) return null;
    }
    return null;
  }

  /** What the successor must know is live: what the replaced main holds that now passes to it. */
  private currentWork(old: string): string {
    const cards = getDb().query("SELECT id, kind, title FROM cards WHERE session_id = ? AND state IN ('open','later') ORDER BY id").all(old) as { id: number; kind: string; title: string }[];
    const lines = [
      ...listOpenWaits(0).filter((w) => !w.ended && this.fleet.heir(w.sessionId) === old).map((w) => `- Wait ${w.id}: ${describeWait(w.spec)}`),
      ...cards.map((c) => `- Review card ${c.id} (${c.kind}): ${c.title}`),
      ...(unfinishedClaims().get(old) ?? []).map((pr) => `- PR ${pr}, claimed`),
      ...this.fleet.startedBy(old).map((id) => `- Session ${id}, started earlier and still yours`),
    ];
    return lines.slice(0, 30).map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, 300)).join("\n");
  }

  /**
   * Replace `old` with a successor started from `handoff` and `text`. The
   * old process is stopped and proven gone before the successor starts;
   * succession, Review cards and PR claims move only once it has started.
   */
  private async rollover(name: string, old: Session, handoff: string, why: "cold" | "context", text: string, attempt?: () => void): Promise<boolean> {
    const fleet = this.fleet, to = newSessionId();
    // Where the successor runs is chosen before anything is stopped; nothing
    // available, or no way to start one, leaves the message to the old main.
    let provider: ProviderId, accountId: string, model: string | undefined, selection: Selection | undefined;
    let spec: ReturnType<RolloverHost["startSpec"]>;
    try {
      spec = this.host.startSpec(name);
      if (spec.provider === "auto") {
        const c = await fleet.chooseAuto({ ...spec, provider: "auto", previous: old.provider });
        ({ provider, accountId } = c);
        model = c.model ?? undefined;
        selection = { provider: c.provider, why: c.why, at: c.at };
      } else {
        const p = fleet.placement(spec.provider, spec.model, spec.accountId ?? null, spec.effort ?? null);
        if (!p.accountId) throw new FleetError(409, p.why);
        provider = spec.provider;
        accountId = p.accountId;
        model = spec.model;
      }
    } catch (e) {
      console.error(`agentbox: ${name}: not continuing ${old.id} in a fresh conversation: ${(e as Error).message}`);
      return false;
    }
    patchState(name, (s) => void (s.rollover = { from: old.id, to, handoff, why, at: Date.now(), phase: "stopping", ...(selection ? { selection } : {}) }));
    if (live(fleet.sessions().find((s) => s.id === old.id))) {
      await fleet.stopSession(old.id);
      await fleet.tick();
    }
    if (live(fleet.sessions().find((s) => s.id === old.id))) {
      patchState(name, (s) => void delete s.rollover);
      return false;
    }
    const boot = journalOf(name).bootstrap(name, handoff, text);
    const work = this.currentWork(old.id);
    patchState(name, (s) => {
      s.rollover!.phase = "spawning";
      s.rollover!.supplied = boot.supplied;
    });
    const rec = getSessionRecord(old.id);
    attempt?.();
    let failure: string | null = null;
    try {
      await fleet.spawn({
        ...spec,
        id: to,
        provider,
        accountId,
        ...(model ? { model } : {}),
        // Continue in the replaced main's directory when it is still there.
        ...(rec?.cwd && existsSync(rec.cwd) ? { cwd: rec.cwd, repoId: undefined, worktree: false, branch: undefined } : {}),
        prompt: this.host.opening(name, text, { old: old.id, memory: boot.text, work }, to),
        parent: undefined,
        callerPid: undefined,
        opener: { via: "agentbox" },
      });
    } catch (e) {
      failure = (e as Error).message;
    }
    // Proven only once its transcript exists: the CLI took the first prompt.
    if (!failure && !(await this.proveStarted(to))) failure = "it never wrote its transcript";
    if (failure) {
      const undone = await this.undoSuccessor(name, to, `the fresh conversation could not start: ${failure}`);
      if (undone === "undone") return false;
      if (undone === "stuck") throw new FleetError(409, `the fresh conversation ${to} could not be proven started or stopped; check it before sending again`);
      return true;
    }
    await this.completeRollover(name);
    console.log(`agentbox: ${name} continues ${old.id} in ${to} on ${provider} (${accountId}) from handoff ${handoff} (${why})`);
    return true;
  }

  /** The CLI has written the successor's transcript: it has the first prompt. */
  private started(id: string): boolean {
    const rec = getSessionRecord(id);
    return !!rec?.transcriptPath && existsSync(transcriptFile(rec.transcriptPath));
  }

  private async proveStarted(id: string): Promise<boolean> {
    const from = Date.now(), grace = this.proofMs / 9;
    for (;;) {
      await this.fleet.tick();
      if (this.started(id)) return true;
      const v = this.fleet.sessions().find((s) => s.id === id), waited = Date.now() - from;
      // Never got a pane, or its process exited before writing anything.
      if (waited > grace && (getSessionRecord(id)?.tmux === null || (v && v.host === "none" && !v.pid))) return false;
      if (waited >= this.proofMs) return false;
      await Bun.sleep(Math.min(1_000, grace / 4));
    }
  }

  /** Stop a successor that never proved itself and keep the replaced main:
   *  "undone"; "completed" when it wrote its transcript after all (it has
   *  the message); "stuck" when it will not stop. */
  private async undoSuccessor(name: string, to: string, error: string): Promise<"undone" | "completed" | "stuck"> {
    const fleet = this.fleet;
    if (getSessionRecord(to)) {
      await fleet.tick();
      if (!this.started(to)) {
        if (live(fleet.sessions().find((s) => s.id === to))) await fleet.stopSession(to).catch(() => undefined);
        // Two fresh passes: one may have begun before a late transcript was written.
        await fleet.tick();
        await fleet.tick();
        if (live(fleet.sessions().find((s) => s.id === to))) return "stuck";
      }
      if (this.started(to)) {
        this.unstop(to);
        await this.completeRollover(name);
        return "completed";
      }
      // Off the board: it never had a conversation.
      await fleet.close(to, true, true).catch(() => undefined);
    }
    this.revert(name, error);
    return "undone";
  }

  private async completeRollover(name: string): Promise<void> {
    const r = stateOf(name).rollover;
    if (!r || r.phase !== "spawning") return;
    // The main follows the successor (`Fleet.heir`): the hub needs no word of its own.
    // The successor has the message already: a failure here is finished by the
    // next tick from the journal, never reported as a message not sent.
    try {
      await this.fleet.handOver(r.from, r.to);
    } catch (e) {
      console.error(`agentbox: ${name}: handing ${r.from} over to ${r.to}; the next pass finishes it:`, e);
      return;
    }
    moveCards(r.from, r.to);
    movePrClaims(r.from, r.to);
    journalOf(name).used(r.handoff, r.to);
    patchState(name, (s) => {
      if (r.selection) s.selection = r.selection;
      s.rolled = { ...s.rolled, [r.from]: r.to };
      s.contexts = { ...s.contexts, [r.to]: r.supplied ?? [] };
      delete s.rollover;
      delete s.checkpoint;
    });
    // Off the board, alone: what it started now belongs to the successor.
    await this.fleet.close(r.from, true, true).catch(() => undefined);
    this.host.changed();
  }

  /** The successor never started: the replaced main stays, parked rather
   *  than stopped by hand, so the next message resumes it. */
  private revert(name: string, error: string): void {
    patchState(name, (s) => {
      const r = s.rollover;
      if (!r) return;
      this.unstop(r.from);
      delete s.rollover;
      if (s.checkpoint?.session === r.from) Object.assign(s.checkpoint, { state: "failed", error });
    });
    console.error(`agentbox: ${name}: ${error}; the previous conversation stays its main`);
  }

  private unstop(id: string): void {
    const rec = getSessionRecord(id);
    if (rec && !rec.parkedAt && !rec.archivedAt && this.fleet.sessions().find((s) => s.id === id)?.host === "none") updateSessionRecord(id, { parkedAt: Date.now() });
  }

  /** A handoff the main saved: it answers the checkpoint request, which then says so. */
  saved(name: string, request: string | null, record: string): void {
    if (!request) return;
    patchState(name, (s) => {
      if (s.checkpoint?.request === request && s.checkpoint.state === "requested") Object.assign(s.checkpoint, { state: "saved", handoff: record });
    });
  }

  /** Finish or undo a rollover a restart interrupted, and ask idle mains for
   *  their handoff while they are still warm. */
  async tick(now = Date.now()): Promise<void> {
    for (const name of this.host.names()) {
      const r = stateOf(name).rollover;
      if (!r || this.rollingNow.has(name)) continue;
      try {
        if (r.phase === "stopping") {
          this.unstop(r.from);
          patchState(name, (s) => void delete s.rollover);
        } else if (this.started(r.to)) await this.completeRollover(name);
        else if (now - r.at > (getSessionRecord(r.to) ? 5 * 60_000 : 60_000)) await this.undoSuccessor(name, r.to, "the fresh conversation never started");
      } catch (e) {
        console.error(`agentbox: ${name}: finishing its conversation rollover:`, e);
      }
    }
    const keep = new Set<string>();
    for (const a of this.host.rolling()) {
      if (this.rollingNow.has(a.name) || stateOf(a.name).rollover || !a.main) continue;
      keep.add(a.main);
      try {
        await this.checkpointIfDue(a.name, a.main, a.policy, now);
      } catch (e) {
        console.error(`agentbox: ${a.name}: memory checkpoint:`, e);
      }
    }
    for (const id of this.looked.keys()) if (!keep.has(id)) this.looked.delete(id);
  }

  /**
   * Ask for a handoff once the user has been away `idleMin` (or the
   * conversation is past `contextPct`) while at least `CHECKPOINT_WARM_MS`
   * of its cache's life is left. The request and its reply refresh the
   * cache, so it is asked again only after something real reached it.
   */
  private async checkpointIfDue(name: string, main: string, policy: Policy, now: number): Promise<void> {
    const s = this.fleet.sessions().find((x) => x.id === main);
    if (!s || s.host !== "tmux") return;
    const all = stateOf(name).checkpoint;
    const c = all?.session === s.id ? all : undefined;
    const update = (change: (c: Checkpoint | undefined) => Checkpoint | undefined) =>
      patchState(name, (x) => {
        const next = change(x.checkpoint);
        if (next) x.checkpoint = next;
        else delete x.checkpoint;
      });
    if (c?.state === "requested") {
      if (now - c.at > CHECKPOINT_WAIT_MS && s.status === "waiting") update((x) => (x?.request === c.request && x.state === "requested" ? { ...x, state: "failed", error: "No handoff was saved" } : x));
      return;
    }
    // The cache's own lifetime sets the window: an hour-long cache is asked
    // after `idleMin`; a five-minute one about halfway, leaving time to write.
    const lifetime = Math.max(0, s.cacheWarmUntil - s.lastActivityAt);
    const lead = Math.min(CHECKPOINT_WARM_MS, lifetime / 2.5);
    if (s.status !== "waiting" || s.queued.length || s.question || s.limitHit || s.cacheWarmUntil - now < lead) return;
    const idleDue = Math.min(policy.idleMin * 60_000, Math.max(30_000, lifetime - lead - 30_000));
    const idle = now - s.lastActivityAt, pct = s.contextUsed && s.contextLimit ? Math.round((100 * s.contextUsed) / s.contextLimit) : 0;
    const reason = idle >= idleDue ? "idle" : pct >= policy.contextPct && idle >= Math.min(2 * 60_000, idleDue) && (!c || pct - (c.pct ?? 0) >= 5) ? "context" : null;
    if (!reason || this.looked.get(s.id) === s.lastActivityAt) return;
    this.looked.set(s.id, s.lastActivityAt);
    if (c && (await this.lastPrompt(s.id)) === c.request) return;
    const request = crypto.randomUUID();
    update(() => ({ session: s.id, request, at: now, reason, pct, state: "requested" }));
    const note = `${CHECKPOINT_MARK} ${request}] ${reason === "idle" ? `The user has been away for ${Math.round(idle / 60_000)} minutes.` : `This conversation is ${pct}% full.`} Save a handoff now, so that a fresh conversation can continue from it later. Write a JSON file {"intent":"what the user wants overall","decisions":[{"decision":"…","why":"…"}],"open":["questions still unanswered"],"commitments":["what you said you will do or follow"],"refs":[{"label":"…","ref":"a PR or issue URL, a wait or card ID, a file path or a session ID"}]} of at most 500 words. Put in only what a successor needs that the records do not already say, and no secrets. Then run: ${memoryCommand(name)} handoff --request ${request} --file <that file>\nReply with one short line and do nothing else. This is not a new task.`;
    try {
      await this.fleet.send(s.id, note);
      console.log(`agentbox: asked ${s.id} (${name}) for a handoff (${reason})`);
    } catch (e) {
      update((x) => (x?.request === request ? { ...x, state: "failed", error: (e as Error).message } : x));
    }
  }
}

