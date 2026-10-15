/** A fake agentbox (its HTTP API, in memory), a fake git and gh, and a Vulcan
 *  context on them, for tests that must never touch the live server. */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ctx } from "../lib/ctx";
import type { Tools } from "../lib/shell";
import { Store } from "../lib/store";
import { canonicalSource } from "../lib/text";
import type { Grant } from "../lib/types";

export const BASE = "a".repeat(40);
export const HEAD1 = "b".repeat(40);
export const HEAD2 = "c".repeat(40);
export const HEAD3 = "d".repeat(40);
export const HEAD4 = "e".repeat(40);
export const REPO = "acme/app";
export const REPO_ID = "repo1";
export const MAIN = "mainsess";
export const ACTOR = "octocat";

export const TOKEN = "vulcan-token";

/** A work claim as agentbox keeps it (src/core/workclaims.ts), without the lease clock. */
type FakeClaim = { key: string; source: string; scope: string; fence: number; leaseUntil: number; state: string; holder: { superagent: string | null; session: string | null }; note: string | null };

type FakeSession = { id: string; provider: string; cwd: string; worktree: string | null; parent: string | null; status: string; host: string; origin: string; agentSessionId: string | null; branch: string | null };

export class FakeAgentbox {
  sessions: FakeSession[] = [];
  timelines = new Map<string, { id: string; at: number; kind: string; text: string }[]>();
  waits: { id: number; sessionId: string; spec: Record<string, unknown>; ended: string | null }[] = [];
  cards: { id: number; key: string | null; state: string; notify: boolean; kind: string; session: string | null; title: string }[] = [];
  claims = new Map<string, string>();
  /** Work claims by key: one holder each, all or none, fenced. */
  workClaims = new Map<string, FakeClaim>();
  receipts = new Map<string, { id: string; sessionId: string; state: string; error: string | null }>();
  sends: { id: string; text: string; sendId?: string; from?: string }[] = [];
  starts: Record<string, unknown>[] = [];
  stops: string[] = [];
  timelineReads: string[] = [];
  main: string | null = MAIN;
  /** Where a worktree for a branch goes when a session is started on one; the test's fake git lists it. */
  worktreeFor: (branch: string, id: string) => string = (_b, id) => `/tmp/wt/${id}`;
  onStart: (s: FakeSession) => void = () => {};
  /** The core knows the feedback wait (PR #4 Part 2): off by default, as main is today. */
  feedbackWaits = false;
  private server: ReturnType<typeof Bun.serve>;
  private nextWait = 1;
  private nextCard = 1;

