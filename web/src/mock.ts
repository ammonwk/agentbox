/** A believable agentbox, in the browser, for `?mock=1`.
 *
 * Built so the UI can be developed and screenshotted with no server: several
 * providers, three Claude accounts with very different 5-hour/weekly shapes,
 * two Codex accounts, sessions in every status and host, logins in flight, a
 * calibration report. Mutations mostly succeed and are reflected in the state
 * (labels, Big, enabled, settings, stop/resume) so interactions can be tried;
 * nothing leaves the page.
 *
 * Only ever loaded through a dynamic import from api.ts, so a production
 * bundle does not carry it.
 */

import type {
  AccountUsage,
  AccountView,
  AgentSettings,
  AppState,
  Attention,
  AttentionKind,
  BalancerSettings,
  CalibrationReport,
  Candidate,
  ClaimView,
  ClientMessage,
  ColdState,
  HotState,
  LoadSample,
  LoginFlow,
  MetricsState,
  Placement,
  ProcDetail,
  ProviderId,
  Repo,
  ServerMessage,
  Session,
  SessionDiff,
  SkillInfo,
  SystemState,
  TimelineEvent,
  TimelinePage,
  UsageWindow,
  WorktreeScan,
} from "../../src/core/types";
import type { TermChannel, TermHandlers } from "./api";

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const T0 = Date.now();
const HOME = "/home/dev";

// ------------------------------------------------------------- settings

const settings: AgentSettings = {
  theme: "system",
  boardDays: 7,
  autoApprove: false,
  models: { claude: "claude-fable-5-1", codex: "gpt-5.4-codex", devin: "", omp: "" },
  balancer: {
    claimNormal: 5,
    claimBig: 20,
    shortWindowInWeekly: 24,
    claimIdleMin: 60,
    resetHorizonMin: 60,
    tieBand: 10,
  },
};

// ------------------------------------------------------------- accounts

function win(
  id: string,
  kind: UsageWindow["kind"],
  label: string,
  usedPct: number,
  resetsIn: number | null,
  scope?: string,
): UsageWindow {
  const windowMs = kind === "short" ? 5 * H : 7 * D;
  return {
    id,
    kind,
    label,
    usedPct,
    resetsAt: resetsIn == null ? null : T0 + resetsIn,
    windowMs,
    ...(scope ? { scope: { model: scope } } : {}),
  };
}

function usage(accountId: string, windows: UsageWindow[], extra: Partial<AccountUsage> = {}): AccountUsage {
  return { accountId, at: T0 - 2 * M, windows, stale: null, source: "endpoint", notes: [], ...extra };
}

type MockAccount = Omit<AccountView, "claims" | "placement">;

const accounts: MockAccount[] = [
  {
    id: "cl-work",
    provider: "claude",
    label: "work",
    email: "dev@acme.dev",
    plan: "max",
    home: `${HOME}/.claude`,
    isDefault: true,
    enabled: true,
    createdAt: T0 - 120 * D,
    auth: { state: "ok", expiresAt: T0 + 5 * H, detail: null },
    usage: usage("cl-work", [
      win("five_hour", "short", "5-hour", 38, 3 * H + 12 * M),
      win("seven_day", "weekly", "Weekly", 64, 2 * D + 5 * H),
      win("seven_day:Fable", "weekly", "Weekly", 41, 2 * D + 5 * H, "Fable"),
    ]),
  },
  {
    id: "cl-personal",
    provider: "claude",
    label: "personal",
    email: "dev.personal@example.com",
    plan: "max",
    home: `${HOME}/.local/share/agentbox/accounts/cl-personal`,
    isDefault: false,
    enabled: true,
    createdAt: T0 - 60 * D,
    auth: { state: "ok", expiresAt: T0 + 7 * H, detail: null },
    usage: usage("cl-personal", [
      win("five_hour", "short", "5-hour", 4, 4 * H + 41 * M),
      win("seven_day", "weekly", "Weekly", 88, 18 * H + 20 * M),
    ], { notes: ["Extra usage enabled: $40.00 of $100.00 monthly cap"] }),
  },
  {
    id: "cl-team",
    provider: "claude",
    label: "team-b",
    email: "dev@team-b.io",
    plan: "pro",
    home: `${HOME}/.local/share/agentbox/accounts/cl-team`,
    isDefault: false,
    enabled: true,
    createdAt: T0 - 20 * D,
    auth: { state: "expired", expiresAt: T0 - 40 * M, detail: "Access token expired 40 minutes ago; the next claude run on this account refreshes it." },
    usage: usage(
      "cl-team",
      [win("five_hour", "short", "5-hour", 83, 22 * M), win("seven_day", "weekly", "Weekly", 12, 5 * D + 2 * H)],
      { at: T0 - 47 * M, stale: "token expired", source: "cache" },
    ),
  },
  {
    id: "cl-new",
    provider: "claude",
    label: "claude #4",
    email: null,
    plan: null,
    home: `${HOME}/.local/share/agentbox/accounts/cl-new`,
    isDefault: false,
    enabled: true,
    createdAt: T0 - 3 * M,
    auth: { state: "missing", expiresAt: null, detail: "No credentials yet — finish the login below." },
    usage: usage("cl-new", [], { at: null, source: "none", stale: "not logged in" }),
  },
  {
    id: "cx-main",
    provider: "codex",
    label: "codex main",
    email: "dev@acme.dev",
    plan: "pro",
    home: `${HOME}/.codex`,
    isDefault: true,
    enabled: true,
    createdAt: T0 - 90 * D,
    auth: { state: "ok", expiresAt: null, detail: null },
    usage: usage("cx-main", [win("weekly", "weekly", "Weekly", 34, 4 * D + 3 * H)], { source: "rollout", at: T0 - 40 * 1000 }),
  },
  {
    id: "cx-alt",
    provider: "codex",
    label: "codex alt",
    email: "dev.alt@example.com",
    plan: "plus",
    home: `${HOME}/.local/share/agentbox/accounts/cx-alt`,
    isDefault: false,
    enabled: false,
    createdAt: T0 - 30 * D,
    auth: { state: "ok", expiresAt: null, detail: null },
    usage: usage("cx-alt", [win("weekly", "weekly", "Weekly", 97, 1 * D + 6 * H)], { source: "endpoint", at: T0 - 11 * M }),
  },
  {
    id: "dv-main",
    provider: "devin",
    label: "devin",
    email: "dev@acme.dev",
    plan: "Devin Max",
    home: `${HOME}/.local/share/devin`,
    isDefault: true,
    enabled: true,
    createdAt: T0 - 45 * D,
    auth: { state: "ok", expiresAt: null, detail: null },
    usage: usage("dv-main", [], { source: "none", at: null, notes: ["Devin does not publish rate-limit windows to this CLI version."] }),
  },
];

let logins: LoginFlow[] = [
  {
    id: "lg-1",
    provider: "claude",
    accountId: "cl-new",
    state: "awaiting-user",
    url: "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&state=Zk3r",
    userCode: null,
    needsPaste: true,
    output:
      "Opening browser to sign in…\nIf the browser didn't open, visit:\nhttps://claude.ai/oauth/authorize?code=true&client_id=9d1c…\n\nPaste code here if prompted > ",
    error: null,
    startedAt: T0 - 3 * M,
  },
  {
    id: "lg-2",
    provider: "codex",
    accountId: "cx-alt",
    state: "awaiting-user",
    url: "https://auth.openai.com/codex/device",
    userCode: "KQ7M-XW4P",
    needsPaste: false,
    output:
      "Welcome to Codex [v0.61.0]\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   KQ7M-XW4P\n",
    error: null,
    startedAt: T0 - 1 * M,
  },
];

// ------------------------------------------------------------- repos etc

