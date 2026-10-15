/** /help reports from a superagent's chat, and the reports its sessions file
 * themselves (`agentbox report`). GitHub owns the report; this journal keeps
 * only identity, hashes and delivery outcomes, never a conversation copy. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { RUNNING_REVISION } from "../../revision";
import { z } from "zod";
import { FleetError } from "../fleet";
import { userHome } from "../paths";
import { uploadFile } from "../uploads";
import { CREDENTIAL } from "./memory";

/** What the reports ask of the hub: a superagent's name, title and
 *  description, the superagent a session belongs to, and whether a session
 *  is one of its own. */
export interface FeedbackHost {
  profile(name: string): { title: string; description: string } | null;
  ownerOf(session: string): string | null;
}

export const FEEDBACK_REPO = "ammonwk/agentbox";
/** `note`: what the person should know of a created issue, such as images that were not uploaded. */
type Receipt = { state: "sent" | "refused" | "uncertain" | "attempting"; result: string; issue?: string; note?: string };
/** `agent`: the superagent's name. `by`: the session that filed it (`agentbox report`); absent for the person's /help. */
type Record = Receipt & { id: string; agent: string; fingerprint: string; at: number; by?: string };
/** Reports one superagent's sessions may file in a day: the repository is public. */
export const AGENT_REPORTS_PER_DAY = 3;
type GitHub = (path: string, body?: unknown) => Promise<any>;
const github: GitHub = async (path, body) => {
  const p = Bun.spawn(["gh", "api", path, ...(body === undefined ? [] : ["--method", "POST", "--input", "-"])], {
    env: {...process.env, GH_PROMPT_DISABLED: "1"},
    stdin: body === undefined ? "ignore" : new Blob([JSON.stringify(body)]),
    stdout: "pipe", stderr: "pipe", timeout: 30000,
  });
  const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code) throw Error("GitHub could not complete the request. Check your gh login and repository access.");
  return JSON.parse(out);
};
/** Attaching images to an issue: the GitHub CLI's `--attach` (v2.99.0 and
 *  later, write access to the repository). GitHub's REST API has no upload. */
export interface IssueCli {
  /** `gh --version`'s version, or null when gh does not answer. */
  version(): Promise<string | null>;
  /** `gh issue create --attach`: its URL when gh printed one (also when some
   *  images failed: `partial`), or null when it printed none. */
  createIssue(issue: { title: string; body: string; attach: { path: string; alt: string }[] }): Promise<{ url: string | null; partial: boolean }>;
}
const ATTACH_SINCE = [2, 99, 0];
/** GitHub's limit for an attached image. */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const ghCli: IssueCli = {
  async version() {
    try {
      const p = Bun.spawn(["gh", "--version"], { stdout: "pipe", stderr: "ignore", timeout: 10000 });
      const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      return code ? null : (/gh version (\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null);
    } catch { return null; }
  },
  async createIssue({ title, body, attach }) {
    const p = Bun.spawn(["gh", "issue", "create", "--repo", FEEDBACK_REPO, "--title", title, "--body-file", "-", ...attach.flatMap((a) => ["--attach", `${a.path}#${a.alt}`])], {
      env: {...process.env, GH_PROMPT_DISABLED: "1"},
      stdin: new Blob([body]), stdout: "pipe", stderr: "pipe", timeout: 120000,
    });
    const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    // Some images may fail while the issue is still created: gh prints its URL and exits non-zero.
    const url = out.trim().split(/\s+/).reverse().find(issueUrl) ?? null;
    return { url, partial: code !== 0 };
  },
};
const newer = (v: string) => {
  const a = v.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== ATTACH_SINCE[i]) return (a[i] ?? 0) > ATTACH_SINCE[i]!;
  return true;
};
const input = z.object({request:z.string().uuid(), text:z.string().trim().min(1).max(10000), target:z.string().max(200).nullable(), uiRevision:z.object({commit:z.string().regex(/^[0-9a-f]{40}$/),dirty:z.boolean()}).strict().nullable().optional(),
  /** Image numbers the person ticked "Publish publicly" for; the rest stay on this machine. */
  publish:z.array(z.number().int().min(1).max(99)).max(10).optional()}).strict();
const marker = (id: string) => `agentbox-help:${id}`;
/** The issue is public. An image token's path names the person's account, so
 * only its file name is published: enough for triage on this Mac to find the
 * image in the uploads folder, nothing about who sent it. */
