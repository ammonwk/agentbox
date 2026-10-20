/** A fake agentbox (its HTTP API, in memory), fake git, gh and crash source,
 *  and a Salus context on them, for tests that must never touch the live server. */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ctx, type Tools } from "../lib/ctx";
import { writeSettings, Settings } from "../lib/settings";
import type { Source } from "../lib/source";
import { Store } from "../lib/store";
import type { Seen } from "../lib/types";

export const REPO = "acme/app";
export const REPO_ID = "repo1";
export const MAIN = "salusmain";
export const SHA = "a".repeat(40);

type FakeSession = { id: string; provider: string; cwd: string; parent: string | null; status: string; host: string; firstPrompt?: string | null };

export class FakeAgentbox {
  sessions: FakeSession[] = [{ id: MAIN, provider: "claude", cwd: "/", parent: null, status: "waiting", host: "tmux" }];
  starts: Record<string, unknown>[] = [];
  closed: string[] = [];
  /** Each close's body, by session. */
  closes = new Map<string, Record<string, unknown>>();
  chats: { text: string; sendId: string }[] = [];
  cards: { id: number; key: string | null; kind: string; title: string; notify: boolean }[] = [];
  timelines = new Map<string, { kind: string; text: string }[]>();
  /** The fixer's families, by id, as `work-get` answers them. */
  works = new Map<string, Record<string, unknown>>();
  main: string | null = MAIN;
  private server: ReturnType<typeof Bun.serve>;

  constructor(public checkout: string) {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => this.handle(req) });
  }
  get url() {
    return `http://127.0.0.1:${this.server.port}`;
  }
  stop() {
    this.server.stop(true);
  }
  say(id: string, text: string, status = "waiting") {
    const t = this.timelines.get(id) ?? [];
    t.push({ kind: "assistant", text });
    this.timelines.set(id, t);
    this.sessions.find((s) => s.id === id)!.status = status;
  }

  private json(data: unknown, status = 200) {
    return new Response(JSON.stringify({ ok: status < 400, data: status < 400 ? data : null, error: status < 400 ? null : String(data) }), { status, headers: { "content-type": "application/json" } });
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const body = req.method === "GET" ? {} : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
    let m: RegExpExecArray | null;
    if (req.method === "GET" && path === "/api/state") return this.json({ sessions: this.sessions, repos: [{ id: REPO_ID, ref: this.checkout, kind: "local", displayName: "app", fullName: REPO, defaultBranch: "main" }] });
    if (req.method === "GET" && path === "/api/superagents/salus") return this.json({ name: "salus", main: this.main, previous: [] });
    if (req.method === "POST" && path === "/api/superagents/salus/chat") {
      if (!this.chats.some((c) => c.sendId === body.sendId)) this.chats.push({ text: String(body.text), sendId: String(body.sendId) });
      return this.json({ session: MAIN, started: false });
    }
    if (req.method === "POST" && path === "/api/superagents/vulcan/action") {
      const w = this.works.get(String((body.values as { id: string }).id));
      return w ? this.json({ work: w }) : this.json("Work family not found", 404);
    }
    if (req.method === "POST" && path === "/api/sessions") {
      this.starts.push(body);
      // Agentbox cuts a repo-and-ref start's checkout itself, where it runs.
      const id = `t${this.starts.length}`;
      const cwd = body.cwd ? String(body.cwd) : `/worktrees/${id}`;
      const s = { id, provider: String(body.provider), cwd, parent: (body.parent as string) ?? null, status: "running", host: "tmux", firstPrompt: (body.prompt as string) ?? null };
      this.sessions.push(s);
      return this.json({ session: s }, 201);
    }
    if ((m = /^\/api\/sessions\/([^/]+)\/timeline$/.exec(path))) return this.json({ events: this.timelines.get(m[1]!) ?? [], before: null });
    if ((m = /^\/api\/sessions\/([^/]+)\/close$/.exec(path))) {
      this.closed.push(m[1]!);
      this.closes.set(m[1]!, body);
      return this.json(null);
    }
    if (req.method === "POST" && path === "/api/cards") {
      const key = (body.key as string) ?? null;
      const old = key && this.cards.find((c) => c.key === key);
      if (old) return this.json(old, 201);
      const c = { id: this.cards.length + 1, key, kind: String(body.kind), title: String(body.title), notify: body.notify !== false };
      this.cards.push(c);
      return this.json(c, 201);
    }
    return this.json(`no ${req.method} ${path}`, 404);
  }
}

export class FakeGit {
  calls: string[] = [];
  run = async (cwd: string, ...args: string[]): Promise<string> => {
    this.calls.push(`${cwd}: ${args.join(" ")}`);
    if (args[0] === "rev-parse") return SHA;
    if (args[0] === "worktree" && args[1] === "add") mkdirSync(args[3]!, { recursive: true });
    return "";
  };
}