  constructor(public checkout: string) {
    this.addSession({ id: MAIN, provider: "claude", cwd: checkout, parent: null });
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => this.handle(req) });
  }
  get url() {
    return `http://127.0.0.1:${this.server.port}`;
  }
  stop() {
    this.server.stop(true);
  }

  addSession(s: Partial<FakeSession> & { id: string; provider: string; cwd: string }): FakeSession {
    const full: FakeSession = { worktree: null, parent: null, status: "waiting", host: "tmux", origin: "agentbox", agentSessionId: `p-${s.id}`, branch: null, ...s };
    this.sessions.push(full);
    return full;
  }
  session(id: string): FakeSession {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error(`no fake session ${id}`);
    return s;
  }
  say(id: string, text: string) {
    const t = this.timelines.get(id) ?? [];
    t.push({ id: `e${t.length + 1}`, at: Date.now(), kind: "assistant", text });
    this.timelines.set(id, t);
  }

  private json(data: unknown, status = 200) {
    return new Response(JSON.stringify({ ok: status < 400, data: status < 400 ? data : null, error: status < 400 ? null : String(data) }), { status, headers: { "content-type": "application/json" } });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const body = req.method === "GET" || req.method === "DELETE" ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
    let m: RegExpExecArray | null;
    if (req.method === "GET" && path === "/api/state") return this.json({ sessions: this.sessions, repos: [{ id: REPO_ID, ref: this.checkout, kind: "local", displayName: "app", fullName: REPO, defaultBranch: "main", setup: { copy: [], run: "" } }] });
    if (req.method === "GET" && path === "/api/superagents/vulcan") return this.json({ name: "vulcan", main: this.main, previous: [], enabled: true });
    if (req.method === "POST" && path === "/api/sessions") {
      this.starts.push(body);
      const id = `s${this.sessions.length + 1}`;
      const branch = typeof body.branch === "string" ? body.branch : null;
      const cwd = typeof body.cwd === "string" ? body.cwd : branch ? this.worktreeFor(branch, id) : this.checkout;
      const s = this.addSession({ id, provider: String(body.provider), cwd, worktree: branch ? cwd : null, parent: (body.parent as string) ?? null, branch });
      this.onStart(s);
      return this.json({ session: s }, 201);
    }
    if (path === "/api/claims" || path.startsWith("/api/claims/")) return this.claim(req, url, body);
    if ((m = /^\/api\/sessions\/([^/]+)\/timeline$/.exec(path)) && req.method === "GET") {
      if (!this.sessions.some((s) => s.id === m![1])) return this.json(`no session ${m[1]}`, 404);
      this.timelineReads.push(m[1]!);
      return this.json({ events: this.timelines.get(m[1]!) ?? [], before: null, cursor: "c" });
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/send$/.exec(path)) && req.method === "POST") {
      if (!this.sessions.some((s) => s.id === m![1])) return this.json(`no session ${m[1]}`, 404);
      const sendId = body.sendId as string | undefined;
      if (sendId && this.receipts.has(sendId)) return this.json(this.receipts.get(sendId));
      this.sends.push({ id: m[1]!, text: String(body.text), sendId, from: body.fromSession as string | undefined });
      if (sendId) {
        const r = { id: sendId, sessionId: m[1]!, state: "sent", error: null };
        this.receipts.set(sendId, r);
        return this.json(r);
      }
      return this.json(body.from === "agent" ? { to: m[1] } : null);
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/submissions\/([^/]+)$/.exec(path)) && req.method === "GET") return this.json(this.receipts.get(m[2]!) ?? null);
    if ((m = /^\/api\/sessions\/([^/]+)\/stop$/.exec(path)) && req.method === "POST") {
      this.stops.push(m[1]!);
      const s = this.session(m[1]!);
      s.status = "stopped";
      s.host = "none";
      return this.json(null);
    }
    if (req.method === "GET" && path === "/api/waits") return this.json(this.waits.filter((w) => w.sessionId === url.searchParams.get("session")));
    if (req.method === "POST" && path === "/api/waits") {
      const spec = { ...(body.spec as Record<string, unknown>) };
      if (spec.kind === "pr") {
        if (!this.feedbackWaits) delete spec.feedback;
        if (spec.feedback) spec.all = false;
        else spec.all = spec.all === true || !(spec.checks as string[])?.length;
      }
      const w = { id: this.nextWait++, sessionId: String(body.session), spec, ended: null };
      this.waits.push(w);
      return this.json({ wait: w, already: false }, 201);
    }
    if ((m = /^\/api\/waits\/(\d+)$/.exec(path)) && req.method === "DELETE") {
      const w = this.waits.find((x) => x.id === Number(m![1]));
      if (w) w.ended = "cancelled";
      return this.json(w ?? null);
    }
    if (req.method === "POST" && path === "/api/cards") {
      const key = (body.key as string) ?? null;
      const old = key && this.cards.find((c) => c.key === key);
      if (old) return this.json(old, 201);
      const c = { id: this.nextCard++, key, state: "open", notify: body.notify !== false, kind: String(body.kind), session: (body.session as string) ?? null, title: String(body.title) };
      this.cards.push(c);
      return this.json(c, 201);
    }
    if ((m = /^\/api\/cards\/(\d+)\/close$/.exec(path)) && req.method === "POST") {
      const c = this.cards.find((x) => x.id === Number(m![1]));
      if (!c) return this.json("no card", 404);
      c.state = "closed";
      return this.json(c);
    }
    if (req.method === "POST" && path === "/api/prs/who") {
      const [repo, n] = String(body.pr).split("#");
      const holder = this.claims.get(`${repo!.toLowerCase()}#${n}`);
      return this.json({ repo, number: Number(n), claim: holder ? { sessionId: holder } : null });
    }
    if (req.method === "POST" && path === "/api/prs/claim") {
      const [repo, n] = String(body.pr).split("#");
      const key = `${repo!.toLowerCase()}#${n}`;
      const held = this.claims.get(key);
      if (held && held !== body.session) return this.json(`not claimed: held by ${held}`, 409);
      this.claims.set(key, String(body.session));
      return this.json({ repo, number: Number(n), sessionId: body.session, how: "said" });
    }
    return this.json(`no ${req.method} ${path}`, 404);
  }

  /** The claims routes, as core answers them: the program is its superagent by its token. */
  private claim(req: Request, url: URL, body: Record<string, unknown>): Response {
    const name = req.headers.get("x-agentbox-superagent");
    if (name && req.headers.get("x-agentbox-superagent-token") !== TOKEN) return this.json("token does not match", 403);
    const keyOf = (s: string) => (s.startsWith("http") ? canonicalSource(s) : { key: s, url: s });
    const conflict = (c: FakeClaim) => new Response(JSON.stringify({ ok: false, data: { key: c.key, holder: c.holder, state: c.state }, error: `${c.key} is held` }), { status: 409 });
    const live = (k: string) => {
      const c = this.workClaims.get(keyOf(k).key);
      return c && c.state !== "released" ? c : null;
    };
    if (req.method === "GET") return this.json([...this.workClaims.values()].filter((c) => c.state !== "released" && (!url.searchParams.get("superagent") || c.holder.superagent === url.searchParams.get("superagent"))));
    if (url.pathname === "/api/claims") {
      const items = (body.sources as string[]).map(keyOf);
      for (const i of items) {
        const held = live(i.key);
        if (held) return conflict(held);
      }
      const out = items.map((i) => {
        const c: FakeClaim = { key: i.key, source: i.url, scope: "work", fence: (this.workClaims.get(i.key)?.fence ?? 0) + 1, leaseUntil: Date.now() + 90_000, state: "active", holder: { superagent: name, session: (body.session as string) ?? null }, note: (body.note as string) ?? null };
        this.workClaims.set(i.key, c);
        return c;
      });
      return this.json({ claims: out }, 201);
    }
    const c = live(String(body.key));
    if (!c) return this.json("nobody holds it", 404);
    if (c.holder.superagent !== name) return this.json("not the holder", 403);
    if (c.fence !== body.fence) return conflict(c);
    if (url.pathname === "/api/claims/attach") Object.assign(c, { fence: c.fence + 1, holder: { ...c.holder, session: String(body.session) } });
    else if (url.pathname === "/api/claims/release") c.state = "released";
    else return this.json(`no ${req.method} ${url.pathname}`, 404);
    return this.json(c);
  }
}