const repos: Repo[] = [
  { id: "r-agentbox", ref: `${HOME}/Documents/agentbox`, kind: "local", displayName: "agentbox", fullName: "you/agentbox", defaultBranch: "v2", addedAt: T0 - 90 * D },
  { id: "r-switchyard", ref: `${HOME}/Documents/switchyard`, kind: "local", displayName: "switchyard", fullName: "you/switchyard", defaultBranch: "main", addedAt: T0 - 60 * D },
  { id: "r-web", ref: "acme/web", kind: "github", displayName: "web", fullName: "acme/web", defaultBranch: "main", addedAt: T0 - 12 * D },
];

const skills: SkillInfo[] = [
  { name: "agent-browser", description: "Browser automation CLI for AI agents: open pages, click, fill forms, screenshot.", source: "global", path: `${HOME}/.claude/skills/agent-browser`, lines: 212, modelInvocable: true },
  { name: "green-and-clean", description: "Take a referenced PR to merge-ready: fix CI, conflicts and every open review finding.", source: "global", path: `${HOME}/.claude/skills/green-and-clean`, lines: 148, modelInvocable: true, allowedTools: "Bash, Read, Edit" },
  { name: "babysit", description: "Sweep every open PR you authored and get the rest green.", source: "global", path: `${HOME}/.claude/skills/babysit`, lines: 64, modelInvocable: false },
  { name: "humanizer", description: "Rewrite AI-sounding text so it reads like the writer.", source: "agents", path: `${HOME}/.agents/skills/humanizer`, lines: 97, modelInvocable: true },
  { name: "rollout-reader", description: "Read a Codex rollout JSONL and summarise the turns.", source: "codex", path: `${HOME}/.codex/skills/rollout-reader`, lines: 41, modelInvocable: true },
  { name: "omp-fanout", description: "Dispatch a task across omp subagents and collect results.", source: "omp", path: `${HOME}/.omp/agent/skills/omp-fanout`, lines: 120, modelInvocable: true },
  { name: "release", description: "Cut a release: bump, changelog, tag, publish.", source: "project", repo: "agentbox", path: `${HOME}/Documents/agentbox/.claude/skills/release`, lines: 58, modelInvocable: false },
  { name: "schema-migrate", description: "Write and verify a sqlite migration for agentbox's db.", source: "project", repo: "agentbox", path: `${HOME}/Documents/agentbox/.claude/skills/schema-migrate`, lines: 77, modelInvocable: true },
];

// ------------------------------------------------------------- sessions

const ATTN: Record<AttentionKind, number> = { blocked: 0, waiting: 1, running: 2, stopped: 3, archived: 4 };

type MockSession = Session;

function sess(p: Partial<Session> & Pick<Session, "id" | "provider" | "status" | "host" | "title" | "cwd">): MockSession {
  const live = p.host !== "none";
  return {
    agentSessionId: crypto.randomUUID(),
    accountId: null,
    label: null,
    repoRoot: null,
    branch: null,
    worktree: null,
    model: null,
    firstPrompt: null,
    lastPrompt: null,
    lastMessage: null,
    contextUsed: null,
    contextLimit: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEquiv: 0 },
    big: false,
    claim: p.big ? settings.balancer.claimBig : settings.balancer.claimNormal,
    origin: "agentbox",
    pid: live ? 40000 + Math.floor(Math.random() * 20000) : null,
    tmux: p.host === "tmux" ? `ab-${p.id}` : null,
    transcriptPath: null,
    startedAt: T0 - 2 * H,
    lastActivityAt: T0 - 5 * M,
    archivedAt: null,
    ...p,
  };
}

const AB = `${HOME}/Documents/agentbox`;
const SY = `${HOME}/Documents/switchyard`;

