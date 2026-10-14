/** Vulcan's page: Work (families), Feed (recommendations), Grants (the form and the list). */
import { agentbox, block, md, type SuperagentBlock, type SuperagentView } from "../../lib/sdk";
import type { Ctx } from "./ctx";
import { reconcileDelivery } from "./feed";
import { standing } from "./grants";
import type { Grant, Proposal, Work } from "./types";

const short = (s: string | null | undefined) => (s ? s.slice(0, 7) : "—");
const when = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

export async function view(ctx: Ctx, tab: string | null): Promise<SuperagentView> {
  const works = ctx.store.works();
  const proposals = await Promise.all(ctx.store.proposals().map((p) => reconcileDelivery(ctx, p)));
  const open = proposals.filter((p) => p.state === "open").length;
  const active = works.filter((w) => w.state === "working" || w.state === "starting" || w.state === "uncertain").length;
  const tabs = [
    { id: "work", title: "Work", ...(active ? { badge: active } : {}) },
    { id: "feed", title: "Feed", ...(open ? { badge: open } : {}) },
    { id: "grants", title: "Grants" },
  ];
  const blocks = tab === "feed" ? feed(proposals) : tab === "grants" ? await grants(ctx) : work(ctx, works);
  return { tabs, blocks, refresh: 10 };
}

function status(w: Work): { status: "ok" | "warn" | "bad" | "busy" | "idle"; stage: string } {
  if (w.stoppedAt) return { status: "bad", stage: `stopped ${when(w.stoppedAt)}` };
  if (w.state === "quality_failed") return { status: "bad", stage: `quality failed${w.failure?.issue ? ", improvement issue filed" : ""}` };
  if (w.state === "starting") return { status: "busy", stage: "starting the writer" };
  if (w.state === "uncertain") return { status: "warn", stage: "start uncertain: retry start" };
  const p = w.publication;
  if (p?.state === "sent") return { status: "ok", stage: `published #${p.number}, following checks${p.follow?.feedbackWait ? " and feedback" : ""}` };
  if (p) return { status: "warn", stage: `publication ${p.state} at ${p.stage}: reconcile` };
  const r = w.rounds.at(-1);
  if (!r) return { status: "busy", stage: "writing" };
  const done = r.reviewers.filter((x) => x.verdict).length;
  if (done < 3) return { status: "busy", stage: `round ${r.number} of 3: ${done} of 3 verdicts` };
  return { status: r.reviewers.every((x) => x.verdict?.verdict === "clean") ? "ok" : "warn", stage: `round ${r.number} of 3 ${r.reviewers.every((x) => x.verdict?.verdict === "clean") ? "clean: ready to publish" : "found changes"}` };
}

function rounds(w: Work): string {
  if (!w.rounds.length) return "_No review round yet._";
  return w.rounds
    .map((r) => {
      const v = r.reviewers.map((x) => `${x.focus}: ${x.verdict ? (x.verdict.verdict === "clean" ? "clean" : `${x.verdict.findings.length} finding${x.verdict.findings.length === 1 ? "" : "s"}`) : x.state}${x.validationError ? ` (${md(x.validationError)})` : ""}`).join(" · ");
      return `**R${r.number}** ${short(r.base)}…${short(r.head)}: ${v}`;
    })
    .join("\n\n");
}

