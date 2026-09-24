import { describe, expect, test } from "bun:test";
import type { AccountUsage, Attention, AttentionKind, Candidate, ClaimView, Placement, TimelineEvent, UsageWindow } from "../../../src/core/types";
import { EMPTY_FILTER, filterSessions, neighbourId, sectionsOf, sortByAttention, titleOf, type SessionRow } from "./board";
import { fmtCountdown, fmtPts } from "./format";
import { arrow, candidateCells, candidateTable, placementHeadline } from "./placement";
import { firstLine, groupTimeline, mergeTimeline } from "./timeline";
import { barSegments, headlineWindows, outstandingOf, resetText, shortClaimPct, sortWindows, usageSummary, usageTone, windowElapsed, windowLabel } from "./usage";

const M = 60_000;
const H = 60 * M;
const D = 24 * H;

// ---------------------------------------------------------------- timeline

const user = (id: string, at: number, text = "hi"): TimelineEvent => ({ id, at, kind: "user", text });
const tool = (id: string, at: number, status: "running" | "ok" | "error", output?: string): TimelineEvent => ({
  id,
  at,
  kind: "tool",
  name: "Bash",
  summary: "ls",
  status,
  ...(output ? { output } : {}),
});

describe("mergeTimeline", () => {
  test("a reset into nothing sorts by time", () => {
    const out = mergeTimeline([], [user("b", 2), user("a", 1)]);
    expect(out.map((e) => e.id)).toEqual(["a", "b"]);
  });

  test("a re-sent tool event replaces the held one in place, not appended", () => {
    const held = mergeTimeline([], [user("u", 1), tool("t", 2, "running"), user("v", 3)]);
    const next = mergeTimeline(held, [tool("t", 2, "ok", "done")]);
    expect(next.map((e) => e.id)).toEqual(["u", "t", "v"]);
    const t = next[1];
    expect(t.kind === "tool" && t.status).toBe("ok");
    expect(t.kind === "tool" && t.output).toBe("done");
  });

  test("an identical re-send returns the same array so the caller can skip a render", () => {
    const held = mergeTimeline([], [user("u", 1), tool("t", 2, "ok")]);
    expect(mergeTimeline(held, [tool("t", 2, "ok")])).toBe(held);
    expect(mergeTimeline(held, [])).toBe(held);
  });

  test("an older page is prepended and ordered before what is held", () => {
    const held = mergeTimeline([], [user("c", 30), user("d", 40)]);
    const next = mergeTimeline(held, [user("a", 10), user("b", 20)], "prepend");
    expect(next.map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
  });

  test("same-millisecond events keep arrival order", () => {
    const held = mergeTimeline([], [user("x", 5), user("y", 5)]);
    const next = mergeTimeline(held, [user("z", 5)]);
    expect(next.map((e) => e.id)).toEqual(["x", "y", "z"]);
  });

  test("a duplicate id inside one frame keeps the later copy", () => {
    const out = mergeTimeline([], [tool("t", 1, "running"), tool("t", 1, "error", "boom")]);
    expect(out).toHaveLength(1);
    expect(out[0].kind === "tool" && out[0].status).toBe("error");
  });

  test("consecutive tools group into one run; other events stand alone", () => {
    const rows = groupTimeline([user("u", 1), tool("a", 2, "ok"), tool("b", 3, "ok"), user("v", 4), tool("c", 5, "ok")]);
    expect(rows.map((r) => (r.type === "tools" ? r.events.map((e) => e.id).join("+") : r.event.id))).toEqual(["u", "a+b", "v", "c"]);
  });

  test("firstLine skips blank lines and truncates", () => {
    expect(firstLine("\n\n  hello there\nsecond")).toBe("hello there");
    expect(firstLine("x".repeat(200), 10)).toBe("xxxxxxxxx…");
  });
});

// ------------------------------------------------------------------- usage

const win = (p: Partial<UsageWindow> & Pick<UsageWindow, "kind" | "usedPct">): UsageWindow => ({
  id: p.id ?? p.kind,
  label: p.label ?? "",
  resetsAt: null,
  windowMs: p.kind === "short" ? 5 * H : 7 * D,
  ...p,
});

describe("usage bars", () => {
  test("claims stack on top of real use", () => {
    expect(barSegments(60, 10)).toEqual({ used: 60, claimed: 10, effective: 70, overCommitted: false });
  });

  test("claims past 100 are clipped on screen but flagged as over-committed", () => {
    const s = barSegments(92, 10);
    expect(s.used).toBe(92);
    expect(s.claimed).toBe(8);
    expect(s.effective).toBe(102);
    expect(s.overCommitted).toBe(true);
  });

  test("negative claims and over-100 use cannot draw outside the bar", () => {
    expect(barSegments(120, -5)).toEqual({ used: 100, claimed: 0, effective: 120, overCommitted: true });
  });

  test("lapsed claims hold nothing", () => {
    const claims: ClaimView[] = [
      { sessionId: "a", title: "a", big: false, claim: 5, consumed: 2, outstanding: 3, lapsed: false },
      { sessionId: "b", title: "b", big: true, claim: 20, consumed: 1, outstanding: 19, lapsed: true },
    ];
    expect(outstandingOf(claims)).toBe(3);
  });

  test("outstanding weekly points become short-window percent via shortWindowInWeekly", () => {
    // The design doc's worked example: 5 points against a 24-point window is ~21%.
    expect(Math.round(shortClaimPct(5, 24))).toBe(21);
    expect(shortClaimPct(5, 0)).toBe(0);
  });

  test("reset countdown", () => {
    const now = 1_000_000_000;
    expect(resetText(now + 3 * H + 12 * M + 5000, now)).toBe("resets in 3h 12m");
    expect(resetText(now + 2 * D + 5 * H, now)).toBe("resets in 2d 5h");
    expect(resetText(now + 30_000, now)).toBe("resets in <1m");
    expect(resetText(now - 1, now)).toBe("resetting");
    expect(resetText(null, now)).toBe("not started");
    expect(fmtCountdown(45 * M)).toBe("45m");
  });

  test("elapsed fraction of a window, for the time tick", () => {
    const now = 10 * H;
    expect(windowElapsed({ resetsAt: now + 1 * H, windowMs: 5 * H }, now)).toBeCloseTo(0.8);
    expect(windowElapsed({ resetsAt: null, windowMs: 5 * H }, now)).toBeNull();
  });

  test("tone thresholds", () => {
    expect(usageTone(74)).toBe("ok");
    expect(usageTone(75)).toBe("warn");
    expect(usageTone(90)).toBe("bad");
    expect(usageTone(null)).toBe("ok");
  });

  test("labels: provider label wins, scope is appended once", () => {
    expect(windowLabel(win({ kind: "short", usedPct: 1 }))).toBe("5-hour");
    expect(windowLabel(win({ kind: "weekly", usedPct: 1, label: "Weekly", scope: { model: "Fable" } }))).toBe("Weekly · Fable");
    expect(windowLabel(win({ kind: "weekly", usedPct: 1, label: "Weekly (Fable)", scope: { model: "Fable" } }))).toBe("Weekly (Fable)");
  });

  test("windows sort short, weekly, then scoped weekly", () => {
    const sorted = sortWindows([
      win({ id: "w:Fable", kind: "weekly", usedPct: 1, scope: { model: "Fable" } }),
      win({ id: "w", kind: "weekly", usedPct: 1 }),
      win({ id: "s", kind: "short", usedPct: 1 }),
    ]);
    expect(sorted.map((w) => w.id)).toEqual(["s", "w", "w:Fable"]);
  });

  test("headline windows and summary ignore scoped limits", () => {
    const usage: AccountUsage = {
      accountId: "a",
      at: 0,
      stale: null,
      source: "endpoint",
      notes: [],
      windows: [win({ kind: "weekly", usedPct: 41, scope: { model: "Fable" } }), win({ kind: "short", usedPct: 38.4 }), win({ kind: "weekly", usedPct: 64 })],
    };
    expect(headlineWindows(usage).weekly?.usedPct).toBe(64);
    expect(usageSummary({ usage })).toBe("5h 38% · wk 64%");
    expect(usageSummary({ usage: { ...usage, windows: [] } })).toBe("no usage data");
  });
});

// --------------------------------------------------------------- placement

const cand = (p: Partial<Candidate> & Pick<Candidate, "accountId">): Candidate => ({
  label: p.accountId,
  eligible: true,
  reason: null,
  weekly: null,
  weeklyEffective: null,
  weeklyResetsAt: null,
  short: null,
  shortEffective: null,
  shortResetsAt: null,
  legRoom: null,
  weeklyPerHour: null,
  outstanding: 0,
  score: 0,
  ...p,
});

describe("placement table", () => {
  test("arrow shows used → effective, collapsing when claims add nothing", () => {
    expect(arrow(92, 97)).toBe("92 → 97");
    expect(arrow(12, 12)).toBe("12");
    expect(arrow(null, null)).toBe("—");
    expect(arrow(3.14, 21.06)).toBe("3.1 → 21.1");
  });

  test("cells for an eligible and an ineligible candidate", () => {
    const a = candidateCells(cand({ accountId: "A", weekly: 92, weeklyEffective: 97, short: 0, shortEffective: 21, legRoom: 79, weeklyPerHour: 0.25, score: 79 }), "A");
    expect(a).toMatchObject({ weekly: "92 → 97", short: "0 → 21", legRoom: "79", perHour: "0.25/h", score: "79.0", verdict: "eligible", chosen: true });
    const b = candidateCells(cand({ accountId: "B", eligible: false, reason: "Weekly is 102 with claims." }), "A");
    expect(b).toMatchObject({ eligible: false, verdict: "Weekly is 102 with claims.", chosen: false, legRoom: "—" });
  });

  test("rows: the choice first, then eligible by score, then ineligible", () => {
    const p: Placement = {
      provider: "claude",
      accountId: "B",
      mode: "auto",
      big: false,
      claim: 5,
      why: "",
      candidates: [
        cand({ accountId: "X", eligible: false, score: 99 }),
        cand({ accountId: "A", score: 50 }),
        cand({ accountId: "B", score: 80 }),
        cand({ accountId: "C", score: 70 }),
      ],
    };
    expect(candidateTable(p).map((r) => r.accountId)).toEqual(["B", "C", "A", "X"]);
    // A manual pick moves to the top and becomes the chosen row.
    const manual = candidateTable(p, "A");
    expect(manual[0].accountId).toBe("A");
    expect(manual.filter((r) => r.chosen).map((r) => r.accountId)).toEqual(["A"]);
  });

  test("headline", () => {
    const base: Placement = { provider: "claude", accountId: "B", mode: "auto", big: false, claim: 5, why: "", candidates: [cand({ accountId: "B", label: "work" })] };
    expect(placementHeadline(base)).toBe("Auto → work");
    expect(placementHeadline({ ...base, mode: "none", accountId: null })).toBe("No account can take a new session");
    expect(placementHeadline(base, "personal")).toBe("Manual → personal");
  });

  test("points format: one decimal under 100", () => {
    expect(fmtPts(21.44)).toBe("21.4");
    expect(fmtPts(20)).toBe("20");
    expect(fmtPts(102.4)).toBe("102");
    expect(fmtPts(null)).toBe("—");
  });
});

// ------------------------------------------------------------------- board

const RANK: Record<AttentionKind, number> = { blocked: 0, waiting: 1, running: 2, stopped: 3, archived: 4 };

function row(id: string, kind: AttentionKind, lastActivityAt: number, extra: Partial<SessionRow> = {}): SessionRow {
  const attention: Attention = { kind, rank: RANK[kind], reason: "" };
  return {
    id,
    provider: "claude",
    agentSessionId: null,
    accountId: "acc",
    status: kind,
    host: kind === "stopped" || kind === "archived" ? "none" : "tmux",
    title: `title ${id}`,
    label: null,
    cwd: `/home/me/${id}`,
    repoRoot: null,
    branch: null,
    worktree: null,
    model: null,
    firstPrompt: null,
    lastPrompt: null,
    lastMessage: null,
    contextUsed: null,
    contextLimit: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEquiv: 0 },
    big: false,
    claim: 5,
    origin: "agentbox",
    pid: null,
    tmux: null,
    transcriptPath: null,
    startedAt: 0,
    lastActivityAt,
    archivedAt: null,
    prNumber: null,
    attention,
    ...extra,
  };
}

