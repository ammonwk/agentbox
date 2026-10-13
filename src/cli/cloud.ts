/** `agentbox cloud …`: this machine and the shared agentbox cloud
 *  (docs/cloud.md). Everything but `login` goes through the local server,
 *  which holds the installation credential; `login` signs a human in for
 *  as long as it takes to register this machine, and keeps no human session. */

import { hostname } from "node:os";
import { resolve } from "node:path";
import type { Api } from "../client";
import { HumanCloud, supabaseFor } from "../cloud/client";
import {
  DEFAULT_SCOPES,
  INSTALLATION_NAME_RE,
  type Directory,
  type MessageReceipt,
  type Plan,
  type PlanWithRevision,
  type PublishedPlan,
  type PublishedSkill,
  type Scope,
  type Skill,
  type SkillWithRevision,
} from "../cloud/protocol";
import type { InstallResult, SkillManifest } from "../cloud/skillbundle";
import type { CloudStatus, OutboundResult } from "../core/cloud/bridge";
import { cloudConfig, cloudEnvPath } from "../core/cloud/config";
import type { OutboxRow } from "../core/cloud/store";
import { VERSION } from "../version";
import { parseArgs } from "./sessions";

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const when = (t: string | null): string => (t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

export const CLOUD_USAGE = `cloud (a shared workspace: identity, plans, skills, messages between machines; docs/cloud.md):
  cloud [status]        whether this machine is set up, registered and connected
  cloud login [--email E] [--workspace SLUG | --create NAME] [--invite TOKEN] [--name MACHINE] [--publish]
                        sign in with an emailed code and register this machine; keeps no human session
  cloud logout [--revoke]          forget this machine's credential (--revoke: end it in the cloud too)
  cloud dir             the workspace's machines, whether each takes messages from this one, listed agents
  cloud share <id> [--off]         list a session in the directory, so others can address it
  cloud send <machine>/<id> [--wake] <text…|->   a message to a session on another machine; from an agent,
                        refused like agentbox send, and shown to its reader as untrusted peer content
  cloud messages [--in] [--json]   receipts: what this machine sent (or got) and what became of it
  cloud plan ls | show <slug> [--rev N] | publish <slug> <file|-> [--title T] [--base N] [--summary S]
                        --base is the revision you started from; without it the plan must be new
  cloud skill ls | show <name>[@rev] | installed | install <name>[@rev] [--force]
                        | publish <name|dir> [--base N] [--summary S]
                        install pins a revision and keeps files you edited (--force backs them up and replaces)
  cloud settings [--allow-wake on|off] [--skill-root claude|agents] [--share-emails on|off] [--poll SECONDS]
                        this machine's own cloud settings, never uploaded`;

export async function cloud(api: Api, args: string[]): Promise<number> {
  const [verb = "status", ...rest] = args;
  switch (verb) {
    case "status":
      return status(api);
    case "login":
      return login(api, rest);
    case "logout": {
      const { flags } = parseArgs(rest, [], ["revoke"]);
      const s = await api<CloudStatus>("DELETE", `/api/cloud/installation?callerPid=${process.pid}${flags.has("revoke") ? "&revoke=1" : ""}`);
      console.log(flags.has("revoke") ? "revoked and forgotten: this machine is no longer in the workspace" : "forgotten here; revoke it from the Team page or with --revoke");
      return s.installation ? 1 : 0;
    }
    case "dir":
      return dir(api, rest);
    case "share": {
      const { flags, rest: ids } = parseArgs(rest, [], ["off"]);
      if (!ids[0]) throw new Error("share needs a session id");
      const id = ids[0] === "." ? process.env.AGENTBOX_SESSION : ids[0];
      await api("POST", `/api/cloud/agents/${id}`, { listed: !flags.has("off") });
      console.log(`${id}\t${flags.has("off") ? "unlisted" : "listed"}`);
      return 0;
    }
    case "send":
      return send(api, rest);
    case "messages":
    case "inbox":
    case "outbox":
      return messages(api, verb === "inbox" ? ["--in", ...rest] : rest);
    case "plan":
    case "plans":
      return plan(api, rest);
    case "skill":
    case "skills":
      return skill(api, rest);
    case "settings":
      return settings(api, rest);
    default:
      throw new Error(`unknown cloud verb "${verb}"\n${CLOUD_USAGE}`);
  }
}

async function status(api: Api): Promise<number> {
  const s = await api<CloudStatus>("GET", "/api/cloud");
  if (!s.configured) {
    console.log(s.configError ? `not set up: ${s.configError}` : `local only: no cloud is set up (put AGENTBOX_CLOUD_URL and AGENTBOX_CLOUD_PUBLISHABLE_KEY in ${cloudEnvPath()})`);
    return s.configError ? 1 : 0;
  }
  console.log(`cloud\t${s.url}`);
  if (!s.installation) {
    console.log("machine\tnot registered: `agentbox cloud login`, or the Team page");
    return 0;
  }
  const h = s.hello;
  console.log(`machine\t${s.installation.name} (${s.installation.id})`);
  console.log(`workspace\t${s.installation.workspaceSlug}${h ? ` · owner ${h.owner.email} · scopes ${h.installation.scopes.join(", ")}` : ""}`);
  console.log(`state\t${s.state}${s.lastError ? ` — ${s.lastError}` : ""}${s.lastOkAt ? ` · last ok ${new Date(s.lastOkAt).toLocaleTimeString()}` : ""}`);
  const c = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
  console.log(`outbox\t${c(s.counts.outbox)}\ninbox\t${c(s.counts.inbox)}`);
  return s.state === "connected" ? 0 : 1;
}

async function login(api: Api, args: string[]): Promise<number> {
  const { flags } = parseArgs(args, ["email", "workspace", "create", "invite", "name"], ["publish"]);
  // Registering is the person's to do: ask before anything is created.
  await api("POST", "/api/cloud/installation", { check: true, callerPid: process.pid });
  const { config, error } = cloudConfig();
  if (!config) throw new Error(error ?? `no cloud is set up: put AGENTBOX_CLOUD_URL and AGENTBOX_CLOUD_PUBLISHABLE_KEY in ${cloudEnvPath()} (docs/cloud.md)`);
  const email = str(flags.get("email")) ?? prompt("email:")?.trim();
  if (!email) throw new Error("login needs an email");
  // In memory only: the session ends with this command.
  const human = new HumanCloud(supabaseFor(config));
  await human.sendCode(email);
  const code = prompt(`a sign-in code was sent to ${email}; code:`)?.trim();
  if (!code) throw new Error("no code");
  let me = await human.verifyCode(email, code);
  try {
    const invite = str(flags.get("invite"));
    if (invite) {
      const joined = await human.acceptInvite(invite);
      console.log(`joined as ${joined.role}${joined.already ? " (already a member)" : ""}`);
      me = await human.me();
    }
    let workspaceId: string;
    const create = str(flags.get("create"));
    const slug = str(flags.get("workspace"));
    if (create) {
      const ws = await human.createWorkspace(create, slug ?? create.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
      workspaceId = ws.id;
      console.log(`created workspace ${ws.slug}`);
    } else {
      const pick = slug ? me.memberships.find((m) => m.workspace.slug === slug) : me.memberships.length === 1 ? me.memberships[0] : undefined;
      if (!pick) {
        const have = me.memberships.map((m) => m.workspace.slug).join(", ") || "none";
        throw new Error(`name a workspace with --workspace (yours: ${have}), make one with --create NAME, or join one with --invite TOKEN`);
      }
      workspaceId = pick.workspace.id;
    }
    const name = str(flags.get("name")) ?? hostname().split(".")[0]!.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48);
    if (!INSTALLATION_NAME_RE.test(name)) throw new Error(`"${name}" cannot name a machine: letters, digits, . _ - (--name)`);
    const scopes: Scope[] = flags.has("publish") ? [...DEFAULT_SCOPES, "artifacts:publish"] : DEFAULT_SCOPES;
    const reg = await human.registerInstallation(workspaceId, name, { platform: process.platform, version: VERSION, scopes });
    let s: CloudStatus;
    try {
      s = await api<CloudStatus>("POST", "/api/cloud/installation", { secret: reg.secret, callerPid: process.pid });
    } catch (e) {
      // The machine did not take it: no installation is left without its secret.
      await human.revokeInstallation(reg.installation.id).catch(() => undefined);
      throw e;
    }
    console.log(`registered ${s.installation?.name} in ${s.installation?.workspaceSlug} (${reg.installation.scopes.join(", ")}); ${s.state}`);
    return 0;
  } finally {
    await human.signOut();
  }
}

async function dir(api: Api, args: string[]): Promise<number> {
  const { flags } = parseArgs(args, [], ["json"]);
  const d = await api<Directory>("GET", "/api/cloud/directory?fresh=1");
  if (flags.has("json")) {
    console.log(JSON.stringify(d, null, 2));
    return 0;
  }
  for (const i of d.installations) {
    console.log(`${i.name}\t${i.owner.email}\t${i.accepts_from_me ? "takes your messages" : `no: ${i.refusal}`}\tseen ${when(i.last_seen_at)}`);
    for (const a of d.agents.filter((x) => x.installation_id === i.id)) console.log(`  ${i.name}/${a.local_session_id}\t${a.provider ?? ""}\t${a.label ?? ""}`);
  }
  return 0;
}

async function send(api: Api, args: string[]): Promise<number> {
  const { flags, rest } = parseArgs(args, ["id"], ["wake"]);
  const [to, ...words] = rest;
  if (!to) throw new Error("send needs an address: <machine>/<session id> (agentbox cloud dir)");
  const text = words.length === 1 && words[0] === "-" ? (await new Response(Bun.stdin.stream()).text()).trim() : words.join(" ");
  if (!text) throw new Error("send needs the message (words, or - to read stdin)");
  const r = await api<OutboundResult>("POST", "/api/cloud/messages", {
    to,
    text,
    wake: flags.has("wake"),
    clientId: str(flags.get("id")),
    fromSession: process.env.AGENTBOX_SESSION,
    callerPid: process.pid,
  });
  const where = r.message ? `${r.message.state}${r.message.reason ? `: ${r.message.reason}` : ""}` : r.state === "pending" ? `queued here: the cloud did not answer${r.error ? ` (${r.error})` : ""}, and it is sent as soon as it does` : r.state;
  console.log(`${r.message?.id ?? r.clientId}\t${r.to}\t${where}`);
  return 0;
}

async function messages(api: Api, args: string[]): Promise<number> {
  const { flags } = parseArgs(args, ["n"], ["in", "json"]);
  const box = flags.has("in") ? "in" : "out";
  const r = await api<{ cloud: MessageReceipt[]; queued: OutboxRow[] }>("GET", `/api/cloud/messages?box=${box}&limit=${str(flags.get("n")) ?? 30}`);
  if (flags.has("json")) {
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  for (const q of r.queued) console.log(`${q.client_id}\t${q.target_name}/${q.target_agent}\t${q.state === "pending" ? "queued here" : q.state}${q.error ? `: ${q.error}` : ""}`);
  for (const m of r.cloud) {
    const peer = box === "out" ? `${m.target_installation_name ?? m.target_installation_id}/${m.target_agent ?? ""}` : m.sender_label;
    console.log(`${m.id}\t${when(m.created_at)}\t${peer}\t${m.state}${m.reason ? `: ${m.reason}` : ""}`);
  }
  return 0;
}

async function plan(api: Api, args: string[]): Promise<number> {
  const [verb = "ls", ...rest] = args;
  if (verb === "ls") {
    for (const p of await api<Plan[]>("GET", "/api/cloud/plans")) console.log(`${p.slug}\trev ${p.latest_rev}\t${when(p.updated_at)}\t${p.title}`);
    return 0;
  }
  if (verb === "show") {
    const { flags, rest: r } = parseArgs(rest, ["rev"]);
    if (!r[0]) throw new Error("plan show needs a slug");
    const p = await api<PlanWithRevision>("GET", `/api/cloud/plans/${encodeURIComponent(r[0])}${flags.has("rev") ? `?rev=${str(flags.get("rev"))}` : ""}`);
    console.error(`# ${p.plan.slug} rev ${p.revision.rev} of ${p.plan.latest_rev} · ${when(p.revision.created_at)}${p.revision.summary ? ` · ${p.revision.summary}` : ""}`);
    console.log(p.revision.body ?? "");
    return 0;
  }
  if (verb === "publish") {
    const { flags, rest: r } = parseArgs(rest, ["title", "base", "summary"]);
    const [slug, file] = r;
    if (!slug || !file) throw new Error("plan publish needs a slug and a file (or - for stdin)");
    const body = file === "-" ? await new Response(Bun.stdin.stream()).text() : await Bun.file(resolve(file)).text();
    const title = str(flags.get("title")) ?? /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? slug;
    const p = await api<PublishedPlan>("POST", "/api/cloud/plans", {
      slug,
      title,
      body,
      baseRev: flags.has("base") ? Number(str(flags.get("base"))) : undefined,
      summary: str(flags.get("summary")),
    });
    console.log(`${p.plan.slug}\trev ${p.revision.rev}${p.unchanged ? "\tunchanged (already the latest)" : ""}`);
    return 0;
  }
  throw new Error("plan takes ls, show or publish");
}

function nameRev(arg: string | undefined): { name: string; rev: number | null } {
  if (!arg) throw new Error("name a skill");
  const [name, rev] = arg.split("@");
  return { name: name!, rev: rev ? Number(rev) : null };
}

async function skill(api: Api, args: string[]): Promise<number> {
  const [verb = "ls", ...rest] = args;
  if (verb === "ls") {
    for (const s of await api<Skill[]>("GET", "/api/cloud/skills")) console.log(`${s.name}\trev ${s.latest_rev}\t${when(s.updated_at)}\t${s.description.split("\n")[0]}`);
    return 0;
  }
  if (verb === "installed") {
    for (const s of await api<{ dir: string; manifest: SkillManifest }[]>("GET", "/api/cloud/installed-skills")) {
      console.log(`${s.manifest.name}@${s.manifest.rev}\t${s.manifest.source.workspaceSlug}\t${s.dir}${s.manifest.kept.length ? `\tkept your edits: ${s.manifest.kept.join(", ")}` : ""}`);
    }
    return 0;
  }
  if (verb === "show") {
    const { name, rev } = nameRev(rest[0]);
    const s = await api<SkillWithRevision>("GET", `/api/cloud/skills/${encodeURIComponent(name)}${rev ? `?rev=${rev}` : ""}`);
    console.log(`${s.skill.name} rev ${s.revision.rev} of ${s.skill.latest_rev} · ${s.revision.total_bytes} bytes · ${when(s.revision.created_at)}`);
    for (const f of s.revision.files ?? []) console.log(`  ${f.path}\t${f.bytes}`);
    return 0;
  }
  if (verb === "install") {
    const { flags, rest: r } = parseArgs(rest, [], ["force"]);
    const { name, rev } = nameRev(r[0]);
    // Pinned: "latest" is looked up here and installed by its number.
    const pinned = rev ?? (await api<SkillWithRevision>("GET", `/api/cloud/skills/${encodeURIComponent(name)}`)).skill.latest_rev;
    const out = await api<InstallResult>("POST", `/api/cloud/skills/${encodeURIComponent(name)}/install`, { rev: pinned, force: flags.has("force"), callerPid: process.pid });
    console.log(`${out.name}@${out.rev}\t${out.dir}\t${out.written.length} written, ${out.same.length} unchanged, ${out.removed.length} removed`);
    for (const k of out.kept) console.log(`  kept your ${k.path}; this revision's copy: ${k.incoming}`);
    for (const k of out.replaced) console.log(`  replaced your ${k.path}; your copy: ${k.backup}`);
    for (const o of out.orphaned) console.log(`  left your ${o}, which this revision dropped`);
    return 0;
  }
  if (verb === "publish") {
    const { flags, rest: r } = parseArgs(rest, ["base", "summary"]);
    const target = r[0];
    if (!target) throw new Error("skill publish needs a local skill's name or directory");
    const isPath = target.includes("/") || target === ".";
    const p = await api<PublishedSkill>("POST", "/api/cloud/skills/publish", {
      name: isPath ? undefined : target,
      path: isPath ? resolve(target) : undefined,
      baseRev: flags.has("base") ? Number(str(flags.get("base"))) : undefined,
      summary: str(flags.get("summary")),
      callerPid: process.pid,
    });
    console.log(`${p.skill.name}\trev ${p.revision.rev}${p.unchanged ? "\tunchanged (already the latest)" : ""}`);
    return 0;
  }
  throw new Error("skill takes ls, show, installed, install or publish");
}

async function settings(api: Api, args: string[]): Promise<number> {
  const { flags } = parseArgs(args, ["allow-wake", "skill-root", "share-emails", "poll"]);
  const onOff = (k: string): boolean | undefined => {
    const v = str(flags.get(k));
    if (v === undefined) return undefined;
    if (v !== "on" && v !== "off") throw new Error(`--${k} takes on or off`);
    return v === "on";
  };
  const patch = {
    allowRemoteWake: onOff("allow-wake"),
    shareAccountEmails: onOff("share-emails"),
    skillRoot: str(flags.get("skill-root")),
    pollSeconds: flags.has("poll") ? Number(str(flags.get("poll"))) : undefined,
    callerPid: process.pid,
  };
  const s = flags.size > 0 ? await api<CloudStatus["settings"]>("PUT", "/api/cloud/settings", patch) : (await api<CloudStatus>("GET", "/api/cloud")).settings;
  for (const [k, v] of Object.entries(s)) console.log(`${k}\t${v}`);
  return 0;
}