export function publicText(text: string, home = userHome()): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const root = home.replace(/\/+$/, "");
  text = text.replace(/\[Image #(\d+): ([^\]\n]*)\]/g, (_, n: string, path: string) => {
    const name = path.split("/").pop()!;
    return `[Image #${n}: ${/^[\w.-]{1,80}$/.test(name) ? `${name}, ` : ""}kept on the reporter's machine, not uploaded]`;
  });
  if (root.length > 1) text = text.replace(new RegExp(`${esc(root)}(?![\\w.-])`, "g"), "~");
  return text
    .replace(/(?<![\w.~-])\/(?:Users|home)\/[^\s/'"`)\]]+/g, "~");
}
const issueUrl = (url: unknown): url is string => typeof url === "string" && /^https:\/\/github\.com\/ammonwk\/agentbox\/issues\/\d+$/.test(url);

export class AgentFeedback {
  private active = new Map<string, Promise<Receipt>>();
  constructor(private db: Database, private host: FeedbackHost, private gh: GitHub = github, private cli: IssueCli = ghCli) {
    db.exec("CREATE TABLE IF NOT EXISTS agent_feedback (id TEXT PRIMARY KEY, agent TEXT NOT NULL, body TEXT NOT NULL)");
  }
  private record(id: string): Record | null {
    const row = this.db.query("SELECT body FROM agent_feedback WHERE id=?").get(id) as {body:string}|null;
    return row ? JSON.parse(row.body) : null;
  }
  private save(r: Record) {
    this.db.run("INSERT OR REPLACE INTO agent_feedback(id,agent,body) VALUES (?,?,?)",[r.id,r.agent,JSON.stringify(r)]);
  }
  async receipt(agent: string, id: string): Promise<Receipt | null> {
    const r = this.record(id);
    if (!r || r.agent !== agent) return null;
    if (["attempting","uncertain"].includes(r.state) && !this.active.has(id)) {
      // Search may lag. A missing result is never permission to repeat a POST.
      try {
        const found = await this.gh(`search/issues?q=${encodeURIComponent(`repo:${FEEDBACK_REPO} is:issue "${marker(id)}" in:body`)}&per_page=100`);
        const existing = found.items?.find((i: {body?:string;html_url?:string}) => i.body?.includes(`<!-- ${marker(id)} -->`) && issueUrl(i.html_url));
        if (existing) { r.state="sent";r.issue=existing.html_url;r.result=`Issue created: ${r.issue}`;this.save(r); }
      } catch { /* Keep the uncertain outcome; no automatic retry. */ }
      if (r.state === "attempting") { r.state="uncertain";r.result="Issue creation was interrupted. Check GitHub before submitting it again.";this.save(r); }
    }
    return {state:r.state,result:r.result,...(r.issue ? {issue:r.issue} : {}),...(r.note ? {note:r.note} : {})};
  }
  /** Why images cannot be attached here, or null when they can: gh must be
   *  new enough and the account must be able to write to the repository. */
  private async attachRefusal(): Promise<string | null> {
    const v = await this.cli.version();
    if (!v) return "the GitHub CLI did not report its version";
    if (!newer(v)) return `the GitHub CLI here is ${v}; attaching images needs ${ATTACH_SINCE.join(".")} or later`;
    try {
      const p = (await this.gh(`repos/${FEEDBACK_REPO}`))?.permissions;
      if (!(p?.push || p?.maintain || p?.admin)) return `this GitHub account has no write access to ${FEEDBACK_REPO}`;
    } catch {
      return `GitHub did not say whether this account can write to ${FEEDBACK_REPO}`;
    }
    return null;
  }
  /** A superagent's own report, from its main or a session under it, `by`:
   *  filed as the superagent's, never the person's, and at most
   *  AGENT_REPORTS_PER_DAY a day. */
  async report(by: string, value: unknown): Promise<Receipt> {
    const p = z.object({ request: z.string().uuid(), text: z.string().trim().min(1).max(10000) }).strict().parse(value);
    const agent = this.host.ownerOf(by);
    if (!agent) throw new FleetError(403, "Only a superagent's main conversation or a session under it can file a report");
    if (!this.record(p.request)) {
      const since = Date.now() - 24 * 3_600_000;
      const today = (this.db.query("SELECT body FROM agent_feedback WHERE agent=?").all(agent) as { body: string }[])
        .map((r) => JSON.parse(r.body) as Record).filter((r) => r.by && r.at >= since && r.state !== "refused").length;
      if (today >= AGENT_REPORTS_PER_DAY) return { state: "refused", result: `This agent filed ${today} reports in the last day; at most ${AGENT_REPORTS_PER_DAY}. Keep the finding in a memory note instead.` };
    }
    return this.submit(agent, { request: p.request, text: p.text, target: by }, by);
  }
  async submit(agent: string, value: unknown, by?: string): Promise<Receipt> {
    const p = input.parse(value);
    const a = this.host.profile(agent);
    if (!a) throw new FleetError(404,"Agent not found");
    if (p.target && this.host.ownerOf(p.target) !== agent)
      throw new FleetError(403,"This session does not belong to the reported agent");
    if (CREDENTIAL.test(p.text))
      return {state:"refused",result:"Remove credentials from the report before publishing it."};
    // Ticked images are found by their token's file name among this machine's
    // uploads, never by a path the client gave.
    const images: { n: number; path: string; digest: string }[] = [];
    for (const n of [...new Set(p.publish ?? [])].sort((a, b) => a - b)) {
      const token = new RegExp(`\\[Image #${n}: ([^\\]\\n]*)\\]`).exec(p.text);
      const file = token ? uploadFile(token[1]!.split("/").pop()!.trim()) : null;
      if (!file) return {state:"refused",result:`Image #${n} is not an image uploaded on this machine. Untick it or attach it again.`};
      if (statSync(file.path).size > MAX_ATTACH_BYTES) return {state:"refused",result:`Image #${n} is over 10 MB, GitHub's limit for an attached image. Untick it or attach a smaller one.`};
      images.push({ n, path: file.path, digest: createHash("sha256").update(readFileSync(file.path)).digest("hex") });
    }
    const fingerprint = createHash("sha256").update(JSON.stringify([agent,p.target,p.text,...(images.length ? [images.map((i) => [i.n, i.digest])] : [])])).digest("hex");
    const old = this.record(p.request);
    if (old && (old.agent !== agent || old.fingerprint !== fingerprint)) throw new FleetError(409,"Report request ID was already used for different feedback");
    if (old) return this.active.get(p.request) ?? (await this.receipt(agent,p.request))!;
    const r: Record = {id:p.request,agent,fingerprint,at:Date.now(),state:"attempting",result:"Creating GitHub issue…",...(by ? { by } : {})};
    // Persist before the only external mutation. Every retry reads this record.
    this.save(r);
    const pending = (async (): Promise<Receipt> => {
      try {
        const name = a.title;
        // Images not uploaded keep only their file names (publicText).
        const refusal = images.length ? await this.attachRefusal() : null;
        let text = publicText(p.text);
        if (images.length && !refusal)
          for (const i of images) text = text.replace(new RegExp(`\\[Image #${i.n}: [^\\]\\n]*\\]`), `[Image #${i.n}: attached below]`);
        const list = images.map((i) => `#${i.n}`).join(", ");
        const unsent = refusal ? `Images ${list} were chosen for publication but not uploaded: ${refusal}.` : null;
        const title = `[${by ? "Agent report" : "Agent feedback"}] ${name}: ${text.split(/\r?\n/)[0]}`.slice(0,200);
        const revision = (r: {commit:string;dirty:boolean}|null|undefined) => r ? `${r.commit}${r.dirty ? " (local changes)" : ""}` : "Unavailable";
        const body = `<!-- ${marker(p.request)} -->\n\n## Feedback\n\n${text}\n\n${unsent ? `${unsent}\n\n` : ""}## Agent context\n\n- Agent: ${name}\n- Role: ${a.description}\n- Agent name: ${agent}\n- Session: ${p.target ?? "Not started"}\n- Server revision: ${revision(RUNNING_REVISION)}\n- UI revision: ${revision(p.uiRevision)}\n\n${by ? `Filed by the agent ${name} itself, from session ${by}. No person reviewed it before it was filed.` : "Submitted by the user through Agentbox /help."} No conversation transcript was uploaded.`;
        let url: unknown, partial = false;
        if (images.length && !refusal) ({ url, partial } = await this.cli.createIssue({ title, body, attach: images.map((i) => ({ path: i.path, alt: `Image ${i.n}` })) }));
        else url = (await this.gh(`repos/${FEEDBACK_REPO}/issues`,{title,body})).html_url;
        if (!issueUrl(url)) throw Error("GitHub did not return a verified issue link");
        r.state="sent";r.issue=url;r.result=`Issue created: ${r.issue}`;
        const note = unsent ?? (partial ? `Some of images ${list} did not upload; check the issue.` : null);
        if (note) r.note = note;
      } catch {
        r.state="uncertain";r.result="Could not confirm issue creation. Check GitHub before submitting it again; this request will not be posted twice.";
      }
      this.save(r);
      return {state:r.state,result:r.result,...(r.issue ? {issue:r.issue} : {}),...(r.note ? {note:r.note} : {})};
    })();
    this.active.set(p.request,pending);
    try { return await pending; } finally { this.active.delete(p.request); }
  }
}
