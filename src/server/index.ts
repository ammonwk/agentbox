/** The agentbox HTTP + WebSocket server.
 *
 * This process owns no agents. Every session runs in agentbox's tmux server
 * (or in some terminal of yours), so this server can be restarted at any time
 * and nothing it shows is lost: the fleet rebuilds the board from transcripts,
 * processes and tmux on its first tick.
 *
 * Three pushes over `/ws`, on three clocks:
 *   - `hot`: sessions, coalesced to one push per 250ms of changes.
 *   - `cold`: accounts, logins, repos, PRs, skills, settings — recomputed when
 *     something they depend on moves, pushed only when the result differs.
 *   - `metrics`: machine and per-session load, every two seconds while anyone
 *     is connected, never suppressed.
 * Plus `timeline` and `btw`, only to the socket watching that session.
 *
 * `/ws/term/:id` is a live terminal: a PTY running `tmux attach` on the
 * session, bytes both ways. Closing it detaches; the agent keeps running.
 */

import { githubProfile } from "../core/profile";
import { ensureBridge } from "../bridge/service";
import { ZodError } from "zod";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { DEFAULT_PORT, packageRoot, webDist } from "../core/paths";
import { behindHead, type Behind } from "../core/behind";
import { restartService } from "../core/restart";
import { sourceCheckout } from "../core/snapshot";
import { Fleet, FleetError, repoRootOf } from "../core/fleet";
import { ResourceCleanup } from "../core/cleanup";
import { sessionProject } from "../core/projects";
import * as tmux from "../core/tmux";
import { attentionOf, byAttention, retrying } from "../core/attention";
import { calibrate } from "../core/calibration";
import { usageInsights } from "../core/insights";
import { diffOf } from "../core/diff";
import { grepInWorker } from "../core/grep";
import { metricsEvents, metricsSnapshot, procDetail, setMetricsSource, setMetricsWatchers } from "../core/metrics";
import { reclaimWorktrees, scanWorktrees } from "../core/worktrees";
import { McpError, addServer, importServer, readRegistry, removeServer, setEnabled, updateServer } from "../core/mcp";
import { checkServer, discover, foundDefinition, publicFound, reachAll, viewOf } from "../core/mcp-reach";
import { lastNightlyReclaim, startNightlyReclaim } from "../core/nightly";
import { watchPwaDesktop, pwaInstalled } from "../core/pwa";
import { addSubscription, notifyBlocked, parseSubscription, pushPublicKey, pushSubscriptions, pushToAll, removeSubscription } from "../core/push";
import { demoteSkill, listSkills, promoteSkill, readSkillBody, skillRoots, writeSkillBody } from "../core/skills";
import { containedIn, looksLikeSkillFile, skillMdPath, skillRootDirs } from "./guard";
import { addRepo, deleteRepo, getDb, getRepoById, getSettings, listBtw, listRepos, listSchedules, mergeSettings, saveSettings, setRepoSetup, setRepoWorktreeDefault } from "../core/db";
import { parseSetup } from "../core/setup";
import { devServerPage, devServerStatus } from "../core/devserver";
import { serviceInstalled, installService, lingering } from "../core/service";
import { readUserIdentity } from "../core/user";
import { Scheduler, type ScheduleEdit } from "../core/scheduler";
import { parseSpec, Waits } from "../core/waits";
import { CARD_KINDS, Cards, moveCards } from "../core/cards";
import type { CardKind, CardState, McpServerInput, McpState } from "../core/types";
import { environOf, startedAtOf } from "../core/providers/procs";
import { branchHolders, openPrs, prWarnings, repoSlugOf, syncPrs } from "../core/prs";
import { claimPr, holderOf, movePrClaims, parsePrRef, prClaims, PrHeld, releasePr, transferPr } from "../core/prclaims";
import { repoCheckoutPath, repoFullNameOf } from "../core/git";
import { modelOptions } from "../core/models";
import { MAX_UPLOAD_BYTES, saveUpload, uploadFile } from "../core/uploads";
import { attribute } from "../core/senders";
import { agentTimeline, sessionWork } from "../core/work";
import { shownImage } from "../core/images";
import { recentScreenshots, screenshotImage } from "../core/screenshots";
import { DesktopError, backgroundTabs, openLocalFile, openUrlBehind } from "../core/desktop";
import { checkRequest } from "./csrf";
import { authenticatedSession } from "../core/session-authority";
import { PeerCheck, tailnetCert, tailnetSelf } from "./tailnet";
import { VoiceHub } from "../voice/hub";
import { deepgramKey, voiceConfig, voiceEnvPath } from "../voice/config";
import { transcribe } from "../voice/deepgram";
import type { Conversation } from "../voice/conversation";
import { HttpError, Router, fail, json, readBody } from "./router";
import { optionalString, parseAnswers, parseSettingsPatch, requireBoolean, requireString } from "./validate";
import { parseClientMessage } from "./protocol";
import { TurnIndex } from "../core/turns";
import { loadTurnState, saveTurnState } from "../core/readercache";
import { seekBottom, seekTurn, whereOnScreen, type SeekIO } from "../core/termseek";
import { builtEntry, fileResponse, notBuiltPage, resolveStatic } from "./static";
import { adapters } from "../core/providers";
import { sendAsAgent } from "../core/sendguard";
import { SendReceiptConflict, sendReceipt, submitWithReceipt } from "../core/send-receipts";
import { AccountError, AccountsService, owners } from "../core/accounts";
import { poolAgents } from "../subagents/record";
import { dependencies } from "../deps";
import { VERSION } from "../version";
import { RUNNING_REVISION } from "../revision";
import { CloudBridge } from "../core/cloud/bridge";
import { Superagents } from "../core/superagents";
import { WorkClaims } from "../core/workclaims";
import { claimRoutes } from "./claims";
import { cloudHttpError, cloudRoutes } from "./cloud";
import { superagentCaller, superagentRoutes } from "./superagents";
import { configurePeers, peerPorts } from "./peer";
import { prReady } from "../core/superagent/events";
import { githubRoutes, requirePersonForCard } from "./github";
import { GitHubActions } from "../core/github/actions";
import { GitHubBroker } from "../core/github/broker";
import { CloudConsent } from "../core/github/consent";
import { cloudConfig } from "../core/cloud/config";
import { TeamHost } from "../core/superagent/team";
import { teamRoutes } from "./team";
import { rowsVersion, type ChangeRow } from "../core/changes";
import type {
  AccountView,
  ColdState,
  Health,
  HotState,
  MetricsState,
  PrClaim,
  PrInfo,
  AccountProvider,
  ProviderId,
  Repo,
  RepoSetup,
  ServerMessage,
  SkillInfo,
} from "../core/types";

const PORT = Number(process.env.AGENTBOX_PORT ?? DEFAULT_PORT);
const HOST = process.env.AGENTBOX_HOST ?? "127.0.0.1";
const HOT_COALESCE_MS = 250;
const COLD_DEBOUNCE_MS = 500;
/** Longest a watch's request waits for its rows to change; under the server's 60s idle timeout. */
const CHANGES_WAIT_MS = 25_000;
const SLOW_REFRESH_MS = 60_000;
const BUILD_POLL_MS = 2_000;
const TIMELINE_PAGE = 200;
/** Opening prompts the new-session box can recall. */
const PROMPT_HISTORY = 1_000;
const PROVIDERS: ProviderId[] = ["claude", "codex", "devin", "omp", "opencode", "muse"];

// ------------------------------------------------------------- the pieces

/** The MCPs page: the list with how far each server reaches, what the
 *  agents' own configs define, and who still runs the set before the change. */
async function mcpState(): Promise<McpState> {
  const r = readRegistry();
  const { agents, reach } = await reachAll();
  const passed = new Set(agents.filter((a) => a.supported && a.installed).map((a) => a.provider));
  const sessions = fleet.sessions().flatMap((s) => {
    if (s.host !== "tmux" || !s.pid || !passed.has(s.provider)) return [];
    const raw = environOf(s.pid)?.get("AGENTBOX_MCP_STATE");
    let snapshot: { changedAt: number | null; given: string[]; kept: { name: string; same: boolean; enabled: boolean }[]; skipped?: { name: string; why: string }[]; error?: string | null } | null = null;
    try {
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.given) && parsed.given.every((name: unknown) => typeof name === "string") && Array.isArray(parsed.kept) && parsed.kept.every((k: { name?: unknown; enabled?: unknown } | null) => k && typeof k.name === "string" && typeof k.enabled === "boolean")) snapshot = parsed;
    } catch { /* an older launch has no usable snapshot */ }
    const skipped = Array.isArray(snapshot?.skipped) ? snapshot.skipped.filter((k) => k && typeof k.name === "string" && typeof k.why === "string") : [];
    const error = typeof snapshot?.error === "string" ? snapshot.error : null;
    return [{ id: s.id, title: s.label || s.title || s.id, provider: s.provider, changedAt: snapshot?.changedAt ?? null, given: snapshot?.given ?? [], kept: snapshot?.kept ?? [], known: snapshot !== null, skipped, error }];
  });
  const stale = r.changedAt === null ? [] : fleet.sessions().flatMap((s) => {
    if (s.host !== "tmux" || !s.pid || !passed.has(s.provider)) return [];
    const since = startedAtOf(s.pid);
    return since !== null && since < r.changedAt! ? [{ id: s.id, title: s.label || s.title || s.id, provider: s.provider, since }] : [];
  });
  let found: McpState["found"] = [];
  let discoveryError: string | null = null;
  try { found = discover().map(publicFound); } catch (e) { discoveryError = (e as Error).message; }
  return {
    servers: r.servers.map((s) => viewOf(s, reach.get(s.name) ?? [])),
    found,
    discoveryError,
    agents,
    changedAt: r.changedAt,
    sessions,
    stale,
  };
}

export const accounts = new AccountsService();
export const fleet = new Fleet({
  adapters: adapters(),
  runtime: tmux,
  usage: {
    usageOf: (id) => accounts.usage.get(id),
    authOf: (id) => accounts.authState(id),
    ingestRollout: (id, reading) => void accounts.ingestRollout(id, reading),
  },
  poolAgents: () => poolAgents(),
});
setMetricsSource(() => fleet.sessions());
export const cleanup = new ResourceCleanup(fleet, () => { scheduleCold(); scheduleHot(); });
fleet.activityAllowed = id => cleanup.allows(id);
/** Sessions to start later; on the board and in Settings, so cold state. */
export const scheduler = new Scheduler(fleet, () => scheduleCold());
/** What sessions wait on, and how each is told (src/core/waits.ts). */
export const waits = new Waits(fleet);
/** Programs that run on agentbox's API, shown on the Agents page (src/core/superagents.ts). */
configurePeers({ server: PORT, sessionAbove: (pid) => fleet.callerOf(pid) });
export const superagents = new Superagents(fleet, `http://127.0.0.1:${PORT}`, () => scheduleHot());
/** Who has which work, by source: renewed on the scheduler's tick, moved on a handover (src/core/workclaims.ts). */
export const workClaims = new WorkClaims(fleet);
fleet.onHandOver = (from, to) => workClaims.handOver(from, to);
// A session's claims are kept where the superagent it acts for keeps its own.
workClaims.ownerOf = (session) => superagents.ownerOf(session, { authority: true });
scheduler.onTick(() => workClaims.tick());
/** This machine's link to the agentbox cloud, when one is set up (docs/cloud.md). */
export const cloud = new CloudBridge(fleet, VERSION);
function cardId(raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) throw new HttpError(400, "a card's id is a number");
  return Number(raw);
}

