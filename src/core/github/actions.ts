/**
 * The GitHub actions superagents request, and their journal.
 *
 * A superagent's program, or one of its sessions, asks for one action with a
 * request id it keeps for retries. The same id with the same action answers
 * the same record; the same id with another action is refused (409). Each
 * action runs under the policy the host owner pinned (`policy.ts`): its repos,
 * its kinds, and its approval. In prepare mode the action becomes a Review
 * decision card, and a person's approval sends it once. In automatic mode it
 * is sent at once.
 *
 * At dispatch everything is checked again: the pin (a changed manifest stops
 * it), the claim's fence, and the consent of each person it contacts. An
 * approval never stands in for any of them. An action is marked attempting
 * before the broker touches GitHub; a server that stops then leaves it
 * attempting, and the next one marks it uncertain. Nothing is ever sent
 * twice: `reconcile` only reads what happened.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { UNDO_MS, type Cards } from "../cards";
import { getDb } from "../db";
import { FleetError } from "../fleet";
import { BrokerRefused, ContactRefused, GitHubAction, GitHubRead, brokerBranch, type ConsentSource, type GitHubBroker, type ManagedResult } from "./broker";
import { effectivePin, pinOf, type Pin } from "./policy";

export type ActionState = "prepared" | "approved" | "attempting" | "sent" | "uncertain" | "refused" | "failed";

/** Who asks: a superagent, through its program (session null) or one of its sessions. */
export type ActionCaller = { superagent: string; session: string | null };

/**
 * Who holds a piece of work now (`src/core/workclaims.ts`). An action that
 * names a claim is sent only while the requesting superagent holds it with
 * that fence; with no ClaimCheck wired, such an action is refused.
 */
export interface ClaimCheck {
  /** The claim on `key` (canonicalised by the claims service) as it is now; null when nobody holds it. */
  current(scope: string, key: string): Promise<{ fence: number; holder: { superagent: string | null; session: string | null } } | null>;
}
/** The scope a claim is in when the request does not name one (src/core/workclaims.ts). */
export const DEFAULT_CLAIM_SCOPE = "work";

export type ActionResult = { url?: string; status?: string; message?: string };
export type GitHubActionView = {
  request: string;
  superagent: string;
  session: string | null;
  action: GitHubAction;
  claim: { key: string; scope: string; fence: number } | null;
  branch: string;
  state: ActionState;
  result: ActionResult | null;
  card: number | null;
  approval: { by: string; at: number } | null;
  createdAt: number;
  updatedAt: number;
};

export const ActionRequest = z
  .object({
    request: z.string().uuid("request is a UUID the caller keeps for retries"),
    action: GitHubAction,
    claim: z.object({ key: z.string().min(1).max(2000), scope: z.string().min(1).max(200).optional(), fence: z.number().int().min(0) }).strict().optional(),
    /** The checkout that holds the head commit (open_pr, update_pr). A session's own cwd when left out. */
    cwd: z.string().optional(),
  })
  .strict();

/** Credential forms that must not reach GitHub text or the journal. */
const CREDENTIAL = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+|-----BEGIN .*PRIVATE KEY-----|sk-(?:live-|proj-)?[A-Za-z0-9_-]{24,})/;
const APPROVE = /^\s*(?:approve[d]?|yes|y|ok|send|go)\b/i;
const DECLINE = /^\s*(?:decline[d]?|no|n|refuse|reject|deny)\b/i;

type Row = {
  request: string;
  superagent: string;
  session: string | null;
  action: string;
  fingerprint: string;
  claim: string | null;
  cwd: string | null;
  branch: string;
  digest: string;
  state: ActionState;
  result: string | null;
  receipt: string | null;
  card: number | null;
  approved_by: string | null;
  approved_at: number | null;
  created_at: number;
  updated_at: number;
};

export type GitHubActionsDeps = {
  broker: GitHubBroker;
  cards: Pick<Cards, "add" | "get" | "close">;
  /** A registered superagent's directory (its manifest proposes the policy). */
  dirOf: (superagent: string) => string;
  /** A session's working directory, for a publication it requests. */
  cwdOf: (session: string) => string | null;
  now?: () => number;
};

function stable(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(sort(v));
}

