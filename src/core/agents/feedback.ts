/** Human-authored /help reports. GitHub owns the report; this journal keeps
 * only identity, hashes and delivery outcomes, never a conversation copy. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { FleetError } from "../fleet";
import type { AgentsRuntime } from "./runtime";

export const FEEDBACK_REPO = "ammonwk/agentbox";
type Receipt = { state: "sent" | "refused" | "uncertain" | "attempting"; result: string; issue?: string };
type Record = Receipt & { id: string; agent: string; fingerprint: string; at: number };
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
const input = z.object({request:z.string().uuid(), text:z.string().trim().min(1).max(10000), target:z.string().max(200).nullable()}).strict();
const marker = (id: string) => `agentbox-help:${id}`;
const issueUrl = (url: unknown): url is string => typeof url === "string" && /^https:\/\/github\.com\/ammonwk\/agentbox\/issues\/\d+$/.test(url);

export class AgentFeedback {
  private active = new Map<string, Promise<Receipt>>();
  constructor(private runtime: AgentsRuntime, private gh: GitHub = github) {
    runtime.store.db.exec("CREATE TABLE IF NOT EXISTS agent_feedback (id TEXT PRIMARY KEY, agent TEXT NOT NULL, body TEXT NOT NULL)");
  }
  private record(id: string): Record | null {
    const row = this.runtime.store.db.query("SELECT body FROM agent_feedback WHERE id=?").get(id) as {body:string}|null;
    return row ? JSON.parse(row.body) : null;
  }
  private save(r: Record) {
    this.runtime.store.db.run("INSERT OR REPLACE INTO agent_feedback(id,agent,body) VALUES (?,?,?)",[r.id,r.agent,JSON.stringify(r)]);
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
    return {state:r.state,result:r.result,...(r.issue ? {issue:r.issue} : {})};
  }
  async submit(agent: string, value: unknown): Promise<Receipt> {
    const p = input.parse(value);
    const a = this.runtime.conversations.local().find(a => a.id === agent);
    if (!a) throw new FleetError(404,"Agent not found");
    if (p.target && ![a.session,...a.previous,...(a.workSessions ?? [])].includes(p.target))
      throw new FleetError(403,"This session does not belong to the reported agent");
    if (/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|-----BEGIN .*PRIVATE KEY-----|sk-(?:live-|proj-)?[A-Za-z0-9_-]{24,})/.test(p.text))
      return {state:"refused",result:"Remove credentials from the report before publishing it."};
    const fingerprint = createHash("sha256").update(JSON.stringify([agent,p.target,p.text])).digest("hex");
    const old = this.record(p.request);
    if (old && (old.agent !== agent || old.fingerprint !== fingerprint)) throw new FleetError(409,"Report request ID was already used for different feedback");
    if (old) return this.active.get(p.request) ?? (await this.receipt(agent,p.request))!;
    const r: Record = {id:p.request,agent,fingerprint,at:Date.now(),state:"attempting",result:"Creating GitHub issue…"};
    // Persist before the only external mutation. Every retry reads this record.
    this.save(r);
    const pending = (async (): Promise<Receipt> => {
      try {
        const name = a.name.charAt(0).toUpperCase()+a.name.slice(1).toLowerCase();
        const title = `[Agent feedback] ${name}: ${p.text.split(/\r?\n/)[0]}`.slice(0,200);
        const body = `<!-- ${marker(p.request)} -->\n\n## Feedback\n\n${p.text}\n\n## Agent context\n\n- Agent: ${name}\n- Role: ${a.role}\n- Agent ID: ${a.id}\n- Session: ${p.target ?? "Not started"}\n\nSubmitted by the user through Agentbox /help for Vulcan to triage. No conversation transcript was uploaded.`;
        const issue = await this.gh(`repos/${FEEDBACK_REPO}/issues`,{title,body});
        if (!issueUrl(issue.html_url)) throw Error("GitHub did not return a verified issue link");
        r.state="sent";r.issue=issue.html_url;r.result=`Issue created: ${r.issue}`;
      } catch {
        r.state="uncertain";r.result="Could not confirm issue creation. Check GitHub before submitting it again; this request will not be posted twice.";
      }
      this.save(r);
      return {state:r.state,result:r.result,...(r.issue ? {issue:r.issue} : {})};
    })();
    this.active.set(p.request,pending);
    try { return await pending; } finally { this.active.delete(p.request); }
  }
}