/** One push for a batch of new decisions, never for what merely happened. */
export const cards = new Cards(fleet, () => scheduleCold(), (batch) => {
  if (pushSubscriptions().length === 0) return;
  const [first] = batch;
  void pushToAll({
    title: batch.length === 1 ? "A decision for you" : `${batch.length} decisions for you`,
    body: batch.length === 1 ? first!.title : `${first!.title}, and ${batch.length - 1} more`,
    url: "/#/review",
    tag: "cards",
  }).then((r) => {
    for (const f of r.failed) console.error(`agentbox: push for cards failed — ${f}`);
  });
});
const turnIndex = new TurnIndex(fleet, {
  load: (id) => loadTurnState(fleet.get(id).provider, id),
  save: (id, state) => saveTurnState(fleet.get(id).provider, id, state),
});
/** The newest seek per session; an older one still paging sees it and stops. */
const seeks = new Map<string, number>();

/** The terminal of a session whose TUI pages with PageUp/PageDown (src/core/termseek.ts). */
function seekable(id: string): { io: SeekIO; claude: boolean } {
  const s = fleet.get(id);
  if (s.provider !== "claude" && s.provider !== "codex") {
    throw new HttpError(409, `The ${s.provider} terminal cannot be scrolled from here.`);
  }
  fleet.tmuxOf(id);
  const io: SeekIO = { capture: () => fleet.screen(id), keys: (k) => fleet.keys(id, k), sleep: (ms) => Bun.sleep(ms) };
  return { io, claude: s.provider === "claude" };
}
/** A held-to-talk message: an hour of phone audio is well under this. */
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

/** Hands-free mode (src/voice); made once the fleet is up. */
let voice: VoiceHub;

// --------------------------------------------------------------- state

/** The sessions on the board — with the closed ones too unless `open`, and
 *  the closed ones you pinned or bookmarked either way, since the list keeps
 *  those at hand — for `GET /api/state` and the sockets' frames. */
/** A session's `agentProject`, only when its superagent pins one. */
const withProject = (p: string | undefined) => (p === undefined ? {} : { agentProject: p });

function hotState(open = false): HotState {
  let closedStamp = 0;
  const owner = superagents.ownership();
  const project = superagents.projectBinding(owner);
  const sessions = fleet
    .sessions()
    .filter((s) => {
      if (s.status !== "closed") return true;
      closedStamp += 1 + (s.closedAt ?? 0);
      return !open || s.pinOrder !== null || s.bookmarkedAt !== null;
    })
    .map((s) => ({ ...s, paused: !!s.pid && !cleanup.allows(s.id), agentOwner: owner(s.id), ...withProject(project(s.id)), attention: attentionOf(s, fleet.blockedReason(s.id)) }))
    .sort(byAttention);
  return { sessions, serverTime: Date.now(), closedStamp };
}

/**
 * What the last frame to the sockets said of each open session, by id. A
 * frame carries only what differs from it; a socket just connected is sent
 * the board whole and then the same frames as everyone, which, each taken
 * against the last broadcast rather than its own, bring it up to date too.
 */
let sentOpen = new Map<string, string>();
let sentClosedStamp = -1;

function hotDelta(): Extract<ServerMessage, { type: "hotDelta" }> | null {
  const { sessions, serverTime, closedStamp = 0 } = hotState(true);
  const next = new Map<string, string>();
  const changed: HotState["sessions"] = [];
  for (const s of sessions) {
    const fp = JSON.stringify(s);
    next.set(s.id, fp);
    if (sentOpen.get(s.id) !== fp) changed.push(s);
  }
  const gone = [...sentOpen.keys()].filter((id) => !next.has(id));
  sentOpen = next;
  if (changed.length === 0 && gone.length === 0 && closedStamp === sentClosedStamp) return null;
  sentClosedStamp = closedStamp;
  return { type: "hotDelta", sessions: changed, gone, serverTime, closedStamp };
}

/** Slow-changing inputs to cold state, refreshed off the request path. */
const slow = {
  prs: [] as PrInfo[],
  skills: [] as SkillInfo[],
  skillWarnings: [] as string[],
  tmuxMissing: false,
  providers: [] as ColdState["providers"],
  /** Probes that spawn a process; never on the cold path itself. */
  serviceInstalled: null as boolean | null,
  lingering: null as boolean | null,
  pwaInstalled: null as boolean | null,
  depsOk: false,
  ghReady: false,
};

/** Checkouts on this machine; each may carry its own `.claude/skills`. */
const localRepoDirs = (repos: Repo[]): string[] => repos.filter((r) => r.kind === "local").map((r) => r.ref);

async function refreshSlow(): Promise<void> {
  const repos = listRepos();
  const skills = listSkills(skillRoots(localRepoDirs(repos)));
  slow.skills = skills.skills;
  slow.skillWarnings = skills.warnings;
  await detectProviders();
  // From the database: sessions come and go, and which PR is whose with them.
  slow.prs = openPrs(fleet.sessions());
  slow.tmuxMissing = !tmux.tmuxVersion();
  // Each of these runs a program; none belongs on the cold path.
  const deps = dependencies(false);
  slow.depsOk = deps.tmux.state === "ok" && deps.git.state === "ok";
  slow.ghReady = deps.gh.state === "ok";
  slow.serviceInstalled = serviceInstalled();
  slow.lingering = lingering();
  slow.pwaInstalled = pwaInstalled();
  scheduleCold();
}

/** The PR copy (src/core/prs.ts) syncs on its own clock, so a slow GitHub
 *  never holds up skills or providers. */
async function refreshPrs(): Promise<void> {
  const changed = await syncPrs().catch((e: unknown) => {
    console.error("agentbox: pull requests:", e);
    return false;
  });
  if (!changed) return;
  slow.prs = openPrs(fleet.sessions());
  scheduleCold();
}

function warnings(): string[] {
  return [
    ...(slow.tmuxMissing ? ["tmux is not installed — agentbox runs every session in tmux, so nothing can be started."] : []),
    ...slow.skillWarnings,
    ...prWarnings(),
  ];
}

async function detectProviders(): Promise<void> {
  slow.providers = await Promise.all(
    PROVIDERS.map(async (id) => {
      const a = fleet.providers().find((p) => p.id === id);
      const d = a ? await a.detect().catch(() => ({ installed: false, version: null })) : { installed: false, version: null };
      return { id, installed: d.installed, version: d.version, efforts: [...(a?.efforts ?? [])] };
    }),
  );
}

function accountViews(): AccountView[] {
  const claims = fleet.claims();
  const placements = new Map<string, ReturnType<Fleet["placement"]>>();
  const homes = accounts.list();
  const owner = owners(homes);
  return homes.filter((a) => owner.get(a.id) === a.id).map((a) => {
    let p = placements.get(a.provider);
    if (!p) {
      try {
        p = fleet.placement(a.provider);
      } catch {
        p = undefined;
      }
      if (p) placements.set(a.provider, p);
    }
    return {
      ...a,
      // Lapsed claims weigh nothing; listing every session of the last few
      // days under its account would bury the handful that do.
      claims: (claims.get(a.id) ?? []).filter((c) => !c.lapsed),
      placement: p?.candidates.find((c) => c.accountId === a.id) ?? null,
      alsoAt: homes.filter((h) => h.id !== a.id && owner.get(h.id) === a.id).map((h) => ({ id: h.id, home: h.home, isDefault: h.isDefault })),
    };
  });
}

/** Who has which pull request, now (src/core/prclaims.ts). */
function prClaimsNow(): PrClaim[] {
  const sessions = fleet.sessions();
  return prClaims(sessions, branchHolders(sessions));
}

/** The PR a caller names, a bare number being one of the repo it called
 *  from, else of the repo its session works in or names most. */
function prNamed(b: Record<string, unknown>, sessionId: string | null): { repo: string; number: number } {
  const s = sessionId ? fleet.sessions().find((x) => x.id === sessionId) : undefined;
  const cwd = optionalString(b, "cwd");
  try {
    return parsePrRef(requireString(b, "pr"), (cwd ? repoFullNameOf(cwd) : null) ?? (s?.repoRoot ? repoSlugOf(s.repoRoot) : null) ?? s?.prRepo ?? null);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
}

/** The session a request speaks for: the one it names, else the one it was made from inside. */
function speaker(b: Record<string, unknown>): string | null {
  const callerPid = typeof b.callerPid === "number" && Number.isInteger(b.callerPid) && b.callerPid > 1 ? b.callerPid : null;
  return (typeof b.session === "string" && /^[\w-]{1,64}$/.test(b.session) ? b.session : null) ?? (callerPid ? fleet.callerOf(callerPid) : null);
}

/** PRs a session is being started on, until it exists to hold them. */
const startingOn = new Set<string>();

/** The registered repos with the canonical root their sessions' `repoRoot`
 *  is compared to (`sessionProject`): a GitHub clone's is under the repo
 *  root, and a symlinked local one's is its real path. */
const reposWithRoots = (): Repo[] => listRepos().map((r) => ({ ...r, checkoutRoot: repoRootOf(repoCheckoutPath(r)) ?? repoCheckoutPath(r) }));

function coldState(): ColdState {
  const views = accountViews();
  const prClaims = prClaimsNow();
  return {
    accounts: views,
    cleanup: cleanup.state(),
    logins: accounts.loginFlows(),
    repos: reposWithRoots(),
    prs: slow.prs.map((p) => ({ ...p, owner: holderOf(prClaims, p.repo, p.number)?.sessionId ?? null })),
    prClaims,
    skills: slow.skills,
    settings: getSettings(),
    providers: slow.providers,
    warnings: warnings(),
    schedules: listSchedules(),
    cards: cards.shown(),
    onboarding: {
      identity: readUserIdentity(),
      depsOk: slow.depsOk,
      ghReady: slow.ghReady,
      accountsReady: views.some((a) => a.auth.state === "ok"),
      voiceReady: !("missing" in voiceConfig()),
      serviceInstalled: slow.serviceInstalled,
      lingering: slow.lingering,
      pwaInstalled: slow.pwaInstalled,
    },
  };
}

// ------------------------------------------------------------- websocket

type SocketData =
  | { kind: "app"; watching: string | null; cursor: string | null; busy: boolean; again: boolean }
  | { kind: "term"; sessionId: string; cols: number; rows: number; proc?: ReturnType<typeof Bun.spawn> }
  | { kind: "voice"; convId: string; conv?: Conversation };
type Socket = ServerWebSocket<SocketData>;

const clients = new Set<Socket>();

function dropClient(ws: Socket): void {
  if (!clients.delete(ws)) return;
  setMetricsWatchers(clients.size);
}

function send(ws: Socket, msg: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) {
    dropClient(ws);
    return;
  }
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    dropClient(ws);
  }
}

function broadcast(msg: ServerMessage): void {
  for (const ws of [...clients]) send(ws, msg);
}

/**
 * `GET /api/state`'s body, built once for everyone who asks before the board
 * or the cold state next moves, and at most a second old. Every
 * `agentbox watch` polled it every 2s; eight of them were rebuilding and
 * serializing 3 MB four times a second.
 */