const sessions: MockSession[] = [
  sess({
    id: "7fk2", provider: "claude", accountId: "cl-work", status: "running", host: "tmux",
    title: "Refactor balancer tie-break to prefer weekly-per-hour", cwd: `${AB}/.worktrees/balancer-ties`, repoRoot: `${AB}/.worktrees/balancer-ties`,
    branch: "feat/balancer-ties", worktree: `${AB}/.worktrees/balancer-ties`, model: "claude-fable-5-1",
    firstPrompt: "The balancer's tie-break should prefer the account with the most weekly left per hour until reset. Update balancer.ts and its tests.",
    lastMessage: "Running the balancer tests now — 14 of 16 pass; the two failures are the tie-band edge cases I expected.",
    contextUsed: 112_400, contextLimit: 200_000,
    tokens: { input: 48_210, output: 21_904, cacheRead: 1_840_000, cacheWrite: 92_000, costEquiv: 7.42 },
    startedAt: T0 - 48 * M, lastActivityAt: T0 - 8 * 1000,
  }),
  sess({
    id: "3mq9", provider: "claude", accountId: "cl-work", status: "blocked", host: "tmux", big: true, claim: 20,
    title: "Migrate usage_samples to the v2 schema", cwd: `${AB}/.worktrees/usage-schema`, repoRoot: `${AB}/.worktrees/usage-schema`,
    branch: "feat/usage-samples-v2", worktree: `${AB}/.worktrees/usage-schema`, model: "claude-fable-5-1",
    firstPrompt: "Write the migration for usage_samples: add window id, kind and scope columns; backfill from the old rows.",
    lastMessage: "Bash wants to run `rm -rf ~/.local/share/agentbox/test-db` — waiting for permission.",
    contextUsed: 71_000, contextLimit: 200_000,
    tokens: { input: 22_000, output: 9_800, cacheRead: 610_000, cacheWrite: 41_000, costEquiv: 3.18 },
    startedAt: T0 - 1.5 * H, lastActivityAt: T0 - 2 * M,
  }),
  sess({
    id: "a81c", provider: "codex", accountId: "cx-main", status: "waiting", host: "tmux",
    title: "Add wham/usage fallback for idle codex accounts", cwd: `${AB}/.worktrees/wham-usage`, repoRoot: `${AB}/.worktrees/wham-usage`,
    branch: "feat/wham-usage", worktree: `${AB}/.worktrees/wham-usage`, model: "gpt-5.4-codex",
    firstPrompt: "When a codex account has nothing running, read usage from chatgpt.com/backend-api/wham/usage.",
    lastMessage: "Done. `wham.ts` reads the endpoint with the account's auth.json token and maps `primary_window` to a weekly window. Want me to add the 429 backoff too?",
    contextUsed: 58_000, contextLimit: 272_000,
    tokens: { input: 31_000, output: 12_000, cacheRead: 390_000, cacheWrite: 0, costEquiv: 1.96 },
    startedAt: T0 - 3 * H, lastActivityAt: T0 - 14 * M,
  }),
  sess({
    id: "x4p0", provider: "claude", accountId: "cl-personal", status: "waiting", host: "tmux", label: "docs pass",
    title: "Tighten docs/v2.md wording around adopt", cwd: AB, repoRoot: AB, branch: "v2", model: "claude-fable-5-1",
    firstPrompt: "Read docs/v2.md and tighten the Adopt section. Keep the check-before-kill ordering explicit.",
    lastMessage: "I rewrote the Adopt paragraph into three numbered steps and moved \"Never kill first\" to the top. Diff is small — have a look?",
    contextUsed: 24_000, contextLimit: 200_000,
    tokens: { input: 9_000, output: 3_100, cacheRead: 120_000, cacheWrite: 18_000, costEquiv: 0.61 },
    startedAt: T0 - 5 * H, lastActivityAt: T0 - 41 * M,
  }),
  sess({
    id: "q2w8", provider: "claude", accountId: "cl-team", status: "running", host: "external", origin: "external", tmux: null,
    title: "Investigate flaky tmux paste-buffer test", cwd: SY, repoRoot: SY, branch: "main", model: "claude-fable-5-1",
    firstPrompt: "The tmux paste test fails one run in ten. Find out why.",
    lastMessage: "The flake is a race: `paste-buffer` lands before the pane has switched to bracketed-paste mode after a resize.",
    contextUsed: 151_000, contextLimit: 200_000,
    tokens: { input: 61_000, output: 18_000, cacheRead: 2_210_000, cacheWrite: 120_000, costEquiv: 9.87 },
    startedAt: T0 - 2.5 * H, lastActivityAt: T0 - 30 * 1000,
  }),
  sess({
    id: "k9d1", provider: "devin", accountId: "dv-main", status: "running", host: "tmux",
    title: "Port the login PTY to Bun.spawn with a terminal", cwd: `${AB}/.worktrees/login-pty`, repoRoot: `${AB}/.worktrees/login-pty`,
    branch: "feat/login-pty", worktree: `${AB}/.worktrees/login-pty`, model: "swe-1.6",
    lastMessage: "Spawning `claude auth login` under a PTY; capturing the URL from the first 4 KB of output.",
    contextUsed: 40_000, contextLimit: 128_000,
    tokens: { input: 14_000, output: 5_000, cacheRead: 0, cacheWrite: 0, costEquiv: 0.9 },
    startedAt: T0 - 22 * M, lastActivityAt: T0 - 3 * 1000,
  }),
  sess({
    id: "b8v7", provider: "codex", accountId: "cx-main", status: "running", host: "tmux", big: true, claim: 20,
    title: "Rewrite the transcript tailer around a record index", cwd: `${AB}/.worktrees/tailer`, repoRoot: `${AB}/.worktrees/tailer`,
    branch: "feat/tailer-index", worktree: `${AB}/.worktrees/tailer`, model: "gpt-5.4-codex",
    lastMessage: "Index built for 4,812 records in 38 ms; wiring `since` cursors next.",
    contextUsed: 190_000, contextLimit: 272_000,
    tokens: { input: 88_000, output: 30_000, cacheRead: 1_200_000, cacheWrite: 0, costEquiv: 6.4 },
    startedAt: T0 - 4 * H, lastActivityAt: T0 - 20 * 1000,
  }),
  sess({
    id: "e1w2", provider: "claude", accountId: "cl-work", status: "waiting", host: "external", origin: "external", tmux: null,
    title: "What's the fastest way to diff two sqlite schemas?", cwd: `${HOME}/scratch`, model: "claude-fable-5-1",
    lastMessage: "Use `sqldiff --schema a.db b.db` — it ships with sqlite and prints the DDL to turn one into the other.",
    contextUsed: 6_000, contextLimit: 200_000,
    tokens: { input: 2_000, output: 800, cacheRead: 12_000, cacheWrite: 4_000, costEquiv: 0.08 },
    startedAt: T0 - 70 * M, lastActivityAt: T0 - 66 * M,
  }),
  sess({
    id: "m3n5", provider: "codex", accountId: "cx-alt", status: "stopped", host: "none",
    title: "Bump vite to 7.1 and fix the proxy config", cwd: `${SY}/.worktrees/vite7`, repoRoot: `${SY}/.worktrees/vite7`,
    branch: "chore/vite-7", worktree: `${SY}/.worktrees/vite7`, model: "gpt-5.4-codex",
    lastMessage: "Build passes on vite 7.1.9. The ws proxy needed `ws: true` on the /ws entry.",
    contextUsed: 33_000, contextLimit: 272_000,
    tokens: { input: 12_000, output: 4_000, cacheRead: 90_000, cacheWrite: 0, costEquiv: 0.7 },
    startedAt: T0 - 1.2 * D, lastActivityAt: T0 - 1 * D,
  }),
  sess({
    id: "p0o9", provider: "claude", accountId: "cl-work", status: "stopped", host: "none",
    title: "Write the calibration regression for 5h→weekly", cwd: `${AB}/.worktrees/calibration`, repoRoot: `${AB}/.worktrees/calibration`,
    branch: "feat/calibration", worktree: `${AB}/.worktrees/calibration`, model: "claude-fable-5-1",
    lastMessage: "Least-squares fit through the origin gives 21.4 points per full 5-hour window, r² 0.83 on 312 intervals.",
    contextUsed: 88_000, contextLimit: 200_000,
    tokens: { input: 40_000, output: 16_000, cacheRead: 900_000, cacheWrite: 60_000, costEquiv: 4.1 },
    startedAt: T0 - 2 * D, lastActivityAt: T0 - 19 * H,
  }),
  sess({
    id: "z7y6", provider: "omp", accountId: null, status: "stopped", host: "none",
    title: "Fan-out: audit every route for the x-agentbox header", cwd: AB, repoRoot: AB, branch: "main", model: "anthropic/claude-sonnet-4.5",
    lastMessage: "12 of 12 subagents reported. 3 routes were missing the header check; patched in guard.ts.",
    tokens: { input: 120_000, output: 44_000, cacheRead: 0, cacheWrite: 0, costEquiv: 3.3 },
    startedAt: T0 - 3 * D, lastActivityAt: T0 - 3 * D + 40 * M,
  }),
  sess({
    id: "r5t4", provider: "claude", accountId: "cl-personal", status: "archived", host: "none",
    title: "Spike: xterm.js in React 19", cwd: `${HOME}/scratch/xterm-spike`, model: "claude-fable-5-1",
    lastMessage: "The addon-fit needs the container to have a real height before `fit()`; a ResizeObserver solves it.",
    tokens: { input: 8_000, output: 3_000, cacheRead: 40_000, cacheWrite: 9_000, costEquiv: 0.4 },
    startedAt: T0 - 4 * D, lastActivityAt: T0 - 4 * D + 2 * H, archivedAt: T0 - 3 * D,
  }),
];

const REASON: Record<AttentionKind, (s: Session) => string> = {
  blocked: () => "Waiting on a permission prompt",
  waiting: (s) => (s.host === "external" ? "Turn over, in another terminal" : "Turn over — your move"),
  running: () => "Working",
  stopped: () => "No process — resumable",
  archived: () => "Archived",
};

function attentionOf(s: Session): Attention {
  const kind: AttentionKind = s.status;
  return { kind, rank: ATTN[kind], reason: REASON[kind](s) };
}

// ------------------------------------------------------------- claims & balancer

/** Mock consumption: a session has used a fraction of its claim, by age. */
function claimsFor(accountId: string): ClaimView[] {
  return sessions
    .filter((s) => s.accountId === accountId && (s.status === "running" || s.status === "waiting" || s.status === "blocked"))
    .map((s) => {
      const consumed = Math.min(s.claim * 1.3, (s.tokens.costEquiv / 10) * s.claim * 0.8);
      const lapsed = T0 - s.lastActivityAt > settings.balancer.claimIdleMin * M;
      const outstanding = lapsed ? 0 : Math.max(0, s.claim - consumed);
      return {
        sessionId: s.id,
        title: s.label ?? s.title,
        big: s.big,
        claim: s.claim,
        consumed: Math.round(consumed * 10) / 10,
        outstanding: Math.round(outstanding * 10) / 10,
        lapsed,
      };
    });
}

