/** What Vulcan remembers. The provider transcripts are the record of what any
 *  session said; this is only what they cannot know: grants, claims, rounds,
 *  verdicts, publication stages and decisions. */
import { z } from "zod";

export const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const note = z.string().trim().min(1).max(8000);
export const login = z.string().regex(/^[a-z\d][a-z\d-]{0,38}$/i);
export const FOCUSES = ["architecture", "correctness", "deslop"] as const;
export type Focus = (typeof FOCUSES)[number];
export const ROUND_CAP = 3;
export const MAX_GRANT_MS = 7 * 86_400_000;

export const GrantInput = z
  .object({
    id: z.uuid(),
    /** The coordinator session allowed to start work on it: Vulcan's main, by default. */
    requester: z.string().min(1).max(64),
    /** A registered repo's id. */
    project: z.string().min(1),
    human: z.object({ name: z.string().trim().min(1).max(80), github: login }).strict(),
    /** The gh login that publishes: must be the one gh is logged in as, now and at each publication. */
    actor: login,
    requiredChecks: z.array(z.string().min(1).max(200)).max(50).default([]),
    improvementRepo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .optional(),
    expires: z.number().int().positive(),
  })
  .strict();
export type GrantInput = z.infer<typeof GrantInput>;
export type Grant = GrantInput & { createdAt: number; revokedAt?: number };

export const WorkInput = z
  .object({
    id: z.uuid(),
    grant: z.uuid(),
    /** The writer's CLI; the manifest's default when absent. */
    provider: z.enum(["claude", "codex"]).optional(),
    base: z.string().regex(/^[\w./-]{1,200}$/),
    issues: z
      .array(z.object({ source: z.url(), repro: note, acceptance: note, evidence: note }).strict())
      .min(1)
      .max(20),
    preparation: z.object({ problem: note, consumers: note, edges: note, nonGoals: note, design: note, validation: note }).strict(),
  })
  .strict();
export type WorkInput = z.infer<typeof WorkInput>;

export const ReviewVerdict = z
  .object({
    kind: z.literal("agentbox-review"),
    round: z.number().int().min(1).max(ROUND_CAP),
    focus: z.enum(FOCUSES),
    base: sha,
    head: sha,
    verdict: z.enum(["clean", "changes"]),
    findings: z.array(z.object({ title: z.string().min(1).max(300), evidence: note, remedy: note }).strict()).max(30),
    evidence: z.array(z.string().min(1).max(2000)).min(1).max(200),
  })
  .strict()
  .refine((v) => v.verdict !== "clean" || v.findings.length === 0, "clean verdict cannot retain findings");
export type Verdict = z.infer<typeof ReviewVerdict>;

export type Reviewer = {
  focus: Focus;
  /** Its session, once agentbox answered the start; null while reserved or unproven. */
  session: string | null;
  cwd: string;
  state: "reserved" | "started" | "uncertain";
  verdict?: Verdict;
  validationError?: string;
  retries: string[];
  retired?: string[];
};

export type Round = {
  number: number;
  promptRevision: string;
  base: string;
  head: string;
  validation: string[];
  reviewers: Reviewer[];
  /** The writer's session waits on each reviewer that started. */
  waits?: number[];
};

export type Publication = {
  state: "prepared" | "attempting" | "sent" | "uncertain";
  stage?: "push" | "branch" | "request";
  remoteBefore?: string | null;
  previous?: { state: "sent" | "prepared"; stage?: "branch"; head: string; title: string; body: string; number?: number; url?: string };
  head: string;
  title: string;
  body: string;
  url?: string;
  number?: number;
  /** What follow armed last: the PR claim, the full-check wait and the feedback wait. */
  follow?: { claimedAt: number; wait: number | null; feedbackWait: number | null; note?: string };
};

export type Failure = {
  summary: string;
  findings: { title: string; evidence: string; remedy: string }[];
  key?: string;
  issue?: string;
  state: "recorded" | "attempting" | "sent" | "uncertain";
};

export type Work = {
  id: string;
  input: WorkInput;
  /** The grant as it was when work started: a changed grant is a changed authority. */
  grant: Grant;
  config: string;
  promptRevision: string;
  provider: "claude" | "codex";
  /** `owner/name`, lower-cased. */
  repo: string;
  repoId: string;
  /** The registered checkout the worktree was cut from. */
  checkout: string;
  base: string;
  branch: string;
  /** Vulcan's main conversation when the family started: the writer's parent. */
  main: string;
  /** The writer's worktree and session, once agentbox answered the start. */
  cwd: string | null;
  session: string | null;
  state: "starting" | "working" | "uncertain" | "quality_failed";
  /** A start was asked of agentbox: never asked again without proof of what it did. */
  launch?: { at: number };
  rounds: Round[];
  publication?: Publication;
  failure?: Failure;
  stoppedAt?: number;
  createdAt: number;
};

export const ProposalInput = z
  .object({
    request: z.uuid(),
    title: z.string().min(1).max(200),
    finding: z.string().min(1).max(4000),
    reason: z.string().max(2000).default(""),
    next: z.string().min(1).max(2000),
    evidence: z
      .array(z.object({ url: z.url().refine((s) => /^https?:\/\//.test(s)), label: z.string().max(200) }).strict())
      .max(20)
      .default([]),
  })
  .strict();
export type ProposalInput = z.infer<typeof ProposalInput>;

export type Proposal = {
  id: string;
  /** The session that recommended: Vulcan's main, or a family's writer. */
  run: string;
  work: string | null;
  title: string;
  finding: string;
  reason: string;
  next: string;
  evidence: { url: string; label: string }[];
  state: "open" | "approved" | "dismissed";
  card: number | null;
  createdAt: number;
  decidedAt?: number;
  /** The person who approved or dismissed it (the action's `caller.person`); absent from an agentbox that does not say. */
  decidedBy?: { login: string; name: string };
  delivery?: { request: string; state: "queued" | "sent" | "refused" | "uncertain"; result: string };
};