export class FakeGh {
  issues: { title: string; body: string }[] = [];
  pulls = new Map<number, { merged_at: string | null; closed_at: string | null; state: string; merge_commit_sha?: string; base?: { ref: string } }>();
  /** Successful deploy runs on the production branch, newest first as GitHub lists them. */
  runs: { head_sha: string; updated_at: string; created_at: string; html_url: string }[] = [];
  /** Which commits contain which: `contains[head]` lists the merge commits a head has. */
  contains = new Map<string, string[]>();
  asked: string[] = [];
  /** What a search finds: the issues filed so far, unless the test says the index has not caught up. */
  searchLags = false;
  run = async <T>(path: string, body?: unknown, method = "POST"): Promise<T> => {
    let m: RegExpExecArray | null;
    this.asked.push(`${method === "GET" ? "GET" : method} ${path}`);
    if ((m = /^repos\/acme\/app\/actions\/workflows\/([^/]+)\/runs\?(.*)$/.exec(path))) {
      const q = new URLSearchParams(m[2]);
      const since = Date.parse(q.get("created")!.replace(/^>=/, ""));
      return { workflow_runs: this.runs.filter((r) => Date.parse(r.created_at) >= since) } as T;
    }
    if ((m = /^repos\/acme\/app\/commits\/([^/?]+)$/.exec(path))) return { sha: SHA, ref: decodeURIComponent(m[1]!) } as T;
    if ((m = /^repos\/acme\/app\/compare\/(\w+)\.\.\.(\w+)/.exec(path))) return { status: this.contains.get(m[2]!)?.includes(m[1]!) ? "ahead" : "diverged" } as T;
    if (path.startsWith("search/issues")) return { items: this.searchLags ? [] : this.issues.map((i, n) => ({ html_url: `https://github.com/${REPO}/issues/${n + 1}`, number: n + 1, body: i.body })) } as T;
    if (path === `repos/${REPO}/issues` && method === "POST") {
      this.issues.push(body as { title: string; body: string });
      return { html_url: `https://github.com/${REPO}/issues/${this.issues.length}`, number: this.issues.length } as T;
    }
    if ((m = /^repos\/acme\/app\/pulls\/(\d+)$/.exec(path))) return (this.pulls.get(Number(m[1])) ?? { merged_at: null, closed_at: null, state: "open" }) as T;
    throw new Error(`fake gh: ${method} ${path}`);
  };
}

/** A crash source whose events the test places in time. */
export class FakeSource implements Source {
  events: { key: string; at: number }[] = [];
  samples = new Map<string, Seen["sample"]>();
  failing: string | null = null;
  add(key: string, at: number, n = 1) {
    for (let i = 0; i < n; i++) this.events.push({ key, at });
  }
  async recent(hours: number, limit: number, now = Date.now()): Promise<Seen[]> {
    if (this.failing) throw new Error(this.failing);
    const since = now - hours * 3_600_000;
    const by = new Map<string, number[]>();
    for (const e of this.events) if (e.at > since) by.set(e.key, [...(by.get(e.key) ?? []), e.at]);
    return [...by.entries()]
      .map(([key, ats]) => ({ key, count: ats.length, first: Math.min(...ats), last: Math.max(...ats), sample: this.samples.get(key) ?? { type: "TypeError", value: "x is undefined", frames: [], url: null, lib: "posthog-node" } }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }
  async count(key: string, since: number, until: number) {
    const ats = this.events.filter((e) => e.key === key && e.at >= since && e.at < until).map((e) => e.at);
    return { count: ats.length, last: ats.length ? Math.max(...ats) : null };
  }
  link(key: string) {
    return `https://posthog.example/error_tracking/${key}`;
  }
}

export type World = { box: FakeAgentbox; git: FakeGit; gh: FakeGh; src: FakeSource; ctx: Ctx; home: string };

export function world(settings: Partial<Settings> = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "salus-test-"));
  const checkout = join(dir, "checkout");
  const home = join(dir, "home");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(home, { recursive: true });
  const box = new FakeAgentbox(checkout);
  const git = new FakeGit();
  const gh = new FakeGh();
  const src = new FakeSource();
  process.env.AGENTBOX_URL = box.url;
  process.env.AGENTBOX_SUPERAGENT = "salus";
  process.env.AGENTBOX_SUPERAGENT_HOME = home;
  writeSettings(home, Settings.parse({ enabled: true, projectId: "1", repo: REPO_ID, minCount: 3, ...settings }));
  const tools: Tools = { git: git.run, gh: gh.run };
  const ctx = new Ctx(new Store(new Database(":memory:")), tools, home, "agentbox", () => src);
  return { box, git, gh, src, ctx, home };
}

export const APP = { session: null, via: "app" as const };

export const verdict = (v: "fix" | "ignore" = "fix") =>
  "Here is what I found.\n\n```json\n" +
  JSON.stringify({
    kind: "salus-triage",
    verdict: v,
    severity: "high",
    summary: "The export reads a field the new schema dropped.",
    rootCause: "src/export.ts:12 reads row.owner, which the migration removed.",
    reason: v === "ignore" ? "Bots" : "",
    ...(v === "fix"
      ? {
          fix: {
            title: "Export crashes on rows without an owner",
            repro: "Export an organization with an ownerless row.",
            acceptance: "A test exporting an ownerless row passes; the TypeError stops in PostHog.",
            evidence: "src/export.ts:12",
            preparation: { problem: "p", consumers: "c", edges: "e", nonGoals: "n", design: "d", validation: "v" },
          },
        }
      : {}),
  }) +
  "\n```";