function candidateFor(a: MockAccount, big: boolean, now: number): Candidate {
  const b = settings.balancer;
  const claims = claimsFor(a.id);
  const outstanding = claims.reduce((n, c) => n + c.outstanding, 0);
  const weeklyW = a.usage.windows.find((w) => w.kind === "weekly" && !w.scope) ?? null;
  const shortW = a.usage.windows.find((w) => w.kind === "short") ?? null;
  const weekly = weeklyW?.usedPct ?? null;
  const weeklyEffective = weekly == null ? null : weekly + outstanding;
  const short = shortW?.usedPct ?? null;
  const shortEffective = short == null ? null : short + (outstanding * 100) / b.shortWindowInWeekly;
  let legRoom: number | null = null;
  if (shortEffective != null) {
    legRoom = Math.max(0, 100 - shortEffective);
    const toReset = shortW?.resetsAt != null ? (shortW.resetsAt - now) / M : Infinity;
    if (toReset < b.resetHorizonMin) legRoom += (100 - legRoom) * (1 - toReset / b.resetHorizonMin);
  }
  const hoursToWeekly = weeklyW?.resetsAt != null ? Math.max(1, (weeklyW.resetsAt - now) / H) : null;
  const weeklyPerHour = weeklyEffective != null && hoursToWeekly != null ? Math.max(0, 100 - weeklyEffective) / hoursToWeekly : null;

  let eligible = true;
  let reason: string | null = null;
  if (!a.enabled) {
    eligible = false;
    reason = "Disabled — the balancer never places here.";
  } else if (a.auth.state === "missing") {
    eligible = false;
    reason = "Not logged in.";
  } else if (weeklyEffective != null && weeklyEffective >= 100) {
    eligible = false;
    reason = `Weekly is ${Math.round(weeklyEffective)} with claims — over 100.`;
  } else if (weeklyEffective != null && weeklyEffective + (big ? b.claimBig : b.claimNormal) > 100) {
    eligible = false;
    reason = `A ${big ? "Big" : "normal"} claim would take weekly past 100.`;
  }
  const score =
    a.provider === "claude" && legRoom != null
      ? legRoom + (weeklyPerHour ?? 0) / 10
      : weeklyPerHour != null
        ? weeklyPerHour * 10
        : 0;
  return {
    accountId: a.id,
    label: a.label,
    eligible,
    reason,
    weekly,
    weeklyEffective,
    weeklyResetsAt: weeklyW?.resetsAt ?? null,
    short,
    shortEffective,
    shortResetsAt: shortW?.resetsAt ?? null,
    legRoom,
    weeklyPerHour,
    outstanding,
    score: eligible ? score : score - 1000,
  };
}

function placementFor(provider: ProviderId, big: boolean, manual?: string): Placement {
  const now = Date.now();
  const candidates = accounts.filter((a) => a.provider === provider).map((a) => candidateFor(a, big, now));
  const best = [...candidates].filter((c) => c.eligible).sort((a, b) => b.score - a.score)[0] ?? null;
  const claim = big ? settings.balancer.claimBig : settings.balancer.claimNormal;
  if (manual && manual !== "auto") {
    const c = candidates.find((x) => x.accountId === manual);
    return { provider, accountId: manual, mode: "manual", big, claim, candidates, why: `You picked ${c?.label ?? manual}.` };
  }
  if (!best) {
    return {
      provider,
      accountId: null,
      mode: "none",
      big,
      claim,
      candidates,
      why: candidates.length === 0 ? `No ${provider} account is set up.` : "Every account is over its weekly with claims counted. Pick one by hand to override.",
    };
  }
  const second = [...candidates].filter((c) => c.eligible && c.accountId !== best.accountId).sort((a, b) => b.score - a.score)[0];
  const why =
    provider === "claude" && best.legRoom != null
      ? second && second.legRoom != null && Math.abs(second.legRoom - best.legRoom) <= settings.balancer.tieBand
        ? `${best.label} and ${second.label} are within ${settings.balancer.tieBand} points of 5-hour room; ${best.label} has more weekly left per hour until its reset.`
        : `${best.label} has the most 5-hour room after claims (${Math.round(best.legRoom)} vs ${second?.legRoom != null ? Math.round(second.legRoom) : "—"}).`
      : `${best.label} has the most weekly left per hour until its reset (${best.weeklyPerHour?.toFixed(2)}/h).`;
  return { provider, accountId: best.accountId, mode: "auto", big, claim, candidates, why };
}

function accountViews(): AccountView[] {
  const now = Date.now();
  return accounts.map((a) => ({ ...a, claims: claimsFor(a.id), placement: candidateFor(a, false, now) }));
}

// ------------------------------------------------------------- state

function hot(): HotState {
  return { sessions: sessions.map((s) => ({ ...s, attention: attentionOf(s) })), serverTime: Date.now() };
}

function cold(): ColdState {
  return {
    accounts: accountViews(),
    logins: logins.slice(),
    repos: repos.slice(),
    prs: [
      {
        number: 212, repo: "you/agentbox", title: "Read codex usage from wham when nothing is running", headRef: "feat/wham-usage",
        state: "OPEN", isDraft: true, url: "https://github.com/you/agentbox/pull/212", author: "you",
        createdAt: new Date(T0 - 2 * H).toISOString(), updatedAt: new Date(T0 - 20 * M).toISOString(), sessionId: "a81c",
      },
    ],
    skills,
    settings: structuredClone(settings),
    providers: [
      { id: "claude", installed: true, version: "2.3.1" },
      { id: "codex", installed: true, version: "0.61.0" },
      { id: "devin", installed: true, version: "1.4.2" },
      { id: "omp", installed: false, version: null },
    ],
    warnings: [],
  };
}

function appState(): AppState {
  return { ...cold(), ...hot() };
}

// ------------------------------------------------------------- metrics

let sys: SystemState = {
  at: T0,
  cores: 16,
  perCore: Array.from({ length: 16 }, () => Math.random() * 0.5),
  cpu: 0.31,
  mhz: 3400,
  mhzMax: 5100,
  memTotal: 64 * 1024 ** 3,
  memAvailable: 38 * 1024 ** 3,
  memCache: 14 * 1024 ** 3,
  swapTotal: 8 * 1024 ** 3,
  swapUsed: 0.4 * 1024 ** 3,
  load1: 4.2,
  load5: 3.8,
  load15: 3.1,
  runnable: 3,
  psiCpu: 6,
  psiIo: 1,
  psiMem: 0,
  temps: [{ name: "cpu", celsius: 64, critical: 100, pressure: 0.64 }, { name: "nvme", celsius: 44, critical: 84, pressure: 0.52 }],
  throttleDuty: 0,
  throttling: false,
  diskFree: 212 * 1024 ** 3,
  diskTotal: 953 * 1024 ** 3,
  acOnline: true,
  batteryPct: 87,
  batteryStatus: "Charging",
  watts: 18,
};

const loadHist = new Map<string, number[]>();

function metrics(): MetricsState {
  const walk = (v: number, lo: number, hi: number, step: number) => Math.min(hi, Math.max(lo, v + (Math.random() - 0.5) * step));
  const perCore = sys.perCore.map((v) => walk(v, 0.02, 1, 0.3));
  sys = {
    ...sys,
    at: Date.now(),
    perCore,
    cpu: perCore.reduce((a, b) => a + b, 0) / perCore.length,
    load1: walk(sys.load1, 1, 12, 1),
    psiCpu: walk(sys.psiCpu ?? 5, 0, 40, 4),
    memAvailable: walk(sys.memAvailable, 30 * 1024 ** 3, 44 * 1024 ** 3, 1024 ** 3),
    temps: sys.temps.map((t) => (t.name === "cpu" ? { ...t, celsius: walk(t.celsius, 50, 88, 4), pressure: t.celsius / 100 } : t)),
  };
  const load: Record<string, LoadSample> = {};
  for (const s of sessions) {
    if (s.host === "none") continue;
    const busy = s.status === "running";
    const h = loadHist.get(s.id) ?? Array.from({ length: 20 }, () => (busy ? Math.random() * 120 : Math.random() * 4));
    const next = busy ? Math.max(0, walk(h[h.length - 1], 0, 380, 120)) : Math.random() * 3;
    h.push(next);
    while (h.length > 24) h.shift();
    loadHist.set(s.id, h);
    load[s.id] = {
      cpuPct: next,
      memBytes: (busy ? 900 : 420) * 1024 ** 2 + (s.id.charCodeAt(0) % 7) * 80 * 1024 ** 2,
      memKind: "pss",
      procs: busy ? 6 + (s.id.charCodeAt(1) % 5) : 3,
      history: h.slice(),
      ...(s.id === "b8v7" ? { backgroundShells: 1 } : {}),
    };
  }
  return { at: Date.now(), system: sys, load };
}