describe("attention sorting", () => {
  const rows = [
    row("stopped-new", "stopped", 900),
    row("running", "running", 500),
    row("waiting-old", "waiting", 100),
    row("blocked", "blocked", 50),
    row("waiting-new", "waiting", 800),
    row("archived", "archived", 999),
  ];

  test("blocked → waiting → running → stopped → archived, newest first within", () => {
    expect(sortByAttention(rows).map((r) => r.id)).toEqual(["blocked", "waiting-new", "waiting-old", "running", "stopped-new", "archived"]);
  });

  test("kind wins over a server rank that disagrees", () => {
    const odd = [row("r", "running", 1, { attention: { kind: "running", rank: 0, reason: "" } }), row("b", "blocked", 1, { attention: { kind: "blocked", rank: 9, reason: "" } })];
    expect(sortByAttention(odd).map((r) => r.id)).toEqual(["b", "r"]);
  });

  test("archived is hidden unless asked for; sections keep a fixed order", () => {
    const visible = filterSessions(rows, EMPTY_FILTER);
    expect(visible.some((r) => r.id === "archived")).toBe(false);
    expect(sectionsOf(visible).map((s) => s.kind)).toEqual(["blocked", "waiting", "running", "stopped"]);
    expect(sectionsOf(filterSessions(rows, { ...EMPTY_FILTER, showArchived: true })).at(-1)?.kind).toBe("archived");
  });

  test("filters by provider, account and text", () => {
    const mixed = [
      row("a", "running", 1, { provider: "codex", accountId: "cx", lastMessage: "Wired the WHAM endpoint" }),
      row("b", "running", 1, { accountId: null }),
    ];
    expect(filterSessions(mixed, { ...EMPTY_FILTER, provider: "codex" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterSessions(mixed, { ...EMPTY_FILTER, account: "none" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterSessions(mixed, { ...EMPTY_FILTER, query: "wham" }).map((r) => r.id)).toEqual(["a"]);
  });

  test("j/k clamps at the ends and starts from the top", () => {
    const ordered = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(neighbourId(ordered, null, 1)).toBe("a");
    expect(neighbourId(ordered, "a", -1)).toBe("a");
    expect(neighbourId(ordered, "b", 1)).toBe("c");
    expect(neighbourId(ordered, "c", 1)).toBe("c");
    expect(neighbourId([], null, 1)).toBeNull();
  });

  test("title: label, then title, then the first prompt line", () => {
    expect(titleOf({ label: "mine", title: "derived", firstPrompt: null })).toBe("mine");
    expect(titleOf({ label: "  ", title: "derived", firstPrompt: null })).toBe("derived");
    expect(titleOf({ label: null, title: "", firstPrompt: "do the thing\nmore" })).toBe("do the thing");
  });
});