/** git as Vulcan sees it, by state rather than by script: heads per checkout, branches, worktrees, the remote. */
export class FakeGit {
  remote = `https://github.com/${REPO}.git`;
  heads = new Map<string, string>();
  dirty = new Set<string>();
  branches = new Map<string, string>();
  worktrees = new Map<string, string>();
  remoteBranches = new Map<string, string>();
  refs = new Map<string, string>();
  commitMessages = "Fix the export\n\nPlain words.";
  pushes: string[] = [];
  mergeBase: (a: string, b: string) => string = (a) => a;
  calls: string[] = [];
  failPush = false;

  constructor(checkout: string) {
    this.heads.set(checkout, BASE);
    this.refs.set("refs/heads/main", BASE);
    this.remoteBranches.set("main", BASE);
  }

  run = async (cwd: string, ...args: string[]): Promise<string> => {
    this.calls.push(`${cwd}: ${args.join(" ")}`);
    const [cmd, ...rest] = args;
    switch (cmd) {
      case "remote":
        return this.remote;
      case "status":
        return this.dirty.has(cwd) ? " M file" : "";
      case "rev-parse": {
        const ref = rest.at(-1)!;
        if (ref === "HEAD") return this.heads.get(cwd) ?? BASE;
        if (rest.includes("--verify")) {
          const b = this.branches.get(ref.replace("refs/heads/", ""));
          if (b === undefined) throw new Error("git rev-parse failed (1)");
          return b;
        }
        return this.refs.get(ref) ?? BASE;
      }
      case "fetch": {
        const spec = rest.at(-1)!;
        const [src, dst] = spec.split(":");
        const sha = this.remoteBranches.get(src!.replace("refs/heads/", ""));
        if (!sha) throw new Error("git fetch failed (128)");
        this.refs.set(dst!, sha);
        return "";
      }
      case "branch":
        if (rest[0] === "--show-current") return [...this.worktrees.entries()].find(([, p]) => p === cwd)?.[0] ?? "main";
        this.branches.set(rest[0]!, rest[1]!);
        return "";
      case "worktree":
        if (rest[0] === "list") return [...this.worktrees.entries()].map(([b, p]) => `worktree ${p}\nHEAD ${this.heads.get(p) ?? BASE}\nbranch refs/heads/${b}`).join("\n\n");
        if (rest[0] === "add") {
          const path = rest.includes("--detach") ? rest[2]! : rest[1]!;
          const at = rest.at(-1)!;
          mkdirSync(path, { recursive: true });
          this.heads.set(path, at);
          return "";
        }
        throw new Error(`fake git: worktree ${rest[0]}`);
      case "merge-base":
        return this.mergeBase(rest[0]!, rest[1]!);
      case "log":
        return this.commitMessages;
      case "ls-remote": {
        const b = rest.at(-1)!.replace("refs/heads/", "");
        const sha = this.remoteBranches.get(b);
        return sha ? `${sha}\trefs/heads/${b}` : "";
      }
      case "push": {
        if (this.failPush) throw new Error("git push failed (128)");
        const [sha, dst] = rest.at(-1)!.split(":");
        this.remoteBranches.set(dst!.replace("refs/heads/", ""), sha!);
        this.pushes.push(rest.at(-1)!);
        return "";
      }
      default:
        throw new Error(`fake git: ${args.join(" ")}`);
    }
  };
}