let stateBody: { at: number; open: boolean; body: string } | null = null;
const STATE_BODY_MS = 1_000;
function stateResponse(open: boolean): Response {
  const now = Date.now();
  if (!stateBody || stateBody.open !== open || now - stateBody.at > STATE_BODY_MS) {
    stateBody = { at: now, open, body: JSON.stringify({ ok: true, data: { ...hotState(open), ...coldState() }, error: null }) };
  }
  return new Response(stateBody.body, { headers: { "content-type": "application/json" } });
}

function changeRows(only: Set<string> | null): ChangeRow[] {
  return fleet
    .sessions()
    .filter((s) => !only || only.has(s.id))
    .map((s) => ({
      id: s.id,
      // One agentbox will retry has not stopped on you.
      status: retrying(s) ? "running" : s.status,
      label: s.label,
      title: s.title,
      firstPrompt: s.firstPrompt?.split("\n")[0]?.slice(0, 80) ?? null,
      lastMessage: s.lastMessage,
      turnError: s.turnError,
      reason: attentionOf(s, fleet.blockedReason(s.id)).reason,
    }));
}

/** Requests waiting for the board to change; `scheduleHot` wakes them all. */
const changeWaiters = new Set<() => void>();
function boardChange(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      changeWaiters.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    changeWaiters.add(wake);
  });
}

let hotTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleHot(): void {
  stateBody = null;
  for (const wake of [...changeWaiters]) wake();
  if (hotTimer) return;
  hotTimer = setTimeout(() => {
    hotTimer = null;
    if (clients.size === 0) return;
    const frame = hotDelta();
    if (frame) broadcast(frame);
  }, HOT_COALESCE_MS);
}

/** What the last cold frame to the sockets said of each part, as JSON: a
 *  placement's forecast moves every pass, and it alone used to resend the
 *  whole of cold state (the PRs, the skills) every two seconds. */
let sentCold = new Map<string, string>();
let coldTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleCold(): void {
  stateBody = null;
  if (coldTimer) return;
  coldTimer = setTimeout(() => {
    coldTimer = null;
    if (clients.size === 0) return;
    const state = coldState();
    const changed: Partial<ColdState> = {};
    for (const [key, value] of Object.entries(state) as [keyof ColdState, unknown][]) {
      const json = JSON.stringify(value);
      if (sentCold.get(key) === json) continue;
      sentCold.set(key, json);
      (changed as Record<string, unknown>)[key] = value;
    }
    if (Object.keys(changed).length > 0) broadcast({ type: "coldDelta", state: changed });
  }, COLD_DEBOUNCE_MS);
}

/**
 * Bring one watching socket up to date. First call sends the newest page with
 * `reset`; later calls send what was appended since the socket's cursor.
 * Serialised per socket — two overlapping reads would send the same events
 * twice and leave the cursor at whichever finished last.
 */
async function pumpTimeline(ws: Socket): Promise<void> {
  const d = ws.data;
  if (d.kind !== "app" || !d.watching) return;
  if (d.busy) {
    d.again = true;
    return;
  }
  d.busy = true;
  try {
    do {
      d.again = false;
      const id: string | null = d.watching;
      if (!id || !fleet.hasTranscript(id)) {
        if (id && d.cursor === null) send(ws, { type: "timeline", sessionId: id, events: [], cursor: "", reset: true });
        break;
      }
      if (d.cursor === null || d.cursor === "") {
        const page = await fleet.timeline(id, null, TIMELINE_PAGE);
        if (d.watching !== id) continue;
        d.cursor = page.cursor;
        send(ws, { type: "timeline", sessionId: id, events: attribute(id, page.events, superagents.senders), cursor: page.cursor, reset: true, before: page.before });
      } else {
        const next = await fleet.since(id, d.cursor);
        if (d.watching !== id) continue;
        d.cursor = next.cursor;
        if (next.events.length > 0 || next.reset) {
          send(ws, { type: "timeline", sessionId: id, events: attribute(id, next.events, superagents.senders), cursor: next.cursor, reset: next.reset });
        }
      }
    } while (d.again);
  } catch (e) {
    send(ws, { type: "error", message: `timeline: ${(e as Error).message}` });
  } finally {
    d.busy = false;
  }
}

function onTranscript(sessionId: string): void {
  for (const ws of clients) {
    if (ws.data.kind === "app" && ws.data.watching === sessionId) void pumpTimeline(ws);
  }
}

/** The watched session's side questions (Claude's /btw), whole, on watch and on every change. */
function onBtw(sessionId: string): void {
  for (const ws of clients) {
    if (ws.data.kind === "app" && ws.data.watching === sessionId) send(ws, { type: "btw", sessionId, items: listBtw(sessionId) });
  }
}

function handleAppMessage(ws: Socket, raw: string | Buffer): void {
  const parsed = parseClientMessage(raw);
  if (!parsed.ok) {
    send(ws, { type: "error", message: parsed.error });
    return;
  }
  const msg = parsed.message;
  if (msg.type === "ping" || ws.data.kind !== "app") return;
  ws.data.watching = msg.sessionId;
  ws.data.cursor = null;
  // Before the first pass no transcript is known; `welcome` pumps it after.
  if (!booted) return;
  if (msg.sessionId) send(ws, { type: "btw", sessionId: msg.sessionId, items: listBtw(msg.sessionId) });
  void pumpTimeline(ws);
}

// ------------------------------------------------------------- terminal

function openTerminal(ws: Socket): void {
  const d = ws.data;
  if (d.kind !== "term") return;
  let name: string;
  try {
    name = fleet.tmuxOf(d.sessionId);
  } catch (e) {
    ws.send(`\r\n\x1b[2m${(e as Error).message}\x1b[0m\r\n`);
    ws.close(4000, "not in tmux");
    return;
  }
  // TMUX set in our environment (a server started from inside tmux) makes
  // `tmux attach` refuse to nest; the attach is to a different server anyway.
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>;
  delete env.TMUX;
  delete env.TMUX_PANE;
  d.proc = Bun.spawn(tmux.attachArgv(name), {
    env,
    terminal: {
      cols: d.cols,
      rows: d.rows,
      data(_term: unknown, bytes: Uint8Array) {
        if (ws.readyState === WebSocket.OPEN) ws.sendBinary(bytes);
      },
    },
  } as Parameters<typeof Bun.spawn>[1]);
  void d.proc.exited.then(() => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, "detached");
  });
}

/** When you last typed into each session's terminal: a panel that opens
 *  there at once is yours, and is not pushed (`notifyBlocked`). */
const typedAt = new Map<string, number>();
/** What xterm sends by itself: a focus change, or its answer to a query. */
const TERM_REPORT = /^\x1b\[(?:[IO]|[?>]?[\d;]*[cnR])$/;

function termOf(d: SocketData): { write(s: string): void; resize(c: number, r: number): void; close(): void } | null {
  if (d.kind !== "term" || !d.proc) return null;
  return (d.proc as unknown as { terminal?: { write(s: string): void; resize(c: number, r: number): void; close(): void } }).terminal ?? null;
}

function handleTermMessage(ws: Socket, raw: string | Buffer): void {
  const t = termOf(ws.data);
  if (!t) return;
  let msg: unknown;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    return;
  }
  const m = msg as { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
  if (m.type === "input" && typeof m.data === "string") {
    if (ws.data.kind === "term" && !fleet.activityAllowed(ws.data.sessionId)) return;
    t.write(m.data);
    if (ws.data.kind === "term" && !TERM_REPORT.test(m.data)) typedAt.set(ws.data.sessionId, Date.now());
  } else if (m.type === "resize" && typeof m.cols === "number" && typeof m.rows === "number") {
    const cols = Math.max(20, Math.min(500, Math.floor(m.cols)));
    const rows = Math.max(5, Math.min(200, Math.floor(m.rows)));
    t.resize(cols, rows);
  }
}

function closeTerminal(ws: Socket): void {
  const d = ws.data;
  if (d.kind !== "term") return;
  termOf(d)?.close();
  d.proc?.kill();
}

// --------------------------------------------------------------- routes

function mapError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  // A schema refusal is the request's shape, not the server's fault.
  if (e instanceof ZodError) return new HttpError(400, e.message);
  const c = cloudHttpError(e);
  if (c) return c;
  if (e instanceof DesktopError) return new HttpError(e.status, e.message);
  if (e instanceof FleetError || e instanceof AccountError || e instanceof McpError) return new HttpError(e.status, e.message);
  return new HttpError(500, e instanceof Error ? e.message : String(e));
}

const provider = (v: unknown): ProviderId => {
  if (typeof v !== "string" || !PROVIDERS.includes(v as ProviderId)) {
    throw new HttpError(400, `provider must be one of ${PROVIDERS.join(", ")}`);
  }
  return v as ProviderId;
};

/** A provider that holds accounts: opencode runs on omp's. */
const accountProvider = (v: unknown): AccountProvider => {
  const p = provider(v);
  if (p === "opencode") throw new HttpError(400, "opencode has no accounts of its own: it runs on the OpenCode Go accounts, as omp does");
  return p;
};

/** Requests from a browser on this machine, whose desktop is the server's. */
const fromThisMachine = new WeakSet<Request>();