// ------------------------------------------------------------- timelines

const timelines = new Map<string, TimelineEvent[]>();

function makeTimeline(s: Session): TimelineEvent[] {
  const ev: TimelineEvent[] = [];
  let t = s.startedAt;
  let n = 0;
  const id = () => `${s.id}-e${String(++n).padStart(3, "0")}`;
  const step = (ms: number) => (t += ms);
  const first = s.firstPrompt ?? s.title;
  ev.push({ id: id(), at: step(0), kind: "meta", text: `Started on ${s.accountId ?? "the default account"} · ${s.model ?? "default model"} · ${s.cwd}` });
  ev.push({ id: id(), at: step(4000), kind: "user", text: first });
  // Enough rounds that the first page does not hold the whole history.
  const rounds = 9;
  for (let r = 0; r < rounds; r++) {
    ev.push({
      id: id(), at: step(3000), kind: "thinking",
      text: r === 0
        ? "Let me look at how candidates are ranked today. The tie band is applied to leg room, and within a tie the code currently picks the lowest weekly used — which is not the same as most weekly left per hour, because reset times differ.\n\nI should read balancer.ts and the tests first."
        : `Round ${r + 1}: checking whether the previous change broke anything in the fixtures, then moving on to the next file.`,
    });
    ev.push({ id: id(), at: step(1200), kind: "tool", name: "Read", summary: "src/core/balancer.ts", input: '{\n  "file_path": "src/core/balancer.ts"\n}', output: "  1\t/** Placing a new session. Pure. */\n  2\timport type { Candidate } from \"./types\";\n  …\n214\texport function place(…)", status: "ok" });
    ev.push({ id: id(), at: step(900), kind: "tool", name: "Grep", summary: 'tieBand in src/', input: '{\n  "pattern": "tieBand",\n  "path": "src/"\n}', output: "src/core/balancer.ts:88:  const band = cfg.tieBand;\nsrc/core/types.ts:131:  tieBand: number;", status: "ok" });
    if (r % 3 === 1) {
      ev.push({ id: id(), at: step(2500), kind: "tool", name: "Bash", summary: "bun test src/core/__tests__/balancer.test.ts", input: "bun test src/core/__tests__/balancer.test.ts", output: "bun test v1.3.6\n\nsrc/core/__tests__/balancer.test.ts:\n✓ worked example: A, A, then B [0.41ms]\n✗ tie goes to most weekly per hour [0.22ms]\n  expected \"B\" received \"A\"\n\n 14 pass\n 2 fail", status: "error" });
    }
    ev.push({ id: id(), at: step(1800), kind: "tool", name: "Edit", summary: "src/core/balancer.ts (+12 −4)", input: "--- a/src/core/balancer.ts\n+++ b/src/core/balancer.ts\n@@ -86,8 +86,16 @@\n-  tied.sort((a, b) => a.weekly - b.weekly);\n+  tied.sort((a, b) => (b.weeklyPerHour ?? 0) - (a.weeklyPerHour ?? 0));", status: "ok" });
    ev.push({
      id: id(), at: step(2200), kind: "assistant",
      text: r === rounds - 1
        ? (s.lastMessage ?? "Done.")
        : r === 0
          ? "The tie-break sorts tied candidates by **weekly used**, not weekly left per hour. Those differ whenever reset times differ:\n\n| account | weekly | resets in | left/h |\n|---|---|---|---|\n| A | 60 | 12h | 3.3 |\n| B | 40 | 6d | 0.4 |\n\nA should win the tie. I'll change the sort key and add a test for this case."
          : `Pass ${r + 1} done. \`balancer.ts\` now computes \`weeklyPerHour\` once per candidate and the tie sort uses it.`,
    });
    if (r === 4) ev.push({ id: id(), at: step(500), kind: "meta", text: "Context compacted — 142k → 38k tokens", tone: "info" });
  }
  if (s.status === "blocked") {
    ev.push({ id: id(), at: step(1500), kind: "tool", name: "Bash", summary: "rm -rf ~/.local/share/agentbox/test-db", input: "rm -rf ~/.local/share/agentbox/test-db", status: "running" });
    ev.push({ id: id(), at: step(200), kind: "meta", text: "Permission requested: Bash(rm -rf ~/.local/share/agentbox/test-db)", tone: "warn" });
  }
  if (s.status === "stopped") ev.push({ id: id(), at: step(60_000), kind: "meta", text: "Process exited (code 0). Resume continues this conversation on the same account.", tone: "info" });
  // Shift so the last event lands at lastActivityAt.
  const shift = s.lastActivityAt - t;
  return ev.map((e) => ({ ...e, at: e.at + shift }));
}

function timelineOf(id: string): TimelineEvent[] {
  let tl = timelines.get(id);
  if (!tl) {
    const s = sessions.find((x) => x.id === id);
    tl = s ? makeTimeline(s) : [];
    timelines.set(id, tl);
  }
  return tl;
}

const PAGE = 24;

function pageBefore(id: string, before: string | null, limit: number): TimelinePage {
  const tl = timelineOf(id);
  const end = before ? Math.max(0, tl.findIndex((e) => e.id === before)) : tl.length;
  const start = Math.max(0, end - limit);
  return { events: tl.slice(start, end), before: start > 0 ? tl[start].id : null, cursor: tl[tl.length - 1]?.id ?? "" };
}

// ------------------------------------------------------------- the socket

type Listener = (m: ServerMessage) => void;
const listeners = new Set<Listener>();
let watching: string | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let liveTimer: ReturnType<typeof setInterval> | null = null;

function emit(m: ServerMessage): void {
  for (const l of listeners) l(m);
}
const pushHot = () => emit({ type: "hot", state: hot() });
const pushCold = () => emit({ type: "cold", state: cold() });

function startLive(sessionId: string): void {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  const s = sessions.find((x) => x.id === sessionId);
  if (!s || s.status !== "running") return;
  let k = 0;
  const cmds = ["bun test src/core", "git diff --stat", "rg -n weeklyPerHour src/", "bunx tsc --noEmit -p ."];
  liveTimer = setInterval(() => {
    if (watching !== sessionId) return;
    const tl = timelineOf(sessionId);
    const eid = `${sessionId}-live${++k}`;
    const cmd = cmds[k % cmds.length];
    const running: TimelineEvent = { id: eid, at: Date.now(), kind: "tool", name: "Bash", summary: cmd, input: cmd, status: "running" };
    tl.push(running);
    emit({ type: "timeline", sessionId, events: [running], cursor: eid, reset: false });
    setTimeout(() => {
      const done: TimelineEvent = { ...running, status: "ok", output: `$ ${cmd}\n… ${10 + k} lines …\nok` };
      tl[tl.findIndex((e) => e.id === eid)] = done;
      emit({ type: "timeline", sessionId, events: [done], cursor: eid, reset: false });
      s.lastActivityAt = Date.now();
      pushHot();
    }, 1600);
  }, 6000);
}

// ------------------------------------------------------------- terminal

const ESC = "\x1b[";
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const fg = (c: number, s: string) => `${ESC}38;5;${c}m${s}${ESC}0m`;