export class GitHubActions {
  /** The cloud's contact preferences. Null: an action that contacts a person is refused. */
  consent: ConsentSource | null = null;
  /** The claims API. Null: an action that names a claim is refused. */
  claims: ClaimCheck | null = null;
  private inflight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: GitHubActionsDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** What a server before this one left attempting is uncertain; then watch cards and approvals. */
  start(): void {
    this.recover();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 3_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  recover(): number {
    return getDb().run(`UPDATE github_actions SET state = 'uncertain', result = ?, updated_at = ? WHERE state = 'attempting'`, [
      JSON.stringify({ message: "The server stopped while it sent this action. Reconcile what GitHub shows before another action; agentbox never sends it again." }),
      this.now(),
    ]).changes;
  }

  list(superagent?: string): GitHubActionView[] {
    const rows = (
      superagent
        ? getDb().query("SELECT * FROM github_actions WHERE superagent = ? ORDER BY created_at DESC LIMIT 200").all(superagent)
        : getDb().query("SELECT * FROM github_actions ORDER BY created_at DESC LIMIT 200").all()
    ) as Row[];
    return rows.map((r) => this.view(r));
  }

  get(request: string): GitHubActionView {
    return this.view(this.row(request));
  }

  /** Read through the App as `caller`'s pinned policy allows. */
  async read(caller: ActionCaller, input: unknown): Promise<unknown> {
    const parsed = GitHubRead.safeParse(input);
    if (!parsed.success) throw new FleetError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; "));
    const pin = effectivePin(caller.superagent, this.deps.dirOf(caller.superagent));
    if (!pin.policy.repos.includes(parsed.data.repo)) throw new FleetError(403, `${parsed.data.repo} is outside ${caller.superagent}'s pinned repos`);
    try {
      return await this.deps.broker.read(pin, parsed.data);
    } catch (e) {
      throw e instanceof BrokerRefused ? new FleetError(403, e.message) : e;
    }
  }

  async request(caller: ActionCaller, body: unknown): Promise<GitHubActionView> {
    const parsed = ActionRequest.safeParse(body);
    if (!parsed.success) throw new FleetError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; "));
    const { request, action } = parsed.data;
    if (CREDENTIAL.test(JSON.stringify(action))) throw new FleetError(400, "remove the credential from the action");
    const claim = parsed.data.claim ? { key: parsed.data.claim.key, scope: parsed.data.claim.scope ?? DEFAULT_CLAIM_SCOPE, fence: parsed.data.claim.fence } : null;
    const fingerprint = createHash("sha256").update(stable({ superagent: caller.superagent, action, claim, cwd: parsed.data.cwd ?? null })).digest("hex");
    const old = this.rowOrNull(request);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new FleetError(409, `request ${request} was already used for a different action`);
      return this.view(old);
    }
    const pin = effectivePin(caller.superagent, this.deps.dirOf(caller.superagent));
    this.allowed(pin, action);
    await this.checkClaim(caller.superagent, claim);
    const branch = this.branchFor(caller.superagent, request, action, claim);
    let cwd: string | null = null;
    if (action.kind === "open_pr" || action.kind === "update_pr") {
      cwd = parsed.data.cwd ?? (caller.session ? this.deps.cwdOf(caller.session) : null);
      if (!cwd || !isAbsolute(cwd) || !existsSync(cwd)) throw new FleetError(400, "a publication needs cwd: the absolute path of the checkout that holds its head");
    }
    const at = this.now();
    const inserted = getDb().run(
      `INSERT OR IGNORE INTO github_actions (request, superagent, session, action, fingerprint, claim, cwd, branch, digest, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      [request, caller.superagent, caller.session, JSON.stringify(action), fingerprint, claim && JSON.stringify(claim), cwd, branch, pin.digest, at, at],
    ).changes;
    if (!inserted) return this.request(caller, body); // the same id, at the same moment: answer as a retry
    if (pin.policy.approval === "automatic") return this.approve(request, "policy (automatic)");
    const card = this.deps.cards.add({
      kind: "decision",
      key: `github-action:${request}`,
      title: `${caller.superagent}: ${action.kind} in ${action.repo}`,
      short:
        "Answer approve to send this GitHub action once, or decline. The pinned policy, the claim and each contacted person's consent are checked again when it is sent.",
      long: `Request ${request} from ${caller.superagent}${caller.session ? ` (session ${caller.session})` : ""}, as ${pin.policy.app.login}.\n\n\`\`\`json\n${JSON.stringify(action, null, 2)}\n\`\`\``,
      recommend: "approve",
    });
    getDb().run("UPDATE github_actions SET card = ? WHERE request = ?", [card.id, request]);
    return this.get(request);
  }

  /** A person approves a prepared action: it is sent once, now. */
  async approve(request: string, by: string): Promise<GitHubActionView> {
    const r = this.row(request);
    const moved = getDb().run(`UPDATE github_actions SET state = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE request = ? AND state = 'prepared'`, [
      by,
      this.now(),
      this.now(),
      request,
    ]).changes;
    if (!moved && r.state !== "approved") {
      if (r.state === "prepared") throw new FleetError(409, `request ${request} could not be approved`);
      return this.view(r);
    }
    if (moved && r.card) this.closeCard(r.card, `approved by ${by}`);
    await this.dispatch(request);
    return this.get(request);
  }

  decline(request: string, by: string): GitHubActionView {
    const r = this.row(request);
    if (r.state !== "prepared") throw new FleetError(409, `request ${request} is ${r.state}, not waiting for approval`);
    this.move(request, "prepared", "refused", { message: `Declined by ${by}.` });
    if (r.card) this.closeCard(r.card, `declined by ${by}`);
    return this.get(request);
  }

  /** Read what an uncertain or pending merge or closure did. Never sends anything. */
  async reconcile(request: string): Promise<GitHubActionView> {
    const r = this.row(request);
    const result = r.result ? (JSON.parse(r.result) as ActionResult) : null;
    const pending = r.state === "sent" && (result?.status === "pending" || result?.status === "enqueued");
    const pin = pinOf(r.superagent);
    if ((r.state !== "uncertain" && !pending) || !pin) return this.view(r);
    const found = await this.deps.broker.reconcile(pin, GitHubAction.parse(JSON.parse(r.action)), r.receipt ?? undefined);
    if (found === "rejected") this.move(request, r.state, "failed", { message: "GitHub rejected the protected merge request; nothing merged. Request a new action." });
    else if (found) this.move(request, r.state, "sent", { url: found.url, status: found.status });
    return this.get(request);
  }

  // ------------------------------------------------------------- inside

  private rowOrNull(request: string): Row | null {
    return getDb().query("SELECT * FROM github_actions WHERE request = ?").get(request) as Row | null;
  }

  private row(request: string): Row {
    const r = this.rowOrNull(request);
    if (!r) throw new FleetError(404, `no GitHub action ${request}`);
    return r;
  }

  private view(r: Row): GitHubActionView {
    return {
      request: r.request,
      superagent: r.superagent,
      session: r.session,
      action: JSON.parse(r.action) as GitHubAction,
      claim: r.claim ? (JSON.parse(r.claim) as GitHubActionView["claim"]) : null,
      branch: r.branch,
      state: r.state,
      result: r.result ? (JSON.parse(r.result) as ActionResult) : null,
      card: r.card,
      approval: r.approved_by ? { by: r.approved_by, at: r.approved_at ?? 0 } : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** Every state change names the state it leaves, so two dispatchers never both win. */
  private move(request: string, from: ActionState, to: ActionState, result?: ActionResult, receipt?: string): boolean {
    return (
      getDb().run(`UPDATE github_actions SET state = ?, result = COALESCE(?, result), receipt = COALESCE(?, receipt), updated_at = ? WHERE request = ? AND state = ?`, [
        to,
        result ? JSON.stringify(result) : null,
        receipt ?? null,
        this.now(),
        request,
        from,
      ]).changes > 0
    );
  }

  private allowed(pin: Pin, action: GitHubAction): void {
    if (!pin.policy.repos.includes(action.repo)) throw new FleetError(403, `${action.repo} is outside ${pin.superagent}'s pinned repos`);
    if (!pin.policy.actions.includes(action.kind)) throw new FleetError(403, `${action.kind} is outside ${pin.superagent}'s pinned actions`);
  }

  private async checkClaim(superagent: string, claim: GitHubActionView["claim"]): Promise<void> {
    if (!claim) return;
    if (!this.claims) throw new FleetError(409, "this action names a claim, and no claims service is wired to check it");
    const now = await this.claims.current(claim.scope, claim.key);
    if (!now) throw new FleetError(409, `nobody holds ${claim.key} now`);
    if (now.holder.superagent !== superagent) throw new FleetError(409, `${now.holder.superagent}, not ${superagent}, holds ${claim.key}`);
    if (now.fence !== claim.fence) throw new FleetError(409, `the claim on ${claim.key} is at fence ${now.fence}, not ${claim.fence}: it moved since`);
  }

  /**
   * The branch an `open_pr` creates: bound to the claim when there is one,
   * otherwise to the request. `update_pr` finds the same one: the claim's, or
   * the branch of this superagent's own `open_pr` that made the PR.
   */
  private branchFor(superagent: string, request: string, action: GitHubAction, claim: GitHubActionView["claim"]): string {
    if (claim) return brokerBranch(`${claim.scope}:${claim.key}`);
    if (action.kind !== "update_pr") return brokerBranch(request);
    const opened = getDb()
      .query(`SELECT branch, result FROM github_actions WHERE superagent = ? AND state = 'sent' AND json_extract(action, '$.kind') = 'open_pr' AND json_extract(action, '$.repo') = ?`)
      .all(superagent, action.repo) as { branch: string; result: string | null }[];
    const own = opened.find((o) => o.result && new RegExp(`/pull/${action.number}$`).test((JSON.parse(o.result) as ActionResult).url ?? ""));
    if (!own) throw new FleetError(409, `update_pr needs the claim the PR was opened under, or ${superagent}'s own open_pr for ${action.repo}#${action.number}`);
    return own.branch;
  }

  private closeCard(id: number, why: string): void {
    try {
      if (this.deps.cards.get(id).state === "open" || this.deps.cards.get(id).state === "later") this.deps.cards.close(id, why);
    } catch {
      // A card that is gone or answered needs nothing.
    }
  }

  /** Check again, mark attempting, send. A failure before anything visible is
   *  failed (or refused); after, it is uncertain. */
  private async dispatch(request: string): Promise<void> {
    if (this.inflight.has(request)) return;
    this.inflight.add(request);
    try {
      const r = this.row(request);
      if (r.state !== "approved") return;
      const action = GitHubAction.parse(JSON.parse(r.action));
      const claim = r.claim ? (JSON.parse(r.claim) as GitHubActionView["claim"]) : null;
      const recheck = async () => {
        const pin = effectivePin(r.superagent, this.deps.dirOf(r.superagent));
        if (pin.digest !== r.digest) throw new FleetError(403, `${r.superagent}'s pinned GitHub policy changed since this action was requested; request it again`);
        this.allowed(pin, action);
        await this.checkClaim(r.superagent, claim);
        return pin;
      };
      let pin: Pin;
      try {
        pin = await recheck();
      } catch (e) {
        this.move(request, "approved", "refused", { message: (e as Error).message });
        return;
      }
      if (!this.move(request, "approved", "attempting")) return;
      const visible = { sent: false };
      try {
        const result: ManagedResult = await this.deps.broker.dispatch(
          { superagent: r.superagent, pin, branch: r.branch, cwd: r.cwd, consent: this.consent, visible, guard: async () => void (await recheck()) },
          action,
        );
        this.move(request, "attempting", "sent", { url: result.url, ...(result.status ? { status: result.status } : {}) }, result.receipt);
      } catch (e) {
        const refusal = e instanceof ContactRefused || e instanceof BrokerRefused || e instanceof FleetError;
        const state: ActionState = visible.sent ? "uncertain" : refusal ? "refused" : "failed";
        this.move(request, "attempting", state, { message: (e as Error).message });
        if (state === "uncertain")
          this.deps.cards.add({
            kind: "decision",
            key: `github-action:${request}:uncertain`,
            title: `${r.superagent}: a GitHub ${action.kind} in ${action.repo} needs a person`,
            short: `It stopped after GitHub could see part of it: ${(e as Error).message}`.slice(0, 1100),
            long: `Request ${request}. Look at ${action.repo} on GitHub and reconcile it (\`agentbox github actions ${request}\`); agentbox never sends it again.`,
          });
      }
    } finally {
      this.inflight.delete(request);
    }
  }

  /** A person's answer on a prepared action's card, once its undo has run out;
   *  and approved actions a stopped server did not get to. */
  async tick(): Promise<void> {
    const rows = getDb().query(`SELECT * FROM github_actions WHERE state IN ('prepared', 'approved')`).all() as Row[];
    for (const r of rows) {
      try {
        if (r.state === "approved") {
          await this.dispatch(r.request);
          continue;
        }
        if (!r.card) continue;
        const card = this.deps.cards.get(r.card);
        if (card.state !== "answered" || !card.answer || (card.answeredAt ?? 0) + UNDO_MS > this.now()) continue;
        const by = `a person (Review card ${card.id})`;
        if (APPROVE.test(card.answer)) await this.approve(r.request, by);
        else if (DECLINE.test(card.answer)) this.decline(r.request, by);
      } catch (e) {
        console.error(`agentbox: GitHub action ${r.request}: ${(e as Error).message}`);
      }
    }
  }
}