const router = new Router(mapError)
  .add("GET", "/api/state", ({ url }) => stateResponse(url.searchParams.get("open") === "1"))
  .add("GET", "/api/prompts", () => json(fleet.openingPrompts(PROMPT_HISTORY)))
  .add("GET", "/api/voice", () => json(voice.status()))
  // The Update button, when the checkout has newer commits: the service
  // restarts itself onto them. Started after the answer has gone out.
  .add("POST", "/api/server/restart", () => {
    if (!serverBehind) throw new HttpError(409, "the server already runs the checkout's newest commit");
    setTimeout(() => {
      if (!restartService()) console.error("agentbox: restart asked, but no agentbox service is installed");
    }, 250);
    return json({ restarting: true, to: serverBehind.head });
  })
  .add("GET", "/api/health", async ({ url }) => {
    // Re-check is someone who just installed or logged into something.
    const refresh = url.searchParams.get("refresh") === "1";
    if (refresh) {
      await detectProviders();
      scheduleCold();
    }
    const health: Health = { version: VERSION, tmux: tmux.tmuxVersion(), providers: slow.providers, deps: dependencies(refresh), revision: RUNNING_REVISION };
    if (!booted) health.starting = startupProgress();
    return json(health);
  })

  // ---- sessions
  .add("GET", "/api/cleanup", () => json(cleanup.state()))
  .add("POST", "/api/cleanup", async () => {
    await fleet.ready;
    return json(await cleanup.start());
  })
  .add("POST", "/api/cleanup/resume", async () => json(await cleanup.resume()))
  .add("POST", "/api/placement", async ({ req }) => {
    const b = await readBody(req);
    return json(fleet.placement(provider(b.provider), optionalString(b, "model") ?? null, optionalString(b, "accountId") ?? null, optionalString(b, "effort") ?? null));
  })
  .add("POST", "/api/sessions", async ({ req }) => {
    const b = await readBody(req);
    // Started to work a pull request: it has it from its first moment, or
    // does not start, so two are never sent to the same one.
    const claim = b.claim !== undefined ? prNamed({ pr: b.claim, cwd: b.cwd }, null) : null;
    const key = claim ? `${claim.repo.toLowerCase()}#${claim.number}` : "";
    const opener = authenticatedSession(req);
    // A parent gives a superagent's authority (claims, GitHub actions) only
    // to a session its starter proves it acts for: that superagent's program,
    // the parent itself, or another session of the same superagent.
    const callerPidOf = typeof b.callerPid === "number" && Number.isInteger(b.callerPid) && b.callerPid > 1 ? b.callerPid : undefined;
    const parentId = optionalString(b, "parent") ?? (callerPidOf ? fleet.callerOf(callerPidOf) : null);
    const owner = parentId ? superagents.ownerOf(parentId, { authority: true }) : null;
    const program = superagentCaller(req, superagents);
    const parentProven = !owner || (program ? program === owner : !!opener && (opener === parentId || superagents.ownerOf(opener, { authority: true }) === owner));
    if (claim) {
      const held = holderOf(prClaimsNow(), claim.repo, claim.number);
      if (held) throw new HttpError(409, new PrHeld(held, fleet.sessions().find((s) => s.id === held.sessionId)).message.replace(/^not claimed/, "not started"));
      if (startingOn.has(key)) throw new HttpError(409, `not started: another session is being started on ${claim.repo}#${claim.number} this moment`);
      startingOn.add(key);
    }
    try {
      const out = await fleet.spawn({
        // "auto": the provider with room (src/core/providers/auto.ts); the answer's `choice` says why.
        provider: b.provider === "auto" ? "auto" : provider(b.provider),
        previous: b.previous === undefined ? undefined : provider(b.previous),
        writer: b.writer === true,
        readOnly: b.readOnly === true,
        notify: b.notify === false ? false : undefined,
        cwd: optionalString(b, "cwd"),
        repoId: optionalString(b, "repoId"),
        worktree: b.worktree === true,
        branch: optionalString(b, "branch"),
        pr: typeof b.pr === "number" && Number.isInteger(b.pr) && b.pr > 0 ? b.pr : undefined,
        devServer: b.devServer === true,
        prompt: typeof b.prompt === "string" ? b.prompt : undefined,
        model: optionalString(b, "model"),
        effort: optionalString(b, "effort"),
        accountId: optionalString(b, "accountId") ?? null,
        callerPid: typeof b.callerPid === "number" && Number.isInteger(b.callerPid) && b.callerPid > 1 ? b.callerPid : undefined,
        parent: optionalString(b, "parent"),
        parentProven,
        // Only the caller's capability says which session wrote the prompt.
        ...(opener ? { opener: { from: opener, agent: superagents.ownerOf(opener) } } : {}),
      });
      if (claim) claimPr([], fleet.sessions(), claim.repo, claim.number, out.session.id, Date.now());
      scheduleHot();
      scheduleCold();
      return json(out, 201);
    } catch (e) {
      // A refusal carries the placement, so the dialog can show why.
      if (e instanceof FleetError && e.placement) {
        return new Response(JSON.stringify({ ok: false, data: { placement: e.placement }, error: e.message }), {
          status: e.status,
          headers: { "content-type": "application/json" },
        });
      }
      throw e;
    } finally {
      startingOn.delete(key);
    }
  })

  // ---- a session's dev server (src/core/devserver.ts)
  .add("GET", "/api/sessions/:id/dev", async ({ params }) => json(await devServerStatus(params.id!)))
  .add("GET", "/api/sessions/:id/dev/open", ({ params }) =>
    new Response(devServerPage(params.id!), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }),
  )

  // ---- who has which pull request
  // The session a command runs in, for the CLI to tell "you" from another:
  // AGENTBOX_SESSION when it reached the command, else the walk up from it.
  .add("POST", "/api/whoami", async ({ req }) => json({ id: speaker(await readBody(req)) }))
  .add("GET", "/api/prs/claims", () => json(prClaimsNow()))
  // Its owner found it ready: each superagent that takes the pr.ready event gets it once per head.
  .add("POST", "/api/prs/ready", async ({ req }) => {
    const b = await readBody(req);
    const owner = authenticatedSession(req);
    if (!owner) throw new HttpError(403, "the PR's owner session reports it ready: run this from inside it");
    const pr = prNamed(b, owner);
    const out = await prReady(superagents, fleet, owner, { ...pr, head: requireString(b, "head") });
    scheduleHot();
    return json(out);
  })
  .add("POST", "/api/prs/who", async ({ req }) => {
    const b = await readBody(req);
    const pr = prNamed(b, speaker(b));
    return json({ ...pr, claim: holderOf(prClaimsNow(), pr.repo, pr.number) });
  })
  .add("POST", "/api/prs/claim", async ({ req }) => {
    const b = await readBody(req);
    const who = speaker(b);
    if (!who) throw new HttpError(400, "a session claims a pull request: run this from inside one, or name it with --for <session id>");
    const sessions = fleet.sessions();
    if (!sessions.some((s) => s.id === who)) throw new HttpError(404, `no session ${who}`);
    const pr = prNamed(b, who);
    try {
      const claims = prClaimsNow();
      const before = holderOf(claims, pr.repo, pr.number);
      const c = claimPr(claims, sessions, pr.repo, pr.number, who, Date.now());
      scheduleCold();
      return json({ ...c, already: before?.sessionId === who });
    } catch (e) {
      if (e instanceof PrHeld) throw new HttpError(409, e.message);
      throw e;
    }
  })
  .add("POST", "/api/prs/transfer", async ({ req }) => {
    const b = await readBody(req);
    // The caller's session capability (src/core/session-authority.ts), not a
    // process ID or --for. It keeps a session from handing over another's PR
    // by mistake; a process of the same user that sets out to can read it.
    const actor = authenticatedSession(req);
    if (!actor) throw new HttpError(403, "run pr transfer inside the session that currently holds the PR");
    const expected = requireString(b, "expected");
    const to = requireString(b, "to");
    const pr = prNamed(b, actor);
    try {
      const claim = transferPr(prClaimsNow(), fleet.sessions(), pr.repo, pr.number, actor, expected, to, Date.now());
      scheduleCold();
      return json(claim);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  })
  .add("POST", "/api/prs/release", async ({ req }) => {
    const b = await readBody(req);
    const who = speaker(b);
    if (!who) throw new HttpError(400, "a session releases what it claimed: run this from inside one, or name it with --for <session id>");
    const named = b.pr !== undefined ? prNamed(b, who) : null;
    const branches = named ? [] : prClaimsNow().filter((c) => c.sessionId === who && c.how === "branch");
    const released = getDb().transaction(() => {
      for (const pr of branches) releasePr(who, pr);
      return releasePr(who, named) + branches.length;
    })();
    scheduleCold();
    return json({ released });
  })
  .add("PATCH", "/api/sessions/:id", async ({ req, params }) => {
    const b = await readBody(req);
    const label = b.label === null ? null : typeof b.label === "string" ? b.label : undefined;
    const parent = b.parent === null ? null : typeof b.parent === "string" ? b.parent : undefined;
    const pinOrder = b.pinOrder === null ? null : typeof b.pinOrder === "number" && Number.isFinite(b.pinOrder) ? b.pinOrder : undefined;
    const bookmarked = typeof b.bookmarked === "boolean" ? b.bookmarked : undefined;
    const s = await fleet.patch(params.id!, { label, parent, pinOrder, bookmarked });
    scheduleHot();
    scheduleCold();
    return json(s);
  })
  .add("POST", "/api/sessions/:id/send", async ({ req, params }) => {
    const b = await readBody(req);
    const text = requireString(b, "text");
    // The sending session's id goes in the mark: the timeline shows who wrote
    // it, and the reader knows who to answer. The sender says (`AGENTBOX_SESSION`)
    // when its environment has it; otherwise it is found above the caller's
    // process, as a spawn's parent is.
    const callerPid = typeof b.callerPid === "number" && Number.isInteger(b.callerPid) && b.callerPid > 1 ? b.callerPid : null;
    const authenticated = authenticatedSession(req);
    if (b.from === "agent" && !authenticated) throw new HttpError(403, "agent messages require the sending session's capability");
    const fromSession = authenticated ??
      (typeof b.fromSession === "string" && /^[\w-]{1,64}$/.test(b.fromSession) ? b.fromSession : null) ??
      (b.from === "agent" && callerPid ? fleet.callerOf(callerPid) : null);
    // An agent's message is refused, before anything is typed or resumed, when
    // it would wake a cold or stopped session unasked or is one too many, and
    // one to a session another has taken over goes to that one
    // (src/core/sendguard.ts). Yours never is, and goes where you send it.
    if (b.from === "agent") {
      // Only the sending session's capability proves who wrote it; a named or
      // inferred session is recorded, unproven.
      const sent = await sendAsAgent(fleet, params.id!, text, { from: fromSession, wake: b.wake === true, verified: !!authenticated, agent: authenticated ? superagents.ownerOf(authenticated) : null }, Date.now());
      if ("refused" in sent) throw new HttpError(409, sent.refused);
      return json(sent);
    }
    if (b.sendId !== undefined) {
      const id = requireString(b, "sendId");
      if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(400, "invalid send ID");
      try {
        return json(await submitWithReceipt(params.id!, id, "send", text, (attempt) => fleet.send(params.id!, text, attempt)));
      } catch (e) {
        if (e instanceof SendReceiptConflict) throw new HttpError(409, e.message);
        throw e;
      }
    }
    await fleet.send(params.id!, text);
    return json(null);
  })
  .add("POST", "/api/sessions/:id/submissions", async ({ req, params }) => {
    const b = await readBody(req);
    const id = requireString(b, "sendId");
    if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(400, "invalid send ID");
    const kind = requireString(b, "kind");
    if (!["send", "resume", "btw"].includes(kind)) throw new HttpError(400, "invalid submission kind");
    const text = typeof b.text === "string" ? b.text : requireString(b, "text");
    if (kind !== "resume" && !text.trim()) throw new HttpError(400, "the message is empty");
    // A person's message in an agent's Chat ends a running turn first, as
    // Escape by hand would (`Fleet.endTurnFor`); a session's never does.
    const interrupt = kind === "send" && b.interrupt === true && !authenticatedSession(req);
    try {
      const receipt = await submitWithReceipt(params.id!, id, kind, text, (attempt) => {
        if (kind === "send") return fleet.send(params.id!, text, attempt, false, interrupt);
        if (kind === "resume") return fleet.resume(params.id!, text || undefined, attempt);
        return fleet.askBtw(params.id!, text, attempt);
      });
      scheduleHot();
      return json(receipt);
    } catch (e) {
      if (e instanceof SendReceiptConflict) throw new HttpError(409, e.message);
      throw e;
    }
  })
  .add("GET", "/api/sessions/:id/submissions/:sendId", ({ params }) => json(sendReceipt(params.id!, params.sendId!)))
  .add("POST", "/api/sessions/:id/keys", async ({ req, params }) => {
    const b = await readBody(req);
    if (!Array.isArray(b.keys) || !b.keys.every((k) => typeof k === "string" && k.length > 0 && k.length < 64)) {
      throw new HttpError(400, "keys must be a list of tmux key names");
    }
    fleet.keys(params.id!, b.keys as string[]);
    return json(null);
  })
  .add("POST", "/api/sessions/:id/answer", async ({ req, params }) => {
    const b = await readBody(req);
    const question = requireString(b, "question");
    await fleet.answer(params.id!, question, parseAnswers(b.answers));
    scheduleHot();
    return json(null);
  })
  .add("POST", "/api/sessions/:id/btw", async ({ req, params }) => {
    const b = await readBody(req);
    return json(fleet.askBtw(params.id!, requireString(b, "question")), 201);
  })
  .add("POST", "/api/sessions/:id/btw/:row/dismiss", ({ params }) => {
    const row = Number(params.row);
    if (!Number.isInteger(row) || row <= 0) throw new HttpError(400, "the side question's row must be a positive integer");
    fleet.dismissBtw(params.id!, row);
    return json(null);
  })
  .add("POST", "/api/sessions/:id/interrupt", ({ params }) => {
    fleet.interrupt(params.id!);
    return json(null);
  })
  .add("POST", "/api/sessions/:id/resume", async ({ req, params }) => {
    const b = await readBody(req);
    const s = await fleet.resume(params.id!, typeof b.prompt === "string" ? b.prompt : undefined);
    scheduleHot();
    return json(s);
  })
  .add("POST", "/api/sessions/:id/move", async ({ req, params }) => {
    const b = await readBody(req);
    const s = await fleet.moveAndContinue(params.id!, {
      accountId: optionalString(b, "accountId") ?? null,
      prompt: typeof b.prompt === "string" && b.prompt.trim() ? b.prompt : undefined,
      must: b.must === true,
      force: b.force === true,
    });
    scheduleHot();
    scheduleCold();
    return json(s);
  })
  .add("GET", "/api/screenshots", ({req}) => {
    if (req.headers.has("x-agentbox-session") || req.headers.has("x-agentbox-session-token")) throw new HttpError(403,"Screenshot previews belong to the user's attachment picker");
    return json(recentScreenshots());
  })
  .add("GET", "/api/screenshots/:id", ({req,params}) => {
    if (req.headers.has("x-agentbox-session") || req.headers.has("x-agentbox-session-token")) throw new HttpError(403,"Screenshot previews belong to the user's attachment picker");
    try {
      const image = screenshotImage(params.id!);
      return new Response(Bun.file(image.path), {headers:{"content-type":image.mime,"cache-control":"private, no-store","x-content-type-options":"nosniff"}});
    } catch (e) { throw new HttpError(404,(e as Error).message); }
  })
  .add("POST", "/api/uploads", async ({ req }) => {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_UPLOAD_BYTES) throw new HttpError(413, `the image is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    const bytes = new Uint8Array(await req.arrayBuffer());
    try {
      return json(saveUpload(bytes, req.headers.get("content-type") ?? ""), 201);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  })
  .add("POST", "/api/transcribe", async ({ req }) => {
    const mime = req.headers.get("content-type") ?? "";
    if (!/^audio\//i.test(mime)) throw new HttpError(400, `not a recording: ${mime || "no content type"}`);
    if (Number(req.headers.get("content-length") ?? 0) > MAX_AUDIO_BYTES) throw new HttpError(413, `the recording is over ${MAX_AUDIO_BYTES / 1024 / 1024} MB`);
    const key = deepgramKey();
    if (!key) throw new HttpError(503, `voice messages need DEEPGRAM_API_KEY in ${voiceEnvPath()}`);
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength === 0) throw new HttpError(400, "the recording is empty");
    if (bytes.byteLength > MAX_AUDIO_BYTES) throw new HttpError(413, `the recording is over ${MAX_AUDIO_BYTES / 1024 / 1024} MB`);
    const terms = [readUserIdentity().name, ...listRepos().map((r) => r.displayName)].slice(0, 40);
    try {
      return json({ text: await transcribe(key, bytes, mime, terms) });
    } catch (e) {
      throw new HttpError(502, (e as Error).message);
    }
  })
  .add("GET", "/api/uploads/:name", ({ params }) => {
    const f = uploadFile(params.name!);
    if (!f) throw new HttpError(404, "no such upload");
    return new Response(Bun.file(f.path), { headers: { "content-type": f.mime, "cache-control": "private, max-age=86400" } });
  })
  .add("GET", "/api/sessions/:id/image", ({ req, params, url }) => {
    const s = fleet.get(params.id!);
    let img;
    try {
      img = shownImage(url.searchParams.get("path") ?? "", s.cwd || null);
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
    // The file may be rewritten under the same name, so ask each time.
    const etag = `"${img.size.toString(36)}-${Math.floor(img.mtimeMs).toString(36)}"`;
    const headers = { "content-type": img.mime, "cache-control": "private, no-cache", etag, "x-content-type-options": "nosniff" };
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(Bun.file(img.path), { headers });
  })
  // A browser on this machine; anywhere else the link opens where it was clicked.
  .add("GET", "/api/desktop", ({ req }) => json({ backgroundTabs: fromThisMachine.has(req) && backgroundTabs() }))
  .add("POST", "/api/open-url", async ({ req }) => {
    if (!fromThisMachine.has(req)) throw new HttpError(403, "only a browser on this machine opens links on its desktop");
    await openUrlBehind(requireString(await readBody(req), "url"));
    return json(null);
  })
  .add("POST", "/api/sessions/:id/open-file", async ({ req, params }) => {
    const s = fleet.get(params.id!);
    const body = await readBody(req);
    return json(await openLocalFile(requireString(body, "path"), s.cwd || null, body.background === true));
  })
  .add("POST", "/api/sessions/:id/adopt", async ({ params }) => {
    const s = await fleet.adopt(params.id!);
    scheduleHot();
    return json(s);
  })
  // ----- crash recovery (src/core/recovery.ts)
  .add("GET", "/api/recovery", async () => json({ last: fleet.lastRecoveryReport(), preview: await fleet.recoveryPreview() }))
  .add("POST", "/api/recovery", async ({ req }) => {
    const b = await readBody(req);
    if (!Array.isArray(b.ids) || b.ids.length === 0 || !b.ids.every((id) => typeof id === "string")) {
      throw new HttpError(400, "ids: the sessions to recover, which must have stopped");
    }
    const report = await fleet.recoverByHand(b.ids as string[], b.dryRun === true);
    scheduleHot();
    return json(report);
  })
  .add("POST", "/api/sessions/:id/stop", async ({ params }) => {
    await fleet.stopSession(params.id!);
    scheduleHot();
    return json(null);
  })
  .add("POST", "/api/sessions/:id/close", async ({ req, params }) => {
    const b = await readBody(req);
    const out = await fleet.close(params.id!, requireBoolean(b, "closed"));
    scheduleHot();
    return json(out);
  })
  // A session hands what it holds to the one taking over from it: what it
  // started, its cards, its pull requests and their waits, and messages to it.
  .add("POST", "/api/sessions/:id/handover", async ({ req, params }) => {
    const b = await readBody(req);
    const to = requireString(b, "to");
    if (to === params.id) throw new HttpError(400, "a session cannot hand over to itself");
    if (!fleet.sessions().some((s) => s.id === params.id)) throw new HttpError(404, `no session ${params.id}`);
    if (!fleet.sessions().some((s) => s.id === to)) throw new HttpError(404, `no session ${to}`);
    // What it holds (its sessions, claims, PRs) is its own to give: the
    // session itself, the program of the superagent it belongs to, or a person.
    const program = superagentCaller(req, superagents), caller = authenticatedSession(req);
    if (program ? program !== superagents.ownerOf(params.id!, { authority: true }) : caller && caller !== params.id)
      throw new HttpError(403, `only session ${params.id} itself, its superagent's program or a person hands over what it holds`);
    const moved = await fleet.handOver(params.id!, to);
    const cardsMoved = moveCards(params.id!, to);
    const claimsMoved = movePrClaims(params.id!, to);
    if (b.close === true) await fleet.close(params.id!, true, true);
    scheduleHot();
    scheduleCold();
    return json({ to, children: moved, cards: cardsMoved, claims: claimsMoved, closed: b.close === true });
  })

  // ----- scheduled sessions (src/core/scheduler.ts)
  .add("POST", "/api/schedules", async ({ req }) => {
    const b = await readBody(req);
    const spec = (b.spec && typeof b.spec === "object" ? b.spec : {}) as Record<string, unknown>;
    const s = await scheduler.create({
      when: requireString(b, "when"),
      label: optionalString(b, "label") ?? null,
      spec: {
        provider: provider(spec.provider),
        cwd: optionalString(spec, "cwd"),
        repoId: optionalString(spec, "repoId"),
        worktree: spec.worktree === true,
        branch: optionalString(spec, "branch"),
        pr: typeof spec.pr === "number" && Number.isInteger(spec.pr) && spec.pr > 0 ? spec.pr : undefined,
        prompt: typeof spec.prompt === "string" && spec.prompt.trim() ? spec.prompt : undefined,
        model: optionalString(spec, "model"),
        effort: optionalString(spec, "effort"),
        accountId: optionalString(spec, "accountId") ?? null,
      },
      noteCmd: optionalString(b, "noteCmd") ?? null,
      sameSession: b.sameSession === true,
      freshOver: typeof b.freshOver === "number" ? b.freshOver : null,
    });
    return json(s, 201);
  })
  .add("PATCH", "/api/schedules/:id", async ({ req, params }) => {
    const b = await readBody(req);
    const edit: ScheduleEdit = {};
    if (b.when !== undefined) edit.when = requireString(b, "when");
    if (b.prompt !== undefined) {
      if (typeof b.prompt !== "string") throw new HttpError(400, "prompt must be a string");
      edit.prompt = b.prompt;
    }
    if (b.label !== undefined) edit.label = b.label === null ? null : requireString(b, "label");
    if (b.enabled !== undefined) edit.enabled = requireBoolean(b, "enabled");
    if (b.repoId !== undefined) edit.repoId = requireString(b, "repoId");
    if (b.noteCmd !== undefined) edit.noteCmd = b.noteCmd === null ? null : requireString(b, "noteCmd");
    if (b.sameSession !== undefined) edit.sameSession = requireBoolean(b, "sameSession");
    if (b.freshOver !== undefined) {
      if (b.freshOver !== null && typeof b.freshOver !== "number") throw new HttpError(400, "freshOver must be a number of tokens");
      edit.freshOver = b.freshOver as number | null;
    }
    return json(await scheduler.update(params.id!, edit));
  })
  .add("DELETE", "/api/schedules/:id", ({ params }) => {
    scheduler.remove(params.id!);
    return json(null);
  })
  .add("POST", "/api/schedules/:id/run", async ({ params }) => {
    const sessionId = await scheduler.runNow(params.id!);
    scheduleHot();
    return json({ sessionId });
  })
  // ----- waits (src/core/waits.ts)
  .add("GET", "/api/waits", ({ url }) => json(waits.list(url.searchParams.get("session") ?? undefined, url.searchParams.get("all") === "1")))
  .add("POST", "/api/waits", async ({ req }) => {
    const b = await readBody(req);
    if (b.timeoutMs !== undefined && typeof b.timeoutMs !== "number") throw new HttpError(400, "timeoutMs must be a number");
    const who = speaker(b);
    if (!who) throw new HttpError(400, "a wait tells a session how it ended: run this from inside one, or name it with --for <session id>");
    const spec = (b.spec && typeof b.spec === "object" ? { ...b.spec } : {}) as Record<string, unknown>;
    // A pull request as it was typed, a run with no repo named: the repo is the caller's.
    if (spec.kind === "pr" && b.pr !== undefined) Object.assign(spec, prNamed(b, who));
    const cwd = optionalString(b, "cwd");
    if (spec.kind === "run" && !spec.repo) spec.repo = (cwd ? repoFullNameOf(cwd) : null) ?? undefined;
    return json(waits.arm(fleet.heir(who), parseSpec(spec), b.timeoutMs as number | undefined), 201);
  })
  .add("DELETE", "/api/waits/:id", ({ params }) => {
    if (!/^\d{1,9}$/.test(params.id!)) throw new HttpError(400, "a wait's id is a number");
    return json(waits.cancel(Number(params.id)));
  })
  // ----- cards (src/core/cards.ts)
  .add("GET", "/api/cards", ({ url }) => {
    const state = url.searchParams.get("state");
    if (state && !["open", "later", "answered", "closed"].includes(state)) throw new HttpError(400, "state is one of open, later, answered, closed");
    return json(cards.list({ state: (state as CardState | null) ?? undefined, unread: url.searchParams.get("unread") === "1", sessionId: url.searchParams.get("session") ?? undefined }));
  })
  .add("POST", "/api/cards", async ({ req }) => {
    const b = await readBody(req);
    const kind = requireString(b, "kind") as CardKind;
    if (!CARD_KINDS.includes(kind)) throw new HttpError(400, `kind is one of ${CARD_KINDS.join(", ")}`);
    const callerPid = typeof b.callerPid === "number" && Number.isInteger(b.callerPid) && b.callerPid > 1 ? b.callerPid : null;
    const id = (v: unknown) => (typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : null);
    return json(
      cards.add({
        kind,
        title: requireString(b, "title"),
        short: requireString(b, "short"),
        long: optionalString(b, "long"),
        pr: optionalString(b, "pr"),
        recommend: optionalString(b, "recommend"),
        default: optionalString(b, "default"),
        defaultAt: typeof b.defaultAt === "number" ? b.defaultAt : null,
        key: optionalString(b, "key"),
        sessionId: id(b.session) ?? (callerPid ? fleet.callerOf(callerPid) : null),
        about: id(b.about),
        at: typeof b.at === "number" && b.at > 0 ? b.at : null,
        notify: b.notify !== false,
      }),
      201,
    );
  })
  .add("GET", "/api/cards/:id", ({ params }) => json(cards.get(cardId(params.id!))))
  .add("POST", "/api/cards/:id/answer", async ({ req, params }) => {
    const b = await readBody(req);
    if (typeof b.text !== "string") throw new HttpError(400, "text must be a string");
    requirePersonForCard(req, cards.get(cardId(params.id!)).key);
    return json(cards.answer(cardId(params.id!), b.text));
  })
  .add("POST", "/api/cards/:id/later", ({ params }) => json(cards.later(cardId(params.id!))))
  .add("POST", "/api/cards/:id/undo", ({ params }) => json(cards.undo(cardId(params.id!))))
  .add("POST", "/api/cards/:id/ack", ({ params }) => json(cards.ack(cardId(params.id!))))
  .add("POST", "/api/cards/:id/close", async ({ req, params }) => {
    const b = await readBody(req);
    return json(cards.close(cardId(params.id!), typeof b.why === "string" ? b.why : ""));
  })
  // What `agentbox watch` needs of each session, closed ones too (it must see
  // a reopen as one), and nothing else. With `after`, the rows it already has,
  // the answer waits until they differ or CHANGES_WAIT_MS passes.
  .add("GET", "/api/sessions/changes", async ({ url }) => {
    const ids = url.searchParams.get("ids");
    const only = ids ? new Set(ids.split(",")) : null;
    const after = url.searchParams.get("after");
    const deadline = Date.now() + CHANGES_WAIT_MS;
    let rows = changeRows(only);
    while (after !== null && rowsVersion(rows) === after && Date.now() < deadline) {
      await boardChange(deadline - Date.now());
      rows = changeRows(only);
    }
    return json(rows);
  })
  .add("GET", "/api/sessions/closed", ({ url }) => {
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 30));
    const project = url.searchParams.get("project");
    const repos = project ? reposWithRoots() : [];
    const owner = superagents.ownership(), bound = superagents.projectBinding(owner), human = url.searchParams.get("human") === "1";
    const page = fleet.closed(url.searchParams.get("q") ?? "", offset, limit,
      (s) => (!human || !owner(s.id)) && (!project || (bound(s.id) ?? sessionProject(repos, s)) === project));
    return json({ sessions: page.sessions.map((s) => ({ ...s, agentOwner: owner(s.id), ...withProject(bound(s.id)), attention: attentionOf(s, null) })), total: page.total });
  })
  .add("GET", "/api/sessions/:id/timeline", async ({ params, url }) => {
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? TIMELINE_PAGE) || TIMELINE_PAGE));
    const page = await fleet.timeline(params.id!, url.searchParams.get("before"), limit);
    return json({ ...page, events: attribute(params.id!, page.events, superagents.senders) });
  })
  .add("GET", "/api/sessions/:id/turns", async ({ params }) => {
    fleet.get(params.id!);
    if (!fleet.hasTranscript(params.id!)) return json({ turns: [], total: 0 });
    return json(await turnIndex.list(params.id!));
  })
  .add("POST", "/api/sessions/:id/term/seek", async ({ req, params }) => {
    const id = params.id!;
    const turnId = requireString(await readBody(req), "turnId");
    const { io, claude } = seekable(id);
    const { turns } = await turnIndex.list(id);
    const target = turns.findIndex((t) => t.id === turnId);
    if (target === -1) throw new HttpError(404, "no such message in this session");
    const token = (seeks.get(id) ?? 0) + 1;
    seeks.set(id, token);
    return json(await seekTurn(io, turns, target, { claude, cancelled: () => seeks.get(id) !== token }));
  })
  .add("POST", "/api/sessions/:id/term/bottom", async ({ params }) => {
    const id = params.id!;
    const { io, claude } = seekable(id);
    seeks.set(id, (seeks.get(id) ?? 0) + 1);
    await seekBottom(io, { claude });
    return json(null);
  })
  .add("GET", "/api/sessions/:id/term/where", async ({ params }) => {
    const id = params.id!;
    const { io } = seekable(id);
    const { turns } = await turnIndex.list(id);
    return json(whereOnScreen(io.capture(), turns));
  })
  .add("GET", "/api/sessions/:id/diff", ({ params }) => json(diffOf(fleet.get(params.id!))))
  .add("GET", "/api/sessions/:id/load", async ({ params }) => {
    const s = fleet.get(params.id!);
    if (!s.pid) throw new HttpError(409, "session has no running process");
    return json(await procDetail(s.pid));
  })
  // What it waits on: shells, monitors and in-process agents (src/core/work.ts).
  .add("GET", "/api/sessions/:id/work", async ({ params }) => json(await sessionWork(fleet.get(params.id!))))
  // One of those agents' own transcript, for the view a click in the list opens.
  .add("GET", "/api/sessions/:id/agents/:agentId/timeline", async ({ params, url }) => {
    const t = await agentTimeline(fleet.get(params.id!), params.agentId!, url.searchParams.get("since"));
    if (!t) throw new HttpError(404, "no such agent in this session");
    return json(t);
  })
  .add("GET", "/api/sessions/:id/attach", ({ params }) => json({ argv: fleet.attachCommand(params.id!) }))
  .add("GET", "/api/sessions/:id/screen", ({ params }) => json({ text: fleet.screen(params.id!) }))
  .add("GET", "/api/grep", async ({ req, url }) => {
    const pattern = url.searchParams.get("q") ?? "";
    if (!pattern) throw new HttpError(400, "q is required");
    const flags = url.searchParams.get("i") === "1" ? "i" : "";
    try {
      new RegExp(pattern, flags);
    } catch (e) {
      throw new HttpError(400, `bad pattern: ${(e as Error).message}`);
    }
    const all = url.searchParams.get("all") === "1";
    const sessions = fleet.sessions().flatMap((s) => {
      const ref = (all || s.status !== "closed") && s.transcriptPath ? fleet.transcriptRef(s.id) : null;
      return ref ? [{ id: s.id, ref }] : [];
    });
    return json(await grepInWorker({ pattern, flags, sessions }, req.signal));
  })

  // ---- accounts
  .add("GET", "/api/accounts", () => json(accountViews()))
  .add("GET", "/api/models", async ({ url }) => {
    const a = accounts.get(url.searchParams.get("accountId") ?? "");
    if (!a) throw new HttpError(404, "no such account");
    const p = url.searchParams.get("provider");
    return json(await modelOptions(a, p ? provider(p) : a.provider));
  })
  .add("POST", "/api/accounts", async ({ req }) => {
    const b = await readBody(req);
    const out = await accounts.create(accountProvider(b.provider), optionalString(b, "label"));
    scheduleCold();
    return json(out, 201);
  })
  .add("POST", "/api/accounts/import", async ({ req }) => {
    const b = await readBody(req);
    const a = await accounts.importHome(accountProvider(b.provider), requireString(b, "home"));
    scheduleCold();
    return json(a, 201);
  })
  .add("PATCH", "/api/accounts/:id", async ({ req, params }) => {
    const b = await readBody(req);
    const a = accounts.update(params.id!, {
      label: optionalString(b, "label"),
      enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
    });
    scheduleCold();
    return json(a);
  })
  .add("DELETE", "/api/accounts/:id", ({ params }) => {
    accounts.remove(params.id!);
    scheduleCold();
    return json(null);
  })
  .add("POST", "/api/accounts/:id/login", async ({ params }) => {
    const flow = accounts.login(params.id!);
    scheduleCold();
    return json(flow);
  })
  .add("POST", "/api/accounts/:id/usage", async ({ params }) => {
    const u = await accounts.refreshUsage(params.id!);
    scheduleCold();
    return json(u);
  })
  .add("POST", "/api/accounts/:id/reset", async ({ req, params }) => {
    const b = await readBody(req);
    const out = await accounts.consumeReset(params.id!, optionalString(b, "creditId") ?? null);
    scheduleCold();
    return json(out);
  })
  .add("POST", "/api/logins/:id/paste", async ({ req, params }) => {
    const b = await readBody(req);
    const flow = accounts.paste(params.id!, requireString(b, "text"));
    scheduleCold();
    return json(flow);
  })
  .add("POST", "/api/logins/:id/cancel", ({ params }) => {
    accounts.cancel(params.id!);
    scheduleCold();
    return json(null);
  })
  .add("GET", "/api/accounts/:id/insights", async ({ params, url }) => {
    const homes = accounts.list();
    const owner = owners(homes);
    const home = homes.find((h) => h.id === params.id);
    if (!home) throw new HttpError(404, "no such account");
    const id = owner.get(home.id) ?? home.id;
    const mine = homes.filter((h) => (owner.get(h.id) ?? h.id) === id);
    const days = Math.min(7, Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7));
    const known = new Map(
      fleet
        .sessions()
        .filter((s) => s.provider === home.provider && s.agentSessionId)
        .map((s) => [s.agentSessionId!, { id: s.id, title: s.title }]),
    );
    return json(
      await usageInsights({
        account: { id, provider: home.provider },
        accountIds: mine.map((h) => h.id),
        homes: mine.map((h) => h.home),
        days,
        known: (k) => known.get(k) ?? null,
      }),
    );
  })
  .add("GET", "/api/calibration", ({ url }) => {
    const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7));
    const homes = accounts.list();
    const owner = owners(homes);
    return json(calibrate(fleet.forecaster.report(homes.filter((a) => owner.get(a.id) === a.id), Date.now()), days));
  })

  // ---- settings, repos, worktrees, skills
  .add("GET", "/api/profile", async ({ url }) => json(await githubProfile(url.searchParams.get("refresh") === "1")))
  .add("GET", "/api/settings", () => json(getSettings()))
  .add("PUT", "/api/settings", async ({ req }) => {
    const patch = parseSettingsPatch(await readBody(req));
    const next = mergeSettings(getSettings(), patch);
    saveSettings(next);
    scheduleCold();
    void fleet.tick().then(scheduleHot);
    return json(next);
  })
  // ---- notifications (src/core/push.ts)
  .add("GET", "/api/push", async () =>
    json({ publicKey: await pushPublicKey(), devices: pushSubscriptions().map((d) => ({ endpoint: d.endpoint, userAgent: d.userAgent, createdAt: d.createdAt })) }),
  )
  .add("POST", "/api/push/subscribe", async ({ req }) => {
    let sub;
    try {
      sub = parseSubscription(await readBody(req), req.headers.get("user-agent"));
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(400, (e as Error).message);
    }
    addSubscription(sub);
    return json(null);
  })
  .add("POST", "/api/push/unsubscribe", async ({ req }) => {
    removeSubscription(requireString(await readBody(req), "endpoint"));
    return json(null);
  })
  .add("POST", "/api/push/test", async () => {
    if (pushSubscriptions().length === 0) throw new HttpError(409, "no device has notifications turned on");
    return json(await pushToAll({ title: "agentbox", body: "Notifications work on this device.", url: "/#/sessions", tag: "test" }));
  })
  .add("GET", "/api/repos", () => json(listRepos()))
  .add("POST", "/api/repos", async ({ req }) => {
    const b = await readBody(req);
    const repo = await addRepo(requireString(b, "ref")).catch((e: Error) => {
      throw new HttpError(400, e.message);
    });
    // The repo itself goes out now (the switcher offers it, a scope on it
    // is good again); its skills and PRs follow when the slow inputs are in.
    scheduleCold();
    void refreshSlow();
    void refreshPrs();
    return json(repo, 201);
  })
  .add("DELETE", "/api/repos/:id", ({ params }) => {
    deleteRepo(params.id!);
    scheduleCold();
    void refreshSlow();
    return json(null);
  })
  .add("PATCH", "/api/repos/:id", async ({ req, params }) => {
    const b = await readBody(req);
    if (!getRepoById(params.id!)) throw new HttpError(404, `no repo ${params.id}`);
    if ("worktreeDefault" in b && b.worktreeDefault !== null && typeof b.worktreeDefault !== "boolean") {
      throw new HttpError(400, "worktreeDefault must be true, false or null");
    }
    let setup: RepoSetup | null = null;
    if ("setup" in b) {
      try {
        setup = parseSetup(b.setup);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    if ("worktreeDefault" in b) setRepoWorktreeDefault(params.id!, b.worktreeDefault as boolean | null);
    if (setup) setRepoSetup(params.id!, setup);
    scheduleCold();
    return json(listRepos());
  })
  .add("POST", "/api/onboarding/service", () => {
    try {
      const done = installService();
      slow.serviceInstalled = serviceInstalled();
      slow.lingering = lingering();
      scheduleCold();
      return json({ installed: done.unit, lingering: done.lingering });
    } catch (e) {
      // A missing systemd is an answer, not a bug: 400, not 500.
      throw new HttpError(400, (e as Error).message);
    }
  })
  .add("POST", "/api/worktrees/scan", async ({ req }) => {
    const b = await readBody(req);
    const scope = b.scope ?? "all";
    if (scope !== "all" && scope !== "agentbox") throw new HttpError(400, "scope must be all or agentbox");
    return json(await scanWorktrees(scope, fleet.sessions()));
  })
  .add("POST", "/api/worktrees/reclaim", async ({ req }) => {
    const b = await readBody(req);
    if (!Array.isArray(b.paths) || !b.paths.every((p) => typeof p === "string")) {
      throw new HttpError(400, "paths must be a list of worktree paths");
    }
    return json(await reclaimWorktrees(b.paths as string[], { force: b.force === true, sessions: fleet.sessions() }));
  })
  .add("GET", "/api/worktrees/nightly", () => json({ last: lastNightlyReclaim() }))
  .add("GET", "/api/skill/body", ({ url }) => {
    const raw = url.searchParams.get("path") ?? "";
    const dir = containedIn(raw, skillRootDirs(localRepoDirs(listRepos())));
    if (!dir) throw new HttpError(403, "not a skill directory agentbox manages");
    const file = skillMdPath(dir);
    if (!looksLikeSkillFile(file)) throw new HttpError(403, "not a skill file");
    return json({ body: readSkillBody(file) });
  })
  .add("POST", "/api/skill/body", async ({ req }) => {
    const b = await readBody(req);
    const dir = containedIn(requireString(b, "path"), skillRootDirs(localRepoDirs(listRepos())));
    if (!dir) throw new HttpError(403, "not a skill directory agentbox manages");
    const file = skillMdPath(dir);
    if (!looksLikeSkillFile(file)) throw new HttpError(403, "not a skill file");
    if (typeof b.body !== "string") throw new HttpError(400, "body must be a string");
    const ok = writeSkillBody(file, b.body);
    void refreshSlow();
    return json({ ok });
  })
  // Global MCP servers (src/core/mcp.ts): the list, what the agents' own
  // configs define, and how far each server reaches.
  .add("GET", "/api/mcp", async () => json(await mcpState()))
  .add("POST", "/api/mcp/servers", async ({ req }) => {
    addServer((await readBody(req)) as unknown as McpServerInput);
    return json(await mcpState());
  })
  .add("PUT", "/api/mcp/servers/:name", async ({ req, params }) => {
    updateServer(params.name!, (await readBody(req)) as unknown as McpServerInput);
    return json(await mcpState());
  })
  .add("POST", "/api/mcp/servers/:name/enabled", async ({ req, params }) => {
    setEnabled(params.name!, requireBoolean(await readBody(req), "enabled"));
    return json(await mcpState());
  })
  .add("DELETE", "/api/mcp/servers/:name", async ({ params }) => {
    removeServer(params.name!);
    return json(await mcpState());
  })
  .add("POST", "/api/mcp/servers/:name/check", async ({ params }) => {
    if (!readRegistry().servers.some((x) => x.name === params.name)) throw new HttpError(404, `no global server named ${params.name}`);
    return json(await checkServer(params.name!));
  })
  .add("POST", "/api/mcp/import", async ({ req }) => {
    const b = await readBody(req);
    const def = foundDefinition(requireString(b, "id"));
    if (!def) throw new HttpError(404, "that server is no longer in the agent's config, or agentbox cannot carry it");
    // A project's server reaches only that project's sessions until you say otherwise.
    if (def.scope === "project" && b.promote !== true) throw new HttpError(400, "this server belongs to one project; promote it to make it global");
    const rename = optionalString(b, "name");
    importServer({ ...def, name: rename?.trim() || def.name, transport: def.transport });
    return json(await mcpState());
  })
  .add("POST", "/api/skill/promote", async ({ req }) => {
    const b = await readBody(req);
    const name = requireString(b, "name");
    const skill = slow.skills.find((s) => s.name === name && s.source === "project");
    if (!skill) throw new HttpError(404, `no project skill named ${name}`);
    const r = promoteSkill(skill);
    void refreshSlow();
    return json(r);
  })
  .add("POST", "/api/skill/demote", async ({ req }) => {
    const b = await readBody(req);
    const r = demoteSkill(requireString(b, "name"));
    void refreshSlow();
    return json(r);
  });
superagentRoutes(router, superagents, { scheduleHot });
claimRoutes(router, workClaims, superagents);
/** The GitHub App broker: superagents request actions; tokens stay in it (src/core/github/). */
export const github = new GitHubActions({ broker: new GitHubBroker(), cards, dirOf: (n) => superagents.get(n).dir, cwdOf: (id) => fleet.sessions().find((s) => s.id === id)?.cwd ?? null });
githubRoutes(router, github, superagents);
// An action may name a work claim: it must still be its superagent's, at its fence, when it is sent.
github.claims = {
  current: async (scope, key) => {
    const c = (await workClaims.list({ key, scope: scope === "env" ? "env" : "work" }))[0];
    return c ? { fence: c.fence, state: c.state, holder: c.holder } : null;
  },
};
/** Shared superagents: answers teammates through the cloud, and keeps a shared one's claims there (src/core/superagent/team.ts). */
export const team = new TeamHost({ fleet, superagents, cloud, claims: workClaims });
teamRoutes(router, { superagents, cloud, team, claims: workClaims });
// Contact consent is the cloud's: without it, an action that contacts a person is refused.
if (cloudConfig().config) github.consent = new CloudConsent(() => team.api(), (name) => team.instanceOf(name));
cloudRoutes(router, cloud, fleet).otherwise(({ req, url }) => {
    if (req.method !== "GET" && req.method !== "HEAD") return fail(`no route for ${req.method} ${url.pathname}`, 404);
    const found = resolveStatic(webDist, url.pathname);
    if (found.kind === "notBuilt") return notBuiltPage();
    if (found.kind === "notFound") return new Response("not found", { status: 404 });
    return fileResponse(webDist, found.path, req);
  });

// ----------------------------------------------------------- UI build

/**
 * `bun run web:build` replaces `web/dist` while the server keeps running, and
 * deletes the chunks an open page has not fetched yet. Say so, so the page can
 * reload at a moment that loses nothing. A poll rather than `fs.watch`: the
 * build empties the directory, and a watcher does not survive its removal.
 */
let uiBuild = builtEntry(webDist);
let uiBuildMtime = 0;
function checkBuild(): void {
  let mtime = 0;
  try {
    mtime = statSync(join(webDist, "index.html")).mtimeMs;
  } catch {
    // No index.html: mid-build or never built; nothing to announce.
  }
  if (mtime === uiBuildMtime) return;
  const entry = builtEntry(webDist);
  if (entry === null) return; // not complete yet; look again next poll
  uiBuildMtime = mtime;
  if (entry === uiBuild) return;
  uiBuild = entry;
  broadcast({ type: "build", entry });
}

/** Commits on the checkout's branch that this server does not run: the
 *  board's Update button offers a restart onto them. */
let serverBehind: Behind | null = null;
const BEHIND_POLL_MS = 15_000;
function checkBehind(): void {
  let next: Behind | null = null;
  try {
    next = behindHead(sourceCheckout(packageRoot), RUNNING_REVISION?.commit);
  } catch {
    // An unreadable checkout says nothing new.
  }
  if (JSON.stringify(next) === JSON.stringify(serverBehind)) return;
  serverBehind = next;
  broadcast({ type: "behind", behind: next });
}

// ------------------------------------------------------------------ boot

/** The first pass is done and everything below `Bun.serve` in `startServer`
 *  has run: until then pages wait in `waiting` and requests on `untilBooted`. */
let booted = false;
let markBooted!: () => void;
const untilBooted = new Promise<void>((r) => (markBooted = r));
const waiting = new Set<Socket>();
let stopping = false;
const bootStarted = performance.now();
const STARTING_PUSH_MS = 500;

function startupProgress(): { read: number; of: number } {
  const p = fleet.startup();
  // Past the transcripts, on the slow inputs: everything is read.
  return p ?? { read: 1, of: 1 };
}

/** A page's first frames: the whole board, cold state, metrics, the build. */
function welcome(ws: Socket): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  clients.add(ws);
  send(ws, { type: "hot", state: hotState(true) });
  send(ws, { type: "cold", state: coldState() });
  send(ws, { type: "metrics", state: metricsSnapshot() });
  send(ws, { type: "build", entry: uiBuild });
  send(ws, { type: "behind", behind: serverBehind });
  setMetricsWatchers(clients.size);
  // A watch sent while it waited.
  if (ws.data.kind === "app" && ws.data.watching) {
    send(ws, { type: "btw", sessionId: ws.data.watching, items: listBtw(ws.data.watching) });
    void pumpTimeline(ws);
  }
}

export async function startServer(): Promise<void> {
  // Hold the port through startup, which takes a while on a busy machine. A
  // CLI that finds the server slow to answer starts another; found busy only at
  // Bun.serve, that one used to linger with a whole second fleet ticking in it.
  let hold: { stop(closeActive?: boolean): void };
  try {
    hold = Bun.listen({ hostname: HOST, port: PORT, socket: { open: (s) => void s.end(), data() {} } });
  } catch {
    throw new Error(`port ${PORT} is in use — another agentbox server is already running`);
  }
  const phases: string[] = [];
  let phaseAt = bootStarted;
  const phase = (name: string) => {
    const t = performance.now();
    phases.push(`${name} ${((t - phaseAt) / 1000).toFixed(1)}s`);
    phaseAt = t;
  };
  phase("loading");

  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Tell every page first: a restart is back in seconds, and a page that
    // knows reconnects at once instead of backing off (code 1012, Service
    // Restart).
    for (const ws of [...clients, ...waiting]) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      ws.send(JSON.stringify({ type: "restarting" } satisfies ServerMessage));
      ws.close(1012, "restarting");
    }
    scheduler.stop();
    waits.stop();
    superagents.stopAll();
    github.stop();
    team.stop();
    fleet.stop();
    accounts.stop();
    // Long enough for the close frames to leave.
    setTimeout(() => process.exit(0), 100);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const websocket: WebSocketHandler<SocketData> = {
    open(ws) {
      if (ws.data.kind === "term") {
        openTerminal(ws);
        return;
      }
      if (ws.data.kind === "voice") {
        const d = ws.data;
        const r = voice.open(d.convId, {
          json: (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)),
          audio: (pcm) => ws.readyState === WebSocket.OPEN && ws.send(pcm),
        });
        if (typeof r === "string") {
          ws.send(JSON.stringify({ type: "error", message: r }));
          ws.close(1011, "voice unavailable");
        } else d.conv = r;
        return;
      }
      if (booted) welcome(ws);
      else {
        waiting.add(ws);
        send(ws, { type: "starting", ...startupProgress() });
      }
    },
    message(ws, raw) {
      if (ws.data.kind === "voice") {
        const c = ws.data.conv;
        if (!c) return;
        if (typeof raw === "string") voice.message(c, raw);
        else c.audio(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
        return;
      }
      if (ws.data.kind === "term") handleTermMessage(ws, raw);
      else handleAppMessage(ws, raw);
    },
    close(ws) {
      if (ws.data.kind === "voice") ws.data.conv?.detach();
      else if (ws.data.kind === "term") closeTerminal(ws);
      else {
        waiting.delete(ws);
        dropClient(ws);
      }
    },
  };

  const handle = (req: Request, srv: Server<SocketData>, hosts?: readonly string[]): Response | undefined | Promise<Response> => {
    const url = new URL(req.url);
    const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    const verdict = checkRequest(req, PORT, { upgrade, hosts });
    if (!verdict.ok) return fail(verdict.reason, 403);
    // The loopback listener, or the tailnet one reached at this machine's own address.
    if (!hosts || srv.requestIP(req)?.address === hosts[0]) fromThisMachine.add(req);
    // The client's port, so a person-only act can see which process sent it (peer.ts).
    if (!hosts) {
      const port = srv.requestIP(req)?.port;
      if (port) peerPorts.set(req, port);
    }

    if (url.pathname === "/ws") {
      if (!upgrade) return fail("/ws requires a WebSocket upgrade", 426);
      return srv.upgrade(req, { data: { kind: "app", watching: null, cursor: null, busy: false, again: false } })
        ? undefined
        : fail("websocket upgrade failed", 500);
    }
    // Terminals and voice need the board; a page's socket may wait for it.
    if (!booted && (url.pathname.startsWith("/ws/") || url.pathname.startsWith("/api/")) && url.pathname !== "/api/health") {
      if (upgrade) return fail("agentbox is starting", 503);
      return untilBooted.then(() => router.handle(req));
    }
    if (url.pathname === "/ws/voice") {
      if (!upgrade) return fail("voice requires a WebSocket upgrade", 426);
      const convId = url.searchParams.get("c") ?? "";
      if (!/^[a-z0-9-]{8,64}$/.test(convId)) return fail("voice needs a conversation id", 400);
      return srv.upgrade(req, { data: { kind: "voice", convId } }) ? undefined : fail("websocket upgrade failed", 500);
    }
    const term = url.pathname.match(/^\/ws\/term\/([a-z0-9]+)$/);
    if (term) {
      if (!upgrade) return fail("terminal requires a WebSocket upgrade", 426);
      const cols = Math.max(20, Math.min(500, Number(url.searchParams.get("cols")) || 120));
      const rows = Math.max(5, Math.min(200, Number(url.searchParams.get("rows")) || 40));
      return srv.upgrade(req, { data: { kind: "term", sessionId: term[1]!, cols, rows } })
        ? undefined
        : fail("websocket upgrade failed", 500);
    }
    // A search reads every transcript, minutes on a loaded machine, and sends
    // nothing until it is done: the idle timeout would cut it.
    if (url.pathname === "/api/grep") srv.timeout(req, 0);
    return router.handle(req);
  };

  // Serve from the start, before the accounts and the first pass, which on
  // a busy machine, or with readers that cannot carry on from a saved state,
  // take a while: pages connect and hear how far it is, and requests wait for
  // it rather than failing (`handle`).
  hold.stop(true);
  Bun.serve<SocketData>({ port: PORT, hostname: HOST, idleTimeout: 60, websocket, fetch: (req, srv) => handle(req, srv) });
  console.log(`agentbox listening on http://${HOST}:${PORT}`);
  void listenOnTailnet(websocket, handle);
  const progress = setInterval(() => {
    for (const ws of waiting) send(ws, { type: "starting", ...startupProgress() });
  }, STARTING_PUSH_MS);

  // Default accounts must exist before the first fleet tick, or every
  // transcript found on it would be filed under no account. (omp has none:
  // without an OpenCode Go account its sessions are not on the board.)
  await accounts.start();
  phase("accounts");
  fleet.start();
  // Before the first client is welcomed: cold state's first push would
  // otherwise carry the slow inputs' defaults — a checklist that says tmux is
  // missing on a machine that has it, until the first refresh lands a minute
  // later. Beside the first pass, not after it: each probe is a process to wait on.
  const firstSlow = refreshSlow().catch((e: unknown) => console.error("agentbox: first slow refresh failed:", e));

  await fleet.ready;
  phase("first pass");
  scheduler.start();
  waits.start();
  superagents.start();
  cards.start();
  github.start();
  // Local first: with no cloud.env this reads nothing and sends nothing.
  cloud.start();
  team.start();
  // omp's OpenCode Go endpoint is the bridge (its models.yml), in agentbox's
  // sessions and in your own terminals alike, and Go's usage is asked through
  // it (accounts/usage.ts), so it is up from the start.
  ensureBridge();
  await firstSlow;
  // Its PRs are the sessions', which the pass may have finished after it looked.
  slow.prs = openPrs(fleet.sessions());
  phase("slow inputs");
  setInterval(() => refreshSlow().catch((e: unknown) => console.error("agentbox: slow refresh failed:", e)), SLOW_REFRESH_MS).unref?.();
  void refreshPrs();
  setInterval(() => void refreshPrs(), SLOW_REFRESH_MS).unref?.();
  checkBuild();
  setInterval(checkBuild, BUILD_POLL_MS).unref?.();
  checkBehind();
  setInterval(checkBehind, BEHIND_POLL_MS).unref?.();
  watchPwaDesktop();
  startNightlyReclaim(() => fleet.sessions());

  fleet.on("sessions", () => {
    notifyBlocked(
      () => fleet.sessions(),
      (id) => fleet.blockedReason(id),
      (id) => typedAt.get(id) ?? 0,
    );
    scheduleHot();
    // Claims move with sessions, and claims are on the Accounts page.
    scheduleCold();
  });
  fleet.on("transcript", onTranscript);
  fleet.on("btw", onBtw);
  voice = new VoiceHub(fleet);
  accounts.on("change", scheduleCold);
  metricsEvents.on("metrics", (state: MetricsState) => broadcast({ type: "metrics", state }));

  clearInterval(progress);
  booted = true;
  markBooted();
  for (const ws of waiting) welcome(ws);
  waiting.clear();
  console.log(`agentbox ready in ${((performance.now() - bootStarted) / 1000).toFixed(1)}s (${phases.join(", ")})`);
}