function screenFor(s: Session): string {
  const lines: string[] = [];
  const title = s.label ?? s.title;
  if (s.provider === "codex") {
    lines.push(`${fg(245, "╭──────────────────────────────────────────────────╮")}`);
    lines.push(`${fg(245, "│")} ${bold(">_ OpenAI Codex")} ${dim("(v0.61.0)")}                     ${fg(245, "│")}`);
    lines.push(`${fg(245, "│")} ${dim("model:")} ${s.model}   ${dim("/model to change")}      ${fg(245, "│")}`);
    lines.push(`${fg(245, "│")} ${dim("directory:")} ${s.cwd.replace(HOME, "~").slice(0, 36).padEnd(36)} ${fg(245, "│")}`);
    lines.push(`${fg(245, "╰──────────────────────────────────────────────────╯")}`);
  } else {
    lines.push(`${fg(209, "╭───────────────────────────────────────────────────╮")}`);
    lines.push(`${fg(209, "│")} ${fg(209, "✻")} Welcome to ${bold("Claude Code")}!                         ${fg(209, "│")}`);
    lines.push(`${fg(209, "│")}                                                   ${fg(209, "│")}`);
    lines.push(`${fg(209, "│")}   ${dim("cwd: " + s.cwd.replace(HOME, "~").slice(0, 42).padEnd(42))}  ${fg(209, "│")}`);
    lines.push(`${fg(209, "╰───────────────────────────────────────────────────╯")}`);
  }
  lines.push("");
  lines.push(`${fg(245, ">")} ${s.firstPrompt ?? title}`);
  lines.push("");
  lines.push(`${fg(15, "●")} I'll start by reading the balancer and its tests.`);
  lines.push("");
  lines.push(`${fg(34, "●")} ${bold("Read")}(src/core/balancer.ts)`);
  lines.push(`  ${dim("⎿  Read 214 lines")}`);
  lines.push("");
  lines.push(`${fg(34, "●")} ${bold("Bash")}(bun test src/core/__tests__/balancer.test.ts)`);
  lines.push(`  ${dim("⎿")}  ${fg(34, "14 pass")}`);
  lines.push(`     ${fg(160, "2 fail")}`);
  lines.push("");
  lines.push(`${fg(15, "●")} ${s.lastMessage ?? "Working on it."}`);
  lines.push("");
  if (s.status === "blocked") {
    lines.push(`${fg(214, "╭───────────────────────────────────────────────────╮")}`);
    lines.push(`${fg(214, "│")} ${bold("Bash command")}                                      ${fg(214, "│")}`);
    lines.push(`${fg(214, "│")}   rm -rf ~/.local/share/agentbox/test-db          ${fg(214, "│")}`);
    lines.push(`${fg(214, "│")}                                                   ${fg(214, "│")}`);
    lines.push(`${fg(214, "│")} Do you want to proceed?                           ${fg(214, "│")}`);
    lines.push(`${fg(214, "│")} ${fg(39, "❯ 1. Yes")}                                          ${fg(214, "│")}`);
    lines.push(`${fg(214, "│")}   2. Yes, and don't ask again for rm commands     ${fg(214, "│")}`);
    lines.push(`${fg(214, "│")}   3. No, and tell Claude what to do differently   ${fg(214, "│")}`);
    lines.push(`${fg(214, "╰───────────────────────────────────────────────────╯")}`);
  } else {
    if (s.status === "running") lines.push(`${fg(209, "✻")} ${fg(209, "Pondering…")} ${dim("(48s · ↓ 2.1k tokens · esc to interrupt)")}`);
    lines.push("");
    lines.push(fg(240, "╭───────────────────────────────────────────────────╮"));
    lines.push(`${fg(240, "│")} > `);
  }
  return lines.join("\r\n");
}

function term(sessionId: string, h: TermHandlers): TermChannel {
  const s = sessions.find((x) => x.id === sessionId);
  const enc = new TextEncoder();
  let open = true;
  const write = (str: string) => open && h.onOutput(enc.encode(str));
  setTimeout(() => {
    if (!open) return;
    h.onOpen();
    write(`${ESC}2J${ESC}H`);
    write(s ? screenFor(s) : "no such session");
  }, 120);
  return {
    send(data) {
      // Echo printable input so typing feels connected; Enter starts a fake turn.
      if (data === "\r") {
        write(`\r\n${fg(209, "✻")} ${dim("Thinking… (mock — nothing is running)")}\r\n${fg(240, "│")} > `);
      } else if (data === "\x7f") {
        write("\b \b");
      } else if (!data.startsWith("\x1b")) {
        write(data);
      }
    },
    resize() {
      /* a real tmux reflows; the mock screen is fixed text */
    },
    close() {
      open = false;
    },
  };
}

// ------------------------------------------------------------- requests

function deepMerge<T extends object>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object") return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" ? deepMerge(cur as object, v) : v;
  }
  return out as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function body<T>(b: unknown): Partial<T> {
  return (b && typeof b === "object" ? b : {}) as Partial<T>;
}

function mustSession(id: string): Session {
  const s = sessions.find((x) => x.id === id);
  if (!s) throw new Error(`no session ${id}`);
  return s;
}

function mustAccount(id: string): MockAccount {
  const a = accounts.find((x) => x.id === id);
  if (!a) throw new Error(`no account ${id}`);
  return a;
}

const diff: SessionDiff = {
  base: "v2",
  additions: 31,
  deletions: 9,
  unavailable: false,
  files: [
    {
      path: "src/core/balancer.ts", status: "modified", additions: 22, deletions: 7,
      patch: "diff --git a/src/core/balancer.ts b/src/core/balancer.ts\nindex 3f2a1b0..8c9d4e2 100644\n--- a/src/core/balancer.ts\n+++ b/src/core/balancer.ts\n@@ -84,12 +84,20 @@ export function place(accounts: AccountState[], cfg: BalancerSettings): Placement {\n   const best = Math.max(...eligible.map((c) => c.legRoom ?? 0));\n   const band = cfg.tieBand;\n   const tied = eligible.filter((c) => (c.legRoom ?? 0) >= best - band);\n-  tied.sort((a, b) => a.weekly - b.weekly);\n-  const chosen = tied[0];\n+  // Use it or lose it: the tie goes to the account with the most weekly left\n+  // per hour until its weekly reset, not the one with the least used.\n+  tied.sort((a, b) => (b.weeklyPerHour ?? 0) - (a.weeklyPerHour ?? 0));\n+  const chosen = tied[0];\n+  const runnerUp = tied[1] ?? null;\n   return {\n     accountId: chosen.accountId,\n-    why: `${chosen.label} has the most room.`,\n+    why: runnerUp\n+      ? `${chosen.label} and ${runnerUp.label} are tied on 5-hour room; ${chosen.label} has more weekly left per hour.`\n+      : `${chosen.label} has the most 5-hour room after claims.`,\n",
    },
    {
      path: "src/core/__tests__/balancer.test.ts", status: "modified", additions: 9, deletions: 2,
      patch: "--- a/src/core/__tests__/balancer.test.ts\n+++ b/src/core/__tests__/balancer.test.ts\n@@ -40,6 +40,13 @@ describe(\"place\", () => {\n+  test(\"tie goes to most weekly per hour\", () => {\n+    const a = acct(\"A\", { weekly: 60, weeklyResetsIn: 12 * H, short: 10 });\n+    const b = acct(\"B\", { weekly: 40, weeklyResetsIn: 6 * D, short: 12 });\n+    expect(place([a, b], cfg).accountId).toBe(\"A\");\n+  });\n",
    },
  ],
};