export class FakeGh {
  login = ACTOR;
  issues = new Map<number, { state: string; pull_request?: unknown }>([
    [1, { state: "open" }],
    [2, { state: "open" }],
    [3, { state: "open" }],
  ]);
  pulls: { number: number; html_url: string; state: string; title: string; body: string; head: { sha: string; ref: string }; base: { ref: string }; user: { login: string } }[] = [];
  searched: { html_url: string; body: string }[] = [];
  filed: { title: string; body: string }[] = [];
  calls: string[] = [];
  constructor(private git: FakeGit) {}

  run = async <T>(path: string, body?: unknown, method = "POST"): Promise<T> => {
    this.calls.push(`${method} ${path}`);
    let m: RegExpExecArray | null;
    if (path === "user") return { login: this.login } as T;
    if (path.startsWith("users/")) return { login: path.slice(6) } as T;
    if ((m = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path))) {
      const i = this.issues.get(Number(m[1]));
      if (!i) throw new Error("gh api failed (1)");
      return i as T;
    }
    if ((m = /^repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/.exec(path))) return { object: { sha: this.git.remoteBranches.get(decodeURIComponent(m[1]!)) } } as T;
    if ((m = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path))) {
      const pr = this.pulls.find((p) => p.number === Number(m![1]));
      if (!pr) throw new Error("gh api failed (1)");
      if (method === "PATCH") Object.assign(pr, body as object);
      return pr as T;
    }
    if (/^repos\/[^/]+\/[^/]+\/pulls\?/.test(path)) return this.pulls as T;
    if (/^repos\/[^/]+\/[^/]+\/pulls$/.test(path)) {
      const b = body as { title: string; body: string; head: string; base: string };
      const pr = { number: this.pulls.length + 1, html_url: `https://github.com/${REPO}/pull/${this.pulls.length + 1}`, state: "open", title: b.title, body: b.body, head: { sha: this.git.remoteBranches.get(b.head)!, ref: b.head }, base: { ref: b.base }, user: { login: this.login } };
      this.pulls.push(pr);
      return pr as T;
    }
    if (path.startsWith("search/issues")) return { items: this.searched } as T;
    if (/^repos\/[^/]+\/[^/]+\/issues$/.test(path)) {
      this.filed.push(body as { title: string; body: string });
      return { html_url: `https://github.com/improve/repo/issues/${this.filed.length}` } as T;
    }
    throw new Error(`fake gh: ${method} ${path}`);
  };
}