async function listenOnTailnet(
  websocket: WebSocketHandler<SocketData>,
  handle: (req: Request, srv: Server<SocketData>, hosts?: readonly string[]) => Response | undefined | Promise<Response>,
): Promise<void> {
  const self = await tailnetSelf();
  if (!self) {
    if (process.env.AGENTBOX_TAILNET !== "0") setTimeout(() => void listenOnTailnet(websocket, handle), 60_000);
    return;
  }
  const peers = new PeerCheck(self);
  let server: Server<SocketData> | null = null;
  let tls: { cert: string; key: string } | null = null;
  const listen = () => {
    server?.stop(true);
    try {
      server = Bun.serve<SocketData>({
        port: PORT,
        hostname: self.ip,
        idleTimeout: 60,
        websocket,
        ...(tls ? { tls } : {}),
        async fetch(req, srv) {
          const from = srv.requestIP(req)?.address;
          if (!from || !(await peers.isOwner(from))) return fail("only your own Tailscale devices may connect", 403);
          return handle(req, srv, self.names);
        },
      });
      console.log(`agentbox listening on ${tls ? "https" : "http"}://${self.dnsName ?? self.ip}:${PORT} (your Tailscale devices)`);
    } catch (err) {
      server = null;
      console.error(`agentbox: not listening on the tailnet (${self.ip}:${PORT}): ${(err as Error).message}`);
    }
  };
  tls = await tailnetCert(self);
  listen();
  // Upgrade to HTTPS the moment the tailnet allows it, and pick up renewals.
  const recheck = async () => {
    const next = await tailnetCert(self);
    if (next && next.cert !== tls?.cert) {
      tls = next;
      listen();
    }
    setTimeout(() => void recheck(), tls ? 12 * 3_600_000 : 5 * 60_000).unref?.();
  };
  setTimeout(() => void recheck(), tls ? 12 * 3_600_000 : 5 * 60_000).unref?.();
}

if (import.meta.main) await startServer();
