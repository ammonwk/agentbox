/**
 * Jupiter: makes agents. Its conversation proposes one (`propose`, from its
 * current main session only); its page shows each proposal as a form; a
 * person edits it and presses Create, which writes the directory (for a
 * conversation agent) and registers it with agentbox. Every step is
 * idempotent: a proposal by its request id, a save by its revision, a create
 * by its draft.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { ActionError, agentbox, call, serve, store, type ActionRequest, type AgentBlock, type AgentView } from "../lib/sdk";
import type { AppState, AgentInfo } from "../../src/core/types";

const PROVIDERS = ["claude", "codex", "devin", "omp", "opencode", "muse"] as const;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const manifest = JSON.parse(readFileSync(join(import.meta.dir, "agent.json"), "utf8")) as { makes?: string };
const MAKES = resolve((manifest.makes ?? "~/.agents/agents").replace(/^~(?=\/|$)/, homedir()));

type Spec = {
  name: string;
  title: string;
  description: string;
  instructions: string;
  provider: (typeof PROVIDERS)[number];
  model: string;
  limits: string;
  automation: string;
  repo: string;
  /** An agent with a program: the directory its conversation wrote. */
  dir: string;
};
type Draft = { id: string; request: string; session: string; spec: Spec; revision: number; state: "draft" | "created" | "discarded"; created: string | null; at: number };

const db = store();
db.exec(`CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY, request TEXT NOT NULL UNIQUE, session TEXT NOT NULL, spec TEXT NOT NULL,
  revision INTEGER NOT NULL, state TEXT NOT NULL, created TEXT, at INTEGER NOT NULL)`);

const rowOf = (r: Record<string, unknown> | null): Draft | null =>
  r ? { ...(r as unknown as Draft), spec: JSON.parse(r.spec as string) as Spec } : null;
const drafts = (): Draft[] => (db.query("SELECT * FROM drafts ORDER BY at DESC").all() as Record<string, unknown>[]).map((r) => rowOf(r)!);
const draft = (id: string): Draft => {
  const d = rowOf(db.query("SELECT * FROM drafts WHERE id = ?").get(id) as Record<string, unknown> | null);
  if (!d) throw new ActionError("no such draft", 404);
  return d;
};

const text = (v: unknown, max: number, what: string): string => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new ActionError(`${what} is text`);
  if (v.length > max) throw new ActionError(`${what} is at most ${max} characters`);
  return v.trim();
};

function specOf(v: Record<string, unknown>, base?: Spec): Spec {
  const pick = <K extends keyof Spec>(k: K, max: number) => (k in v ? text(v[k], max, k) : (base?.[k] ?? ""));
  const s: Spec = {
    name: pick("name", 40),
    title: pick("title", 80),
    description: pick("description", 500),
    instructions: pick("instructions", 24_000),
    provider: (pick("provider", 20) || "claude") as Spec["provider"],
    model: pick("model", 120),
    limits: pick("limits", 4_000),
    automation: pick("automation", 2_000),
    repo: pick("repo", 200),
    dir: pick("dir", 1_000),
  };
  if (!NAME.test(s.name)) throw new ActionError("name: lowercase letters, digits and dashes, starting with a letter");
  if (!PROVIDERS.includes(s.provider)) throw new ActionError(`provider is one of ${PROVIDERS.join(", ")}`);
  if (!s.title) s.title = s.name;
  if (s.dir) {
    s.dir = resolve(s.dir.replace(/^~(?=\/|$)/, homedir()));
    if (!existsSync(join(s.dir, "agent.json"))) throw new ActionError(`${s.dir} has no agent.json`);
  } else if (!s.instructions) throw new ActionError("a conversation agent needs its instructions");
  return s;
}

const same = (a: Spec, b: Spec) => JSON.stringify(a) === JSON.stringify(b);

/** Only Jupiter's own conversation, as it is now, proposes. */
async function fromCurrentConversation(req: ActionRequest): Promise<string> {
  const { main } = await agentbox.self();
  if (!req.caller.session || req.caller.session !== main)
    throw new ActionError("only Jupiter's current conversation proposes agents: run this from it, with its own agentbox command", 403);
  return main;
}

/** A person on the page, not a session: creating is theirs. */
function fromPerson(req: ActionRequest): void {
  if (req.caller.via !== "app" || req.caller.session) throw new ActionError("a person creates an agent, from Jupiter's page", 403);
}

async function repos(): Promise<AppState["repos"]> {
  return (await agentbox.state()).repos;
}

async function repoId(name: string): Promise<string | null> {
  if (!name) return null;
  const n = name.toLowerCase();
  const r = (await repos()).find((x) => [x.id, x.fullName, x.displayName, x.ref].some((y) => y?.toLowerCase() === n));
  if (!r) throw new ActionError(`no registered repository ${name}: register it in Settings first`);
  return r.id;
}

