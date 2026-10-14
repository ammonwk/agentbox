/** Candidate execution reports, separate from source-review verdicts. The
 * authenticated writer reports execution; Agentbox verifies candidate identity,
 * not that a command ran. No runner or conversation copy lives here. */
import { z } from "zod";
import { FleetError } from "../fleet";

export const CANDIDATE_PROTOCOL = "candidate-evidence-v1" as const;
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const note = z.string().trim().min(1).max(4000);
const reference = z.string().trim().min(1).max(2000);
const Check = z.object({
  kind: z.enum(["typecheck", "acceptance", "other"]),
  command: note.optional(),
  status: z.enum(["passed", "failed", "blocked", "not_run", "not_applicable"]),
  evidence: z.array(reference).max(20),
  startedAt: z.number().int().positive().optional(),
  completedAt: z.number().int().positive().optional(),
  exitCode: z.number().int().min(0).max(255).optional(),
  reason: note.optional(),
}).strict().superRefine((c, ctx) => {
  const executed = c.status === "passed" || c.status === "failed";
  if (c.status !== "not_applicable" && !c.command)
    ctx.addIssue({ code: "custom", message: "Name the actual or planned command" });
  if (executed && (!c.startedAt || !c.completedAt || c.completedAt < c.startedAt ||
      c.exitCode === undefined || !c.evidence.length || (c.status === "passed") !== (c.exitCode === 0)))
    ctx.addIssue({ code: "custom", message: "Executed checks need timestamps, evidence and a matching exit code" });
  if (!executed && (!c.reason || c.exitCode !== undefined || c.startedAt !== undefined || c.completedAt !== undefined))
    ctx.addIssue({ code: "custom", message: "Unexecuted checks need a reason and cannot carry execution results" });
  if (c.status === "not_applicable" && (c.kind !== "typecheck" || c.command !== undefined || !c.evidence.length))
    ctx.addIssue({ code: "custom", message: "Only an inapplicable compiler may be excluded, with repo-specific evidence/reason and no command" });
});

export const CandidateReport = z.object({
  request: z.string().uuid(),
  base: sha,
  head: sha,
  checks: z.array(Check).max(30),
  acceptance: z.array(z.object({
    issue: z.string().url(),
    /** Reference to the existing scenario's producer/pre-action/action/assertion evidence. */
    evidence: reference,
    proof: note,
  }).strict()).max(20),
}).strict();
export type CandidateReport = z.infer<typeof CandidateReport>;
export type CandidateValidation = CandidateReport & {
  protocol: typeof CANDIDATE_PROTOCOL;
  reportedBy: string;
  recordedAt: number;
  cwd: string;
  provenance: "writer_reported";
  state: "unknown" | "failed" | "reported_pass";
  gaps: string[];
};
export type CandidateSubject = {
  validationProtocol?: typeof CANDIDATE_PROTOCOL;
  validations?: CandidateValidation[];
};

export function candidateState(report: CandidateReport, issues: string[], previous: CandidateValidation[] = []) {
  const gaps: string[] = [];
  let failed = report.checks.some((c) => c.status === "failed");
  for (const kind of ["typecheck", "acceptance"] as const)
    if (!report.checks.some((c) => c.kind === kind && (c.status === "passed" || (kind === "typecheck" && c.status === "not_applicable"))))
      gaps.push(`Missing executed ${kind} pass`);
  const key = (c: CandidateReport["checks"][number]) => JSON.stringify([c.kind, c.command]);
  for (const prior of previous.filter((r) => r.base === report.base && r.head === report.head)) {
    for (const c of prior.checks.filter((c) => c.command)) {
      const next = report.checks.find((next) => key(next) === key(c));
      if (!next) gaps.push(`Previously declared check omitted: ${c.command}`);
      if (c.status === "failed" || c.status === "blocked" || c.status === "not_run") {
        const after = c.status === "failed" ? c.completedAt! : prior.recordedAt;
        const resolved = next?.status === "passed" && next.startedAt! >= after && next.completedAt! > after;
        if (!resolved) {
          gaps.push(`A later executed pass is required for: ${c.command}`);
          if (c.status === "failed") failed = true;
        }
      }
    }
  }
  if (report.checks.some((c) => c.status === "blocked" || c.status === "not_run"))
    gaps.push("Declared checks remain unexecuted");
  for (const issue of issues)
    if (!report.acceptance.some((a) => a.issue === issue))
      gaps.push(`Missing discriminating acceptance evidence for ${issue}`);
  const state = failed ? "failed" as const
    : gaps.length ? "unknown" as const : "reported_pass" as const;
  return { state, gaps: [...new Set(gaps)] };
}

export function requireCandidate(w: CandidateSubject, base: string, head: string): CandidateValidation | undefined {
  if (!w.validationProtocol) return;
  if (w.validationProtocol !== CANDIDATE_PROTOCOL) throw new FleetError(409, "Unsupported candidate evidence protocol");
  const report = w.validations?.slice().reverse().find((r) => r.head === head && r.base === base);
  if (!report || report.state !== "reported_pass")
    throw new FleetError(409, `Candidate execution is ${report?.state ?? "unknown"}; record work-validation for this exact base/head before formal review or publication${report?.gaps.length ? ": " + report.gaps.join("; ") : ""}`);
  return report;
}

export const PRE_ACTION_TRACE = {
  revision: "pre-action-proof-v2",
  instruction: "Trace the actual producer/payload through authorization, clocks, admission quotas, deduplication, asynchronous completion and background producers to the assertion. Separate setup capacity from the behavior under test. Prove the relevant state immediately before the action, including absence of premature side effects: could the final assertion pass without that action? If so, acceptance remains ambiguous even after a passing rerun. After each correction re-evaluate the whole enclosing scenario. Use existing customer-boundary tests and network-edge fakes, not a mirrored suite or production-policy bypass. Enqueue/HTTP 202 and source-clean reviews are not executed acceptance.",
} as const;
