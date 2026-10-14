/** Shared review budgets belong to the cloud work item, across run and host
 * replacement. Reviewer conversation bodies stay on their execution host. */
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalSource } from "../../cloud/agents";
import { FleetError, newSessionId } from "../fleet";
import { Waits } from "../waits";
import { AgentReviews, type ReviewRound, type ReviewSubject } from "./reviews";
import type { AgentsRuntime } from "./runtime";
import type { GitHubAction } from "./github";
import { agentPrTitle } from "./work";

const note = z.string().trim().min(1).max(8000);
const Preparation = z
  .object({
    problem: note,
    consumers: note,
    edges: note,
    nonGoals: note,
    design: note,
    validation: note,
  })
  .strict();
const Prepared = z
  .object({
    base: z.string().regex(/^[\w./-]{1,200}$/),
    preparation: Preparation,
  })
  .strict();
type Ledger = {
  revision: number;
  human: { id: string; name: string };
  body: {
    prepared?: z.infer<typeof Prepared>;
    state: string;
    rounds: ReviewRound[];
  };
};
const LedgerSchema = z.object({
  revision: z.number().int(),
  human: z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
  }),
  body: z.object({
    prepared: Prepared.optional(),
    state: z.enum(["working", "quality_failed"]),
    rounds: z.array(z.unknown()).max(3),
  }),
});
const git = async (cwd: string, ...args: string[]) => {
  const p = Bun.spawn(["git", "--no-pager", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000,
  });
  const [out, , code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code)
    throw new FleetError(
      409,
      "Could not read the review candidate; fetch the authorized base into this checkout first",
    );
  return out.trim();
};
export class SharedReviews {
  private busy = new Set<string>();
  private fallback?: Waits;
  constructor(private runtime: AgentsRuntime) {}
  private async context(id: string, caller: string | null) {
    const c = await this.runtime.current(id, caller),
      work = c.board.work.find((w) => w.id === c.run.work_id)!;
    const repo = canonicalSource(work.source_url).repo;
    if (
      !repo ||
      work.external_key.startsWith("conversation:") ||
      !c.a.definition.repos.includes(repo)
    )
      throw new FleetError(403, "Reviews require the scoped repository writer");
    const cwd = this.runtime.fleet
      .sessions()
      .find((s) => s.id === c.local.session)?.cwd;
    if (!cwd) throw new FleetError(409, "Writer checkout is unavailable");
    const api = this.runtime.api();
    const args = { p_run: c.run.id, p_fence: c.run.fence };
    const ledger = (await api.installation.agentCall(
      "inst_agent_review_load",
      args,
      LedgerSchema,
    )) as Ledger;
    const subject: ReviewSubject = {
      id: work.id,
      repo,
      cwd,
      session: c.local.session,
      agent: c.a,
      input: {
        source: work.source_url,
        acceptance: work.acceptance,
        ...ledger.body.prepared,
      },
      state: ledger.body.state,
      rounds: ledger.body.rounds,
      installation: c.run.installation_id ?? undefined,
      context: createHash("sha256")
        .update(
          JSON.stringify([
            c.a.id,
            c.a.definition,
            c.a.name,
            ledger.human,
            repo,
            ledger.body.prepared,
          ]),
        )
        .digest("hex"),
    };
    const save = async () => {
      if (
        /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+|-----BEGIN .*PRIVATE KEY-----|sk-(?:live-|proj-)?[A-Za-z0-9_-]{24,})/.test(
          JSON.stringify(ledger.body),
        )
      )
        throw new FleetError(
          400,
          "Remove credentials from review preparation and evidence",
        );
      ledger.body.state = subject.state;
      ledger.body.rounds = subject.rounds;
      ledger.revision = await api.installation.agentCall(
        "inst_agent_review_save",
        { ...args, p_revision: ledger.revision, p_body: ledger.body },
        z.number().int(),
      );
    };
    const engine = new AgentReviews({
      fleet: this.runtime.fleet,
      waits:
        this.runtime.waits ?? (this.fallback ??= new Waits(this.runtime.fleet)),
      git,
      authorize: () => this.runtime.current(id, caller),
      save,
      reserve: (r) =>
        this.runtime.store.reserveReviewer(r.session, c.run.id, work.id, r.cwd),
      adopt: (r) =>
        this.runtime.store.adoptReviewer(r.session, c.run.id, work.id, r.cwd),
    });
    return { ...c, work, repo, cwd, ledger, subject, engine, save };
  }
  async operation(
    id: string,
    caller: string | null,
    verb: "prepare" | "review" | "collect" | "retry-review",
    input: unknown,
  ) {
    const c = await this.context(id, caller),
      key = c.work.id;
    if (this.busy.has(key))
      throw new FleetError(409, "Another review operation is in progress");
    this.busy.add(key);
    try {
      if (verb === "prepare") {
        const prepared = Prepared.parse(input);
        if (
          c.ledger.body.prepared &&
          JSON.stringify(c.ledger.body.prepared) !== JSON.stringify(prepared)
        )
          throw new FleetError(
            409,
            "Preparation is already pinned to this work item",
          );
        c.ledger.body.prepared = prepared;
        await c.save();
        return c.ledger.body;
      }
      if (!c.ledger.body.prepared)
        throw new FleetError(
          409,
          "Record preparation before editing with agent prepare",
        );
      const last = c.subject.rounds.at(-1);
      let result: unknown;
      if (verb === "collect") result = await c.engine.collect(c.subject);
      else if (verb === "retry-review") {
        const { focus } = z
          .object({ focus: z.enum(["architecture", "correctness", "deslop"]) })
          .strict()
          .parse(input);
        const r = last?.reviewers.find((r) => r.focus === focus);
        const previous = r?.installation ?? last?.installation;
        if (
          r &&
          !r.verdict &&
          previous &&
          previous !== c.subject.installation
        ) {
          // The old host is fenced out. Only an unfinished read-only reviewer
          // gets a new local reservation; completed verdicts remain immutable.
          if ((await git(c.cwd, "cat-file", "-t", last!.head)) !== "commit")
            throw new FleetError(
              409,
              "Restore the pinned candidate before reviewer handoff",
            );
          r.previousHosts = [
            ...(r.previousHosts ?? []),
            { installation: previous, session: r.session },
          ];
          r.session = newSessionId();
          r.installation = c.subject.installation;
          r.cwd = join(
            dirname(c.cwd),
            `agent-review-${c.work.id}-${last!.number}-${focus}-${c.subject.installation!.slice(0, 8)}`,
          );
          r.state = "reserved";
          r.retries.push("Execution-host handoff; same candidate and round");
          this.runtime.store.reserveReviewer(
            r.session,
            c.run.id,
            c.work.id,
            r.cwd,
          );
          await c.save();
        }
        result = await c.engine.retry(c.subject, input);
      } else {
        const { validation } = z
          .object({
            validation: z.array(z.string().min(1).max(2000)).min(1).max(50),
          })
          .strict()
          .parse(input);
        if (await git(c.cwd, "status", "--porcelain"))
          throw new FleetError(409, "Commit the candidate before review");
        const head = await git(c.cwd, "rev-parse", "HEAD"),
          base = await this.runtime.github.reviewBase(
            c.a,
            this.runtime.binding(c.a),
            c.repo,
            c.ledger.body.prepared.base,
          );
        if ((await git(c.cwd, "merge-base", base, head)) !== base)
          throw new FleetError(409, "Include the current base before review");
        result = await c.engine.start(c.subject, base, head, validation);
      }
      if (c.subject.state === "quality_failed") {
        await this.runtime.progress(
          id,
          caller,
          {
            stage: "in_progress",
            next: "Stop this attempt before R4; the accountable human must record the quality/process failure and deduplicate an improvement issue",
            outcome: "Three review rounds did not produce a clean candidate",
            evidence: [],
          },
          "Three-round quality cap reached",
        );
        this.runtime.cards.add({
          kind: "decision",
          notify: false,
          key: `agent-quality:${key}`,
          sessionId: c.local.session,
          title: `${c.a.name}: three-round quality failure`,
          short:
            "Stop this attempt. Record the missed edge case and process cause, then file a deduplicated improvement issue in the authorized product repository. Do not start R4.",
          long: `Work ${key}; review verdicts are in the durable shared work journal.`,
          recommend: null,
        });
      }
      return result;
    } finally {
      this.busy.delete(key);
    }
  }
  async guard(
    id: string,
    caller: string | null,
    action: GitHubAction,
    format = false,
  ): Promise<GitHubAction> {
    if (
      action.kind !== "open_pr" &&
      action.kind !== "update_pr" &&
      action.kind !== "ready_pr" &&
      action.kind !== "merge_pr"
    )
      return action;
    const c = await this.context(id, caller),
      prepared = c.ledger.body.prepared;
    if (
      !prepared ||
      !("base" in action) ||
      action.repo !== c.repo ||
      action.base !== prepared.base
    )
      throw new FleetError(
        409,
        "Publication does not match the prepared work repository/base",
      );
    const base = await this.runtime.github.reviewBase(
      c.a,
      this.runtime.binding(c.a),
      c.repo,
      prepared.base,
    );
    let head = action.head;
    if (action.kind === "ready_pr" || action.kind === "merge_pr") {
      const remoteHead = action.head;
      const mapping = await this.runtime.api().installation.agentCall(
        "inst_agent_publication_lookup",
        {
          p_run: id,
          p_fence: c.run.fence,
          p_head: remoteHead,
          p_number: action.number,
        },
        z
          .object({
            base: z.string(),
            head: z.string(),
            tree: z.string(),
            remoteHead: z.string(),
          })
          .nullable(),
      );
      if (!mapping || mapping.base !== base)
        throw new FleetError(
          409,
          "The remote commit has no verified reviewed-tree publication receipt",
        );
      head = mapping.head;
      const pull = z
        .object({ title: z.string() })
        .parse(
          await this.runtime.github.read(c.a, this.runtime.binding(c.a), {
            repo: c.repo,
            kind: "pull",
            number: action.number,
          }),
        );
      if (
        pull.title !==
        agentPrTitle(c.a.name, c.ledger.human.name, pull.title).slice(0, 200)
      )
        throw new FleetError(
          409,
          "Update the PR title for its current accountable human before advancing it",
        );
    } else {
      if (
        (await git(c.cwd, "rev-parse", "HEAD")) !== action.head ||
        (await git(c.cwd, "status", "--porcelain"))
      )
        throw new FleetError(
          409,
          "The reviewed checkout changed before publication",
        );
      const title = agentPrTitle(
        c.a.name,
        c.ledger.human.name,
        action.title,
      ).slice(0, 200);
      if (format) action = { ...action, title };
      else if (action.title !== title)
        throw new FleetError(
          409,
          "Accountable human or agent title changed; prepare a new action",
        );
    }
    c.engine.assertReviewed(c.subject, base, head);
    return action;
  }
}