/** The directory of a conversation agent: its manifest and its instructions. */
async function writeAgent(d: Draft): Promise<string> {
  const s = d.spec;
  const dir = join(MAKES, s.name);
  const mark = join(dir, ".jupiter");
  if (existsSync(dir) && (!existsSync(mark) || readFileSync(mark, "utf8").trim() !== d.id))
    throw new ActionError(`${dir} already exists and is not this draft's: pick another name`, 409);
  mkdirSync(dir, { recursive: true });
  const repo = await repoId(s.repo);
  const start: Record<string, unknown> = { provider: s.provider, ...(s.model ? { model: s.model } : {}), ...(repo ? { repoId: repo, worktree: true } : {}) };
  writeFileSync(
    join(dir, "agent.json"),
    JSON.stringify(
      {
        name: s.name,
        title: s.title,
        description: s.description,
        main: { start, instructions: "MAIN.md" },
        madeBy: "jupiter",
        ...(s.automation ? { requestedAutomation: s.automation } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(dir, "MAIN.md"), `${s.instructions}${s.limits ? `\n\nLimits: ${s.limits}` : ""}\n`);
  writeFileSync(mark, d.id);
  return dir;
}

/** An agent with a program keeps its own manifest; the title and purpose edited here go into it. */
function titled(d: Draft): string {
  const file = join(d.spec.dir, "agent.json");
  const m = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (m.name !== d.spec.name) throw new ActionError(`${file} names ${String(m.name)}, not ${d.spec.name}`, 409);
  if (m.title !== d.spec.title || m.description !== d.spec.description) writeFileSync(file, JSON.stringify({ ...m, title: d.spec.title, description: d.spec.description }, null, 2) + "\n");
  return d.spec.dir;
}

async function create(d: Draft): Promise<AgentInfo> {
  if (d.state === "created" && d.created) return call<AgentInfo>("GET", `/api/agents/${d.created}`);
  if (d.state === "discarded") throw new ActionError("this draft was discarded");
  const all = await call<AgentInfo[]>("GET", "/api/agents");
  const dir = d.spec.dir || join(MAKES, d.spec.name);
  const taken = all.find((a) => a.name === d.spec.name && resolve(a.dir) !== resolve(dir));
  if (taken) throw new ActionError(`an agent named ${d.spec.name} already exists (${taken.dir}): pick another name`, 409);
  const at = d.spec.dir ? titled(d) : await writeAgent(d);
  const info = await call<AgentInfo>("POST", "/api/agents", { dir: at });
  db.run("UPDATE drafts SET state = 'created', created = ? WHERE id = ?", [info.name, d.id]);
  return info;
}

serve({
  async action(req) {
    const v = req.values;
    switch (req.action) {
      case "propose": {
        const session = await fromCurrentConversation(req);
        const request = text(v.request, 64, "request");
        if (!/^[\w-]{8,64}$/.test(request)) throw new ActionError("request: a UUID you keep, so a retry is the same proposal");
        const spec = specOf(v);
        const old = rowOf(db.query("SELECT * FROM drafts WHERE request = ?").get(request) as Record<string, unknown> | null);
        if (old) {
          if (!same(old.spec, spec) && old.revision === 1 && old.state === "draft") {
            db.run("UPDATE drafts SET spec = ? WHERE id = ?", [JSON.stringify(spec), old.id]);
            return { draft: old.id, revised: true, message: "Proposal updated on Jupiter's page." };
          }
          if (!same(old.spec, spec)) throw new ActionError("that request id is a proposal they have already edited or acted on: use a new request id", 409);
          return { draft: old.id, message: "Already proposed." };
        }
        const id = crypto.randomUUID();
        db.run("INSERT INTO drafts VALUES (?, ?, ?, ?, 1, 'draft', NULL, ?)", [id, request, session, JSON.stringify(spec), Date.now()]);
        return { draft: id, message: "Proposed: it is on Jupiter's page for them to edit and create." };
      }
      case "save":
      case "create": {
        fromPerson(req);
        const d = draft(String(v.draft ?? ""));
        if (d.state !== "draft") return d.state === "created" ? { message: `${d.spec.title} was already created.`, open: `#/agents/${d.created}` } : { message: "This draft was discarded." };
        const { main } = await agentbox.self();
        if (d.session !== main) throw new ActionError("this proposal is from an earlier conversation with Jupiter: ask again in the current one", 409);
        if (Number(v.revision) !== d.revision) throw new ActionError("this draft changed since you opened it: look again", 409);
        const { draft: _d, revision: _r, ...fields } = v;
        const spec = specOf(fields, d.spec);
        const changed = !same(spec, d.spec);
        if (changed) db.run("UPDATE drafts SET spec = ?, revision = revision + 1 WHERE id = ? AND revision = ?", [JSON.stringify(spec), d.id, d.revision]);
        if (req.action === "save") return { message: changed ? "Draft saved." : "Nothing changed." };
        const info = await create(draft(d.id));
        return { message: `${info.title} created. It is ready for a conversation; nothing was started.`, open: `#/agents/${info.name}` };
      }
      case "discard": {
        fromPerson(req);
        const d = draft(String(v.draft ?? ""));
        if (d.state === "draft") db.run("UPDATE drafts SET state = 'discarded' WHERE id = ?", [d.id]);
        return { message: "Discarded." };
      }
      default:
        throw new ActionError(`Jupiter has no action ${req.action}`, 404);
    }
  },

  async view(tab): Promise<AgentView> {
    const all = drafts();
    const open = all.filter((d) => d.state === "draft");
    const made = all.filter((d) => d.state === "created");
    const { main } = await agentbox.self();
    const tabs = [
      { id: "drafts", title: "Drafts", badge: open.length },
      { id: "made", title: "Made" },
    ];
    if (tab === "made")
      return {
        tabs,
        blocks: made.length
          ? made.map((d) => ({ type: "item", title: d.spec.title, subtitle: d.created ?? "", body: d.spec.description, links: [{ label: "Open", url: `#/agents/${d.created}` }] }))
          : [{ type: "markdown", text: "Nothing made yet." }],
        refresh: 10,
      };
    const repoOptions = [{ value: "", label: "No repository: conversation only" }, ...(await repos()).map((r) => ({ value: r.fullName ?? r.displayName, label: r.fullName ?? r.displayName }))];
    const blocks: AgentBlock[] = open.length
      ? open.map((d) => draftBlock(d, d.session === main, repoOptions))
      : [
          {
            type: "markdown",
            text: "Tell Jupiter what you want an agent to do. Its proposal appears here to edit; nothing is made until you press **Create agent**.",
          },
        ];
    return { tabs, blocks, refresh: 4 };
  },
});

function draftBlock(d: Draft, current: boolean, repoOptions: { value: string; label: string }[]): AgentBlock {
  const s = d.spec;
  const scope = `${s.repo || "No repository"} · You stay accountable · Manual activation${s.automation ? ` · Requested automation, not set up: ${s.automation}` : ""}`;
  if (!current)
    return {
      type: "item",
      status: "idle",
      title: s.title,
      subtitle: "from an earlier conversation",
      body: `${s.description}\n\nThis proposal belongs to an earlier conversation with Jupiter. Ask again in this one to create it.`,
      actions: [{ id: "discard", label: "Discard", values: { draft: d.id } }],
    };
  if (s.dir)
    return {
      type: "item",
      title: s.title,
      subtitle: `${s.name} · a program`,
      body: `Its code is in \`${s.dir}\`: read it before you create it. ${scope}`,
      children: [
        {
          type: "form",
          id: d.id,
          fields: [
            { name: "title", label: "Title", kind: "text", value: s.title },
            { name: "description", label: "Purpose", kind: "textarea", rows: 2, value: s.description },
          ],
          actions: [
            { id: "create", label: "Create agent", style: "primary", values: { draft: d.id, revision: d.revision } },
            { id: "save", label: "Save draft", values: { draft: d.id, revision: d.revision } },
            { id: "discard", label: "Discard", confirm: "Discard this proposal?", values: { draft: d.id } },
          ],
        },
      ],
    };
  return {
    type: "item",
    title: s.title,
    subtitle: s.name,
    body: scope,
    children: [
      {
        type: "form",
        id: d.id,
        fields: [
          { name: "name", label: "Name", kind: "text", value: s.name },
          { name: "title", label: "Title", kind: "text", value: s.title },
          { name: "description", label: "Purpose", kind: "textarea", rows: 2, value: s.description },
          { name: "instructions", label: "Instructions", kind: "textarea", rows: 10, value: s.instructions },
          { name: "provider", label: "Provider", kind: "select", value: s.provider, options: PROVIDERS.map((p) => ({ value: p, label: p })) },
          { name: "model", label: "Model (blank: the provider's default)", kind: "text", value: s.model },
          { name: "repo", label: "Repository", kind: "select", value: s.repo, options: repoOptions },
          { name: "limits", label: "Limits", kind: "textarea", rows: 3, value: s.limits },
          { name: "automation", label: "Requested automation (recorded, not set up)", kind: "text", value: s.automation },
        ],
        actions: [
          { id: "create", label: "Create agent", style: "primary", values: { draft: d.id, revision: d.revision } },
          { id: "save", label: "Save draft", values: { draft: d.id, revision: d.revision } },
          { id: "discard", label: "Discard", confirm: "Discard this proposal?", values: { draft: d.id } },
        ],
      },
    ],
  };
}