const procs: ProcDetail[] = [
  { pid: 48211, ppid: 48200, name: "claude", cmd: "claude --resume 1d8e…", role: "agent", cpuPct: 38, rssBytes: 612 * 1024 ** 2, pssBytes: 540 * 1024 ** 2, depth: 0, ageMs: 48 * M },
  { pid: 48230, ppid: 48211, name: "node", cmd: "node ~/.claude/mcp/github/index.js", role: "mcp", cpuPct: 0.4, rssBytes: 96 * 1024 ** 2, pssBytes: 71 * 1024 ** 2, depth: 1, ageMs: 48 * M },
  { pid: 49102, ppid: 48211, name: "bash", cmd: "bash -c bun test src/core", role: "tool", cpuPct: 4, rssBytes: 6 * 1024 ** 2, pssBytes: 3 * 1024 ** 2, depth: 1, ageMs: 9000 },
  { pid: 49103, ppid: 49102, name: "bun", cmd: "bun test src/core", role: "tool", cpuPct: 187, rssBytes: 310 * 1024 ** 2, pssBytes: 288 * 1024 ** 2, depth: 2, ageMs: 8800 },
];

const worktreeScan = (): WorktreeScan => ({
  scannedAt: Date.now(),
  ghUnavailable: false,
  items: [
    { path: AB, repoId: "r-agentbox", repoName: "agentbox", branch: "v2", bytes: 412 * 1024 ** 2, isMain: true, ours: false, missing: false, sessionId: null, sessionTitle: null, live: false, pr: "none", verdict: { safe: false, reason: "main", detail: "The repo's own checkout — never removed." } },
    { path: `${AB}/.worktrees/balancer-ties`, repoId: "r-agentbox", repoName: "agentbox", branch: "feat/balancer-ties", bytes: 388 * 1024 ** 2, isMain: false, ours: true, missing: false, sessionId: "7fk2", sessionTitle: "Refactor balancer tie-break", live: true, pr: "none", verdict: { safe: false, reason: "live", detail: "A running session is using it." } },
    { path: `${AB}/.worktrees/old-router`, repoId: "r-agentbox", repoName: "agentbox", branch: "feat/router", bytes: 402 * 1024 ** 2, isMain: false, ours: true, missing: false, sessionId: null, sessionTitle: null, live: false, pr: "merged", verdict: { safe: true, reason: "merged", detail: "PR #188 merged; the worktree is clean." } },
    { path: `${SY}/.worktrees/vite7`, repoId: "r-switchyard", repoName: "switchyard", branch: "chore/vite-7", bytes: 520 * 1024 ** 2, isMain: false, ours: true, missing: false, sessionId: "m3n5", sessionTitle: "Bump vite", live: false, pr: "none", verdict: { safe: false, reason: "ahead", detail: "3 commits not on main and not pushed." } },
  ],
});

function calibration(days: number): CalibrationReport {
  return {
    days,
    shortWindowInWeekly: { estimate: 21.4, samples: 312 * (days / 7), r2: 0.83 },
    sessionUse: {
      normal: { p50: 3.1, p75: 5.8, p90: 9.4, samples: 64 },
      big: { p50: 14.2, p75: 22.5, p90: 31.0, samples: 9 },
    },
    placements: 73,
    hitAfterPlacement: 4,
    suggested: { shortWindowInWeekly: 21.4, claimNormal: 6, claimBig: 23 },
    current: structuredClone(settings.balancer) as BalancerSettings,
  };
}

