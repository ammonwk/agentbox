/** What Salus remembers: one record per crash, by its source's key. The
 *  provider transcripts are the record of what a triage said; this keeps only
 *  the verdict read from it, and where the crash is in its way to a fix. */
import { z } from "zod";

export type Frame = { file: string; fn: string | null; line: number | null; inApp: boolean };
/** One exception as the source last saw it. Its text is production data: shown to a triage as evidence, never written into an issue. */
export type Sample = { type: string; value: string; frames: Frame[]; url: string | null; lib: string | null };
/** A crash as one poll of the source saw it. */
export type Seen = { key: string; count: number; first: number; last: number; sample: Sample | null };

const note = z.string().trim().min(1).max(8000);

/** The block a triage ends with. Read from its transcript, so nothing else can stand in for it. */
export const TriageVerdict = z
  .object({
    kind: z.literal("salus-triage"),
    verdict: z.enum(["fix", "ignore", "unsure"]),
    severity: z.enum(["high", "medium", "low"]),
    summary: z.string().trim().min(1).max(2000),
    rootCause: z.string().trim().max(8000).default(""),
    /** For ignore and unsure: what the noise is, or what would decide it. */
    reason: z.string().trim().max(4000).default(""),
    fix: z
      .object({
        title: z.string().trim().min(1).max(200),
        repro: note,
        acceptance: note,
        evidence: note,
        preparation: z.object({ problem: note, consumers: note, edges: note, nonGoals: note, design: note, validation: note }).strict(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => v.verdict !== "fix" || !!v.fix, "a fix verdict carries its fix");
export type TriageVerdict = z.infer<typeof TriageVerdict>;

/**
 * new → triaging → triaged → (person) filing → handed → fixing → merged → deployed → verified | recurred.
 * merged: in its base (staging), not yet in production; deployed: a production deploy carries it, and the verify clock runs from there.
 * dismissed: a person said no; a triage of ignore waits for the person like any other.
 */
export type State = "new" | "triaging" | "triaged" | "dismissed" | "filing" | "handed" | "fixing" | "merged" | "deployed" | "verified" | "recurred";

export type Crash = {
  /** The source's key for it (PostHog's issue id, else its fingerprint). */
  id: string;
  title: string;
  firstSeen: number;
  lastSeen: number;
  /** In the source's window at the last poll. */
  count: number;
  sample: Sample | null;
  state: State;
  triage?: {
    /** Its read-only checkout, cut at `base` by agentbox where the session runs ("" until it has started). */
    cwd: string;
    /** The commit of the base branch it reads. */
    base: string;
    startedAt: number;
    /** Null while asked of agentbox and not yet answered: found by its prompt's marker before any second start. */
    session: string | null;
    verdict?: TriageVerdict;
    error?: string;
  };
  issue?: { url: string; number: number };
  /** The Vulcan family Salus prepared; `sendId` makes the hand-off to its main conversation at most once. */
  family?: { id: string; file: string; sendId: string; sentAt?: number };
  pr?: {
    url: string;
    number: number;
    mergedAt?: number;
    closedAt?: number;
    /** The commit the merge made on its base, which a deploy must contain. */
    mergeSha?: string;
    /** The branch it merged into. */
    base?: string;
    /** The first production deploy that contains it: when that run finished, and the run. Null url: the merge was the deploy. */
    deploy?: { at: number; url: string | null; sha: string | null };
    /** When production deploys were last looked through for it. */
    deployCheckedAt?: number;
    /** Set once a person was told no deploy carries it. */
    undeployedCard?: number;
  };
  /** Events before the merge (per `beforeHours`) and after the deploy, as last counted. */
  verify?: { before: number; beforeHours: number; after: number; lastAfter: number | null; needHours: number; checkedAt: number };
  /** What the page should say about where it stands, when the state alone does not. */
  note?: string;
  card?: number;
  createdAt: number;
  updatedAt: number;
};

/** What a crash is called where it leaves Salus's page (cards, pushes): the triage's title, else the exception's type, never its message. */
export const nameOf = (c: Crash): string => c.triage?.verdict?.fix?.title ?? c.sample?.type ?? "a crash";