export type World = { box: FakeAgentbox; git: FakeGit; gh: FakeGh; ctx: Ctx; dir: string; checkout: string; grant: Grant; tools: Tools };

export function world(): World {
  const dir = mkdtempSync(join(tmpdir(), "vulcan-test-"));
  const checkout = join(dir, "checkout");
  mkdirSync(checkout, { recursive: true });
  const box = new FakeAgentbox(checkout);
  const git = new FakeGit(checkout);
  const gh = new FakeGh(git);
  box.worktreeFor = (branch, id) => {
    const path = join(dir, "worktrees", id);
    mkdirSync(path, { recursive: true });
    git.worktrees.set(branch, path);
    git.heads.set(path, git.branches.get(branch) ?? BASE);
    return path;
  };
  process.env.AGENTBOX_URL = box.url;
  process.env.AGENTBOX_SUPERAGENT = "vulcan";
  process.env.AGENTBOX_SUPERAGENT_TOKEN = TOKEN;
  process.env.AGENTBOX_SUPERAGENT_HOME = join(dir, "home");
  process.env.AGENTBOX_SUPERAGENT_DIR = join(import.meta.dir, "..");
  const tools: Tools = { git: git.run, gh: gh.run };
  const store = new Store(new Database(":memory:"));
  const ctx = new Ctx(store, tools, { writerProvider: "codex", promptRevision: "producer-to-assertion-v1", dir: join(import.meta.dir, ".."), cli: "agentbox" });
  const grant: Grant = { id: randomUUID(), requester: MAIN, project: REPO_ID, human: { name: "Ada Lovelace", github: "ada" }, actor: ACTOR, requiredChecks: ["build"], improvementRepo: "improve/repo", expires: Date.now() + 86_400_000, createdAt: Date.now() };
  store.saveGrant(grant);
  return { box, git, gh, ctx, dir, checkout, grant, tools };
}

export const family = (grant: string, issues: number[], id = randomUUID()) => ({
  id,
  grant,
  base: "main",
  issues: issues.map((n) => ({ source: `https://github.com/${REPO}/issues/${n}`, repro: "repro", acceptance: "acceptance", evidence: "evidence" })),
  preparation: { problem: "p", consumers: "c", edges: "e", nonGoals: "n", design: "d", validation: "v" },
});

export const verdict = (round: number, focus: string, base: string, head: string, clean = true) =>
  "```json\n" + JSON.stringify({ kind: "agentbox-review", round, focus, base, head, verdict: clean ? "clean" : "changes", findings: clean ? [] : [{ title: "Missed edge", evidence: "file.ts:1", remedy: "Handle it" }], evidence: ["file.ts"] }) + "\n```";
