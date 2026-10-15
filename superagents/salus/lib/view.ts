/** Salus's page: what needs a person, what is under way, what is done, and its settings. */
import { agentbox, md, type SuperagentAction, type SuperagentBlock, type SuperagentView } from "../../lib/sdk";
import type { Ctx } from "./ctx";
import { readKey, keyFile } from "./settings";
import type { Status } from "./tick";
import type { Crash, State } from "./types";

const DECIDE: State[] = ["triaged", "recurred"];
const WORK: State[] = ["new", "triaging", "filing", "handed", "fixing", "merged"];
const DONE: State[] = ["verified", "dismissed"];

export async function view(ctx: Ctx, tab: string | null): Promise<SuperagentView> {
  const all = ctx.store.crashes();
  const of = (states: State[]) => all.filter((c) => states.includes(c.state));
  const decide = of(DECIDE);
  const tabs = [
    { id: "decide", title: "Decide", badge: decide.length || undefined },
    { id: "work", title: "Under way", badge: of(WORK).length || undefined },
    { id: "done", title: "Done" },
    { id: "settings", title: "Settings" },
  ];
  const t = tabs.some((x) => x.id === tab) ? tab! : "decide";
  if (t === "settings") return { tabs, blocks: await settingsBlocks(ctx) };
  const list = t === "decide" ? decide : t === "work" ? of(WORK) : of(DONE);
  const s = ctx.settings();
  const intro: SuperagentBlock[] = [];
  if (!s.enabled) intro.push({ type: "markdown", text: "Salus is **off**. Set it up and turn it on under Settings." });
  const poll = ctx.store.get<Status>("poll");
  if (poll && !poll.ok) intro.push({ type: "item", title: "The last poll failed", subtitle: ago(poll.at), status: "bad", body: md(poll.message) });
  const empty = { decide: "Nothing waits for you.", work: "Nothing under way.", done: "Nothing done yet." }[t]!;
  return { tabs, blocks: [...intro, ...(list.length ? list.map((c) => item(ctx, c)) : [{ type: "markdown", text: empty } as SuperagentBlock])], refresh: 30 };
}

function item(ctx: Ctx, c: Crash): SuperagentBlock {
  const v = c.triage?.verdict;
  const s = ctx.settings();
  const src = ctx.source();
  const body: string[] = [];
  if (v) body.push(`**${v.verdict}** · ${v.severity} · ${md(v.summary)}`, v.rootCause ? `\n**Root cause.** ${md(v.rootCause)}` : "", v.reason ? `\n${md(v.reason)}` : "");
  if (v?.fix) body.push(`\n**Proposed:** ${md(v.fix.title)}\n\n**Acceptance.** ${md(v.fix.acceptance)}`);
  if (c.triage?.error) body.push(`The triage gave no verdict: ${md(c.triage.error)}`);
  if (c.state === "merged" && c.verify) {
    const quiet = (Date.now() - Math.max(c.verify.lastAfter ?? 0, c.pr!.mergedAt!)) / 3_600_000;
    body.push(`Merged ${ago(c.pr!.mergedAt!)}: ${c.verify.after} since (before: ${c.verify.before} in ${c.verify.beforeHours} hours). Quiet ${Math.floor(quiet)} of the ${Math.ceil(c.verify.needHours)} hours that make it verified.`);
  }
  if (c.note) body.push(`\n_${md(c.note)}_`);
  const links = [
    ...(src ? [{ label: "PostHog", url: src.link(c.id) }] : []),
    ...(c.issue ? [{ label: `Issue #${c.issue.number}`, url: c.issue.url }] : []),
    ...(c.pr ? [{ label: `PR #${c.pr.number}`, url: c.pr.url }] : []),
  ];
  return {
    type: "item",
    id: c.id,
    title: c.title,
    subtitle: `${c.count} in ${s.windowHours}h · last ${ago(c.lastSeen)} · ${c.state}`,
    status: statusOf(c),
    body: body.filter(Boolean).join("\n"),
    sessions: c.triage?.session ? [c.triage.session] : [],
    links,
    actions: actionsOf(c, s.fixer),
  };
}

function statusOf(c: Crash): "ok" | "warn" | "bad" | "busy" | "idle" {
  if (c.state === "verified") return "ok";
  if (c.state === "dismissed") return "idle";
  if (c.state === "recurred" || c.triage?.verdict?.severity === "high") return "bad";
  if (c.state === "triaged") return "warn";
  return "busy";
}

function actionsOf(c: Crash, fixer: string): SuperagentAction[] {
  const id = { id: c.id };
  const again: SuperagentAction = { id: "retriage", label: "Triage again", values: id };
  const dismiss: SuperagentAction = { id: "dismiss", label: "Dismiss", values: id };
  switch (c.state) {
    case "triaged":
      return [
        ...(c.triage?.verdict?.fix ? [{ id: "fix", label: "Fix", style: "primary" as const, confirm: `File the issue and hand it to ${fixer}?`, values: id }] : []),
        dismiss,
        again,
      ];
    case "filing":
      return [{ id: "fix", label: "Finish filing", style: "primary", values: id }];
    case "recurred":
      return [again, dismiss];
    case "dismissed":
      return [{ ...again, label: "Reopen and triage" }];
    default:
      return [];
  }
}

async function settingsBlocks(ctx: Ctx): Promise<SuperagentBlock[]> {
  const s = ctx.settings();
  const repos = (await agentbox.state(false)).repos;
  const poll = ctx.store.get<Status>("poll");
  const num = (name: keyof typeof s, label: string) => ({ name, label, kind: "text" as const, value: String(s[name]) });
  return [
    {
      type: "fields",
      items: [
        { label: "PostHog key", value: readKey(ctx.home) ? "present" : `missing: put a personal API key with query:read in ${keyFile(ctx.home)}` },
        { label: "Last poll", value: poll ? `${ago(poll.at)}: ${poll.message}` : "never" },
      ],
    },
    {
      type: "form",
      id: "settings",
      fields: [
        { name: "enabled", label: "On", kind: "checkbox", value: s.enabled },
        { name: "posthogHost", label: "PostHog host", kind: "text", value: s.posthogHost },
        { name: "projectId", label: "PostHog project id", kind: "text", value: s.projectId },
        { name: "repo", label: "Repository", kind: "select", value: s.repo, options: [{ value: "", label: "Choose…" }, ...repos.map((r) => ({ value: r.id, label: r.fullName ?? r.displayName }))] },
        { name: "base", label: "Base branch (empty: the repository's default)", kind: "text", value: s.base },
        { name: "fixer", label: "Fixes go to (superagent)", kind: "text", value: s.fixer },
        num("windowHours", "Window (hours)"),
        num("minCount", "Look at a crash once it happened this often in the window"),
        num("pollMinutes", "Poll every (minutes)"),
        num("triagePerDay", "Triages a day at most"),
        num("triageAtOnce", "Triages at once at most"),
        num("deployLagHours", "Still happening this long after the merge means not fixed (hours)"),
      ],
      actions: [
        { id: "settings-save", label: "Save", style: "primary" },
        { id: "poll", label: "Poll now" },
      ],
    },
  ];
}

export function ago(at: number, now = Date.now()): string {
  const m = Math.round((now - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