function work(ctx: Ctx, works: Work[]): SuperagentBlock[] {
  if (!works.length) return [block.heading("Work"), block.markdown("No work families. Prepare one in the chat and start it with `agentbox superagent call vulcan work-start --json family.json` from the requester session.")];
  return [
    block.heading("Work"),
    ...works.map((w): SuperagentBlock => {
      const { status: st, stage } = status(w);
      let grant = "";
      try {
        standing(ctx, w);
      } catch (e) {
        grant = `\n\n**Authority:** ${md((e as Error).message)}`;
      }
      const p = w.publication;
      const body = [
        `Issues: ${w.input.issues.map((i) => `[${md(i.source.replace(/^https:\/\/github\.com\//, ""))}](${i.source})`).join(", ")}`,
        `Base \`${w.input.base}\` at ${short(w.base)}, branch \`${w.branch}\`, writer ${w.provider}, prompt revision \`${w.promptRevision}\`. Accountable: ${md(w.grant.human.name)} (${w.grant.human.github}); publishes as ${w.grant.actor}.`,
        rounds(w),
        p ? `**Publication:** ${p.state}${p.stage ? ` (${p.stage})` : ""} of ${short(p.head)}${p.url ? ` — [#${p.number}](${p.url})` : ""}${p.follow?.note ? `\n\n_${md(p.follow.note)}_` : ""}` : "",
        w.failure ? `**Failure:** ${md(w.failure.summary)} (${w.failure.state}${w.failure.issue ? `, [issue](${w.failure.issue})` : ""})` : "",
        grant,
      ]
        .filter(Boolean)
        .join("\n\n");
      const sessions = [w.session, ...(w.rounds.at(-1)?.reviewers.map((r) => r.session) ?? [])].filter((x): x is string => !!x);
      const links = [...(p?.url ? [{ label: `PR #${p.number}`, url: p.url }] : []), ...(w.failure?.issue ? [{ label: "Improvement issue", url: w.failure.issue }] : [])];
      const actions = [
        ...(w.state === "starting" || w.state === "uncertain" ? [{ id: "work-retry-start", label: "Retry start", values: { id: w.id } }] : []),
        ...(p && p.state !== "sent" ? [{ id: "work-reconcile", label: "Reconcile publication", values: { id: w.id } }] : []),
        ...(w.rounds.at(-1)?.reviewers.some((r) => !r.verdict) ? [{ id: "work-collect", label: "Collect verdicts", values: { id: w.id } }] : []),
        { id: "work-stop", label: "Stop", style: "danger" as const, confirm: "Stop this family's writer and reviewers?", values: { id: w.id } },
        { id: "grant-revoke", label: "Revoke grant", style: "danger" as const, confirm: "Revoke the grant? Every family on it stops.", values: { id: w.grant.id } },
      ];
      return { type: "item", id: w.id, title: `${w.id.slice(0, 8)} · ${w.input.issues.length} issue${w.input.issues.length === 1 ? "" : "s"} in ${w.repo}`, subtitle: stage, status: st, body, sessions, links, actions };
    }),
  ];
}

function feed(proposals: Proposal[]): SuperagentBlock[] {
  if (!proposals.length) return [block.heading("Feed"), block.markdown("No recommendations yet. A writer or Vulcan's chat adds one with `agentbox superagent call vulcan recommend --json proposal.json`.")];
  return [
    block.heading("Feed"),
    ...proposals.map((p): SuperagentBlock => {
      const d = p.delivery;
      const body = [
        md(p.finding),
        p.reason ? `**Why:** ${md(p.reason)}` : "",
        `**Next:** ${md(p.next)}`,
        p.evidence.length ? p.evidence.map((e) => `[${md(e.label || e.url)}](${e.url})`).join(" · ") : "",
        d ? `**Delivery:** ${d.state}${d.result ? ` — ${md(d.result)}` : ""}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        type: "item",
        id: p.id,
        title: p.title,
        subtitle: `${p.state} · ${when(p.createdAt)}${p.work ? ` · work ${p.work.slice(0, 8)}` : " · chat"}`,
        status: p.state === "open" ? "idle" : p.state === "approved" ? (d?.state === "sent" ? "ok" : "warn") : "idle",
        body,
        sessions: [p.run],
        actions:
          p.state === "open"
            ? [
                { id: "feed-approve", label: "Approve", style: "primary", values: { id: p.id } },
                { id: "feed-dismiss", label: "Dismiss", values: { id: p.id } },
                { id: "feed-guide", label: "Give guidance", values: { id: p.id } },
              ]
            : [],
      };
    }),
  ];
}

async function grants(ctx: Ctx): Promise<SuperagentBlock[]> {
  const state = await agentbox.state(false);
  const self = await agentbox.self();
  let actor = "";
  try {
    actor = (await ctx.tools.gh<{ login: string }>("user", undefined, "GET")).login;
  } catch {
    actor = "";
  }
  const repos = state.repos.filter((r) => r.fullName);
  const form: SuperagentBlock = {
    type: "form",
    id: "grant",
    fields: [
      { name: "project", label: "Project", kind: "select", options: repos.map((r) => ({ value: r.id, label: `${r.displayName} (${r.fullName})` })) },
      { name: "humanName", label: "Accountable human", kind: "text", placeholder: "Full name, as the PR title will show it" },
      { name: "humanGithub", label: "Their GitHub login", kind: "text" },
      { name: "actor", label: "Publishing gh login", kind: "text", value: actor, placeholder: "must be the login gh is signed in as" },
      { name: "requiredChecks", label: "Required checks (comma-separated)", kind: "text" },
      { name: "improvementRepo", label: "Improvement issues repo (owner/name)", kind: "text" },
      { name: "days", label: "Expires in", kind: "select", value: "7", options: [1, 2, 3, 5, 7].map((d) => ({ value: String(d), label: `${d} day${d === 1 ? "" : "s"}` })) },
      { name: "requester", label: "Requester session", kind: "text", value: self.main ?? "", placeholder: "Vulcan's main conversation, by default" },
    ],
    actions: [{ id: "grant-create", label: "Create grant", style: "primary" }],
  };
  const list = ctx.store.grants();
  return [
    block.heading("New grant"),
    block.markdown(repos.length ? "A grant lets the requester session start work families on a project, publishing as the gh login below. It lasts at most seven days." : "Register a repository with a GitHub origin first (Projects)."),
    form,
    block.divider(),
    block.heading("Grants"),
    ...(list.length ? list.map((g) => grantItem(g, state.repos.find((r) => r.id === g.project)?.displayName ?? g.project)) : [block.markdown("_None yet._")]),
  ];
}

function grantItem(g: Grant, project: string): SuperagentBlock {
  const now = Date.now();
  const live = !g.revokedAt && g.expires > now;
  return {
    type: "item",
    id: g.id,
    title: `${project} · ${md(g.human.name)} (${g.human.github})`,
    subtitle: g.revokedAt ? `revoked ${when(g.revokedAt)}` : g.expires <= now ? `expired ${when(g.expires)}` : `expires ${when(g.expires)}`,
    status: live ? "ok" : "idle",
    body: `Grant \`${g.id}\`. Publishes as **${g.actor}**; requester ${g.requester}.${g.requiredChecks.length ? ` Required checks: ${g.requiredChecks.map(md).join(", ")}.` : ""}${g.improvementRepo ? ` Improvement issues: ${g.improvementRepo}.` : ""}`,
    sessions: [g.requester],
    actions: live ? [{ id: "grant-revoke", label: "Revoke", style: "danger", confirm: "Revoke this grant? Every family on it stops.", values: { id: g.id } }] : [],
  };
}