async function handle(method: string, path: string, b: unknown): Promise<unknown> {
  const url = new URL(path, "http://mock");
  const p = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
  const [, head, id, action] = p;

  if (method === "GET") {
    if (head === "state") return appState();
    if (head === "health")
      return {
        claude: { state: "ok", detail: "2.3.1 (Claude Code)" },
        codex: { state: "ok", detail: "codex-cli 0.61.0" },
        devin: { state: "ok", detail: "devin 1.4.2" },
        omp: { state: "missing", detail: "omp is not on PATH." },
        tmux: { state: "ok", detail: "tmux 3.5a" },
        gh: { state: "unusable", detail: "gh is installed but not logged in — run `gh auth login`." },
        git: { state: "ok", detail: "git version 2.51.0" },
        at: Date.now(),
      };
    if (head === "accounts") return accountViews();
    if (head === "calibration") return calibration(Number(url.searchParams.get("days") ?? 7));
    if (head === "settings") return structuredClone(settings);
    if (head === "repos") return repos;
    if (head === "skill") return { body: `---\nname: example\ndescription: A mock skill body.\n---\n\n# Example\n\nThis is what SKILL.md would contain.\n` };
    if (head === "sessions" && action === "timeline") {
      await sleep(350);
      return pageBefore(id, url.searchParams.get("before"), Number(url.searchParams.get("limit") ?? PAGE));
    }
    if (head === "sessions" && action === "diff") return diff;
    if (head === "sessions" && action === "load") return procs;
    throw new Error(`mock: no GET ${path}`);
  }

  await sleep(head === "placement" ? 220 : 120);

  if (head === "placement") {
    const x = body<{ provider: ProviderId; big: boolean }>(b);
    return placementFor(x.provider ?? "claude", !!x.big);
  }

  if (head === "sessions" && !id) {
    const x = body<{ provider: ProviderId; cwd: string; repoId: string; worktree: boolean; prompt: string; model: string; big: boolean; accountId: string }>(b);
    const provider = x.provider ?? "claude";
    const placement = placementFor(provider, !!x.big, x.accountId);
    const repo = repos.find((r) => r.id === x.repoId);
    const nid = Math.random().toString(36).slice(2, 6);
    const cwd = repo ? (x.worktree ? `${repo.ref}/.worktrees/${nid}` : repo.ref) : x.cwd || HOME;
    const s = sess({
      id: nid, provider, accountId: placement.accountId, status: "running", host: "tmux",
      title: (x.prompt ?? "").split("\n")[0].slice(0, 70) || "New session", cwd, repoRoot: repo ? cwd : null,
      branch: repo ? (x.worktree ? `agentbox/${nid}` : repo.defaultBranch) : null, worktree: repo && x.worktree ? cwd : null,
      model: x.model || settings.models[provider] || null, firstPrompt: x.prompt || null, big: !!x.big,
      startedAt: Date.now(), lastActivityAt: Date.now(), contextUsed: 0, contextLimit: 200_000,
    });
    sessions.unshift(s);
    pushHot();
    pushCold();
    return { session: s, placement };
  }

  if (head === "sessions" && id) {
    const s = mustSession(id);
    const x = body<{ label: string | null; big: boolean; text: string; keys: string[]; prompt: string; archived: boolean }>(b);
    switch (method === "PATCH" ? "patch" : action) {
      case "patch":
        if ("label" in x) s.label = x.label?.trim() ? x.label.trim() : null;
        if (typeof x.big === "boolean") {
          s.big = x.big;
          s.claim = x.big ? settings.balancer.claimBig : settings.balancer.claimNormal;
        }
        break;
      case "send": {
        const tl = timelineOf(id);
        tl.push({ id: `${id}-u${tl.length}`, at: Date.now(), kind: "user", text: x.text ?? "" });
        if (watching === id) emit({ type: "timeline", sessionId: id, events: [tl[tl.length - 1]], cursor: "", reset: false });
        s.status = "running";
        s.lastPrompt = x.text ?? null;
        s.lastActivityAt = Date.now();
        break;
      }
      case "keys":
      case "interrupt":
        if (action === "interrupt" || x.keys?.includes("Escape")) s.status = s.status === "running" ? "waiting" : s.status;
        break;
      case "resume":
        s.status = x.prompt ? "running" : "waiting";
        s.host = "tmux";
        s.tmux = `ab-${s.id}`;
        s.pid = 50000 + Math.floor(Math.random() * 9999);
        s.archivedAt = null;
        s.lastActivityAt = Date.now();
        break;
      case "adopt":
        await sleep(600);
        s.host = "tmux";
        s.tmux = `ab-${s.id}`;
        s.origin = "external";
        break;
      case "stop":
        s.status = "stopped";
        s.host = "none";
        s.pid = null;
        s.tmux = null;
        break;
      case "archive":
        s.status = x.archived ? "archived" : "stopped";
        s.archivedAt = x.archived ? Date.now() : null;
        if (x.archived) {
          s.host = "none";
          s.pid = null;
        }
        break;
      default:
        throw new Error(`mock: no ${method} ${path}`);
    }
    pushHot();
    pushCold();
    return s;
  }

  if (head === "accounts") {
    if (!id) {
      const x = body<{ provider: ProviderId; label: string }>(b);
      const provider = x.provider ?? "claude";
      const aid = `${provider.slice(0, 2)}-${Math.random().toString(36).slice(2, 6)}`;
      const acc: MockAccount = {
        id: aid, provider, label: x.label || `${provider} #${accounts.filter((a) => a.provider === provider).length + 1}`,
        email: null, plan: null, home: `${HOME}/.local/share/agentbox/accounts/${aid}`, isDefault: false, enabled: true, createdAt: Date.now(),
        auth: { state: "missing", expiresAt: null, detail: "No credentials yet — finish the login below." },
        usage: usage(aid, [], { at: null, source: "none", stale: "not logged in" }),
      };
      accounts.push(acc);
      const login: LoginFlow = {
        id: `lg-${aid}`, provider, accountId: aid, state: "awaiting-user",
        url: provider === "codex" ? "https://auth.openai.com/codex/device" : "https://claude.ai/oauth/authorize?code=true&state=mock",
        userCode: provider === "codex" ? "HJ3D-9QZL" : null, needsPaste: provider !== "codex",
        output: "Waiting for you to finish in the browser…\n", error: null, startedAt: Date.now(),
      };
      logins.push(login);
      pushCold();
      return { account: acc, login };
    }
    if (id === "import") {
      const x = body<{ provider: ProviderId; home: string }>(b);
      const aid = `im-${Math.random().toString(36).slice(2, 6)}`;
      const acc: MockAccount = {
        id: aid, provider: x.provider ?? "claude", label: (x.home ?? "imported").split("/").pop() || "imported",
        email: "imported@example.com", plan: "max", home: x.home ?? "", isDefault: false, enabled: true, createdAt: Date.now(),
        auth: { state: "ok", expiresAt: Date.now() + 6 * H, detail: null },
        usage: usage(aid, [win("five_hour", "short", "5-hour", 0, null), win("seven_day", "weekly", "Weekly", 7, 6 * D)]),
      };
      accounts.push(acc);
      pushCold();
      return acc;
    }
    const a = mustAccount(id);
    if (method === "PATCH") {
      const x = body<{ label: string; enabled: boolean }>(b);
      if (typeof x.label === "string" && x.label.trim()) a.label = x.label.trim();
      if (typeof x.enabled === "boolean") a.enabled = x.enabled;
    } else if (method === "DELETE") {
      accounts.splice(accounts.indexOf(a), 1);
      logins = logins.filter((l) => l.accountId !== id);
    } else if (action === "usage") {
      await sleep(500);
      if (a.auth.state === "ok") a.usage = { ...a.usage, at: Date.now(), stale: null };
      else a.usage = { ...a.usage, stale: a.usage.stale ?? "token expired" };
      pushCold();
      return a.usage;
    } else if (action === "login") {
      const login: LoginFlow = {
        id: `lg-${id}-${Date.now()}`, provider: a.provider, accountId: id, state: "starting", url: null, userCode: null,
        needsPaste: false, output: "", error: null, startedAt: Date.now(),
      };
      logins = logins.filter((l) => l.accountId !== id).concat(login);
      pushCold();
      setTimeout(() => {
        Object.assign(login, {
          state: "awaiting-user",
          url: a.provider === "codex" ? "https://auth.openai.com/codex/device" : "https://claude.ai/oauth/authorize?code=true&state=again",
          userCode: a.provider === "codex" ? "ZP4R-2MNK" : null,
          needsPaste: a.provider !== "codex",
          output: "Browser login started…\n",
        });
        pushCold();
      }, 900);
      return login;
    }
    pushCold();
    return a;
  }

  if (head === "logins" && id) {
    const l = logins.find((x) => x.id === id);
    if (!l) throw new Error(`no login ${id}`);
    if (action === "cancel") {
      logins = logins.filter((x) => x !== l);
      pushCold();
      return null;
    }
    if (action === "paste") {
      l.state = "verifying";
      l.output += "\n[code pasted]\nVerifying…\n";
      pushCold();
      setTimeout(() => {
        l.state = "done";
        l.output += "Login successful.\n";
        const a = accounts.find((x) => x.id === l.accountId);
        if (a) {
          a.auth = { state: "ok", expiresAt: Date.now() + 8 * H, detail: null };
          a.email = "new.account@example.com";
          a.plan = "max";
          a.usage = usage(a.id, [win("five_hour", "short", "5-hour", 0, null), win("seven_day", "weekly", "Weekly", 2, 6 * D + 20 * H)]);
        }
        pushCold();
      }, 1400);
      return l;
    }
  }

  if (head === "settings" && method === "PUT") {
    Object.assign(settings, deepMerge(settings, b));
    pushCold();
    return structuredClone(settings);
  }

  if (head === "repos") {
    if (method === "DELETE" && id) {
      const i = repos.findIndex((r) => r.id === id);
      if (i >= 0) repos.splice(i, 1);
      pushCold();
      return null;
    }
    const ref = body<{ ref: string }>(b).ref ?? "";
    await sleep(700);
    const r: Repo = { id: `r-${Math.random().toString(36).slice(2, 6)}`, ref, kind: ref.startsWith("/") ? "local" : "github", displayName: ref.split("/").pop() || ref, fullName: ref.startsWith("/") ? null : ref, defaultBranch: "main", addedAt: Date.now() };
    repos.push(r);
    pushCold();
    return r;
  }

  if (head === "worktrees") {
    await sleep(900);
    if (id === "scan") return worktreeScan();
    return { removed: body<{ paths: string[] }>(b).paths ?? [], failed: [], bytesFreed: 402 * 1024 ** 2 };
  }

  if (head === "skill") {
    if (id === "body") return { ok: true };
    return { ok: true, from: "", to: "" };
  }

  // Anything else is a no-op that succeeds.
  return null;
}

// ------------------------------------------------------------- export

export const mockServer = {
  request(method: string, path: string, b: unknown): Promise<unknown> {
    return handle(method, path, b);
  },

  connect(fn: Listener): () => void {
    listeners.add(fn);
    setTimeout(() => {
      fn({ type: "hot", state: hot() });
      fn({ type: "cold", state: cold() });
      fn({ type: "metrics", state: metrics() });
    }, 60);
    ticker ??= setInterval(() => emit({ type: "metrics", state: metrics() }), 2000);
    return () => listeners.delete(fn);
  },

  client(msg: ClientMessage): void {
    if (msg.type !== "watch") return;
    watching = msg.sessionId;
    if (!msg.sessionId) {
      if (liveTimer) clearInterval(liveTimer);
      return;
    }
    const sid = msg.sessionId;
    setTimeout(() => {
      if (watching !== sid) return;
      const page = pageBefore(sid, null, PAGE);
      emit({ type: "timeline", sessionId: sid, events: page.events, cursor: page.cursor, reset: true });
      startLive(sid);
    }, 150);
  },

  term,
};
