import { EventEmitter } from "node:events";
import { listSessions, listRepos, getSettings } from "./db";
import { listPrs } from "./prs";
import { listSkills } from "./skills";
import { attentionOf } from "./conductor";
import { ompAvailable, pendingPermissionOf, sessionEvents } from "./sessions";
import type { AppState, ColdState, HotState, PrInfo, SkillInfo } from "./types";

/**
 * Two states, two costs.
 *
 * Hot is sessions: sqlite reads and a map, cheap enough to rebuild on every
 * change. Cold is repos, PRs, skills and settings — PRs shell out to `gh` once
 * per repo and skills walk the filesystem, so cold is built on a slow timer and
 * on demand, cached, and published only when its contents actually differ.
 *
 * The old build computed all of it inside one `getAppState()` that ran on every
 * 400ms broadcast, which meant an idle agentbox spawned `gh` forever.
 */

/** Fires `"cold"` when a refresh produced something different from the cache. */
export const stateEvents = new EventEmitter();
stateEvents.setMaxListeners(0);

/** How often the scans are re-run when nobody asks. */
export const COLD_REFRESH_MS = 60_000;

interface ScanCache {
  prs: PrInfo[];
  skills: SkillInfo[];
  /** Every dependency gap the scans found, in the order the UI should show them. */
  warnings: string[];
}

let scans: ScanCache | null = null;
let cold: ColdState | null = null;
let coldFingerprint = "";

/**
 * Closed sessions are included, with `closedAt` set, and the UI filters them
 * for display.
 *
 * Withholding them made Close an undoable delete wearing a reversible label:
 * the closed count could only ever be 0, the "show closed" toggle had
 * nothing to reveal, and a deep link to a closed session resolved to
 * nothing. Anything that must not count them has to say so — see `inboxItems`.
 */
export function getHotState(): HotState {
  return {
    sessions: listSessions(true).map((s) => {
      const session = { ...s, permission: pendingPermissionOf(s.id) };
      return { ...session, attention: attentionOf(session) };
    }),
    serverTime: Date.now(),
  };
}

/**
 * The cached cold state. Never shells out: if nothing has built the cache yet
 * this fills it, which is the one case where a caller pays for the scans.
 */
export function getColdState(): ColdState {
  if (!cold) refreshCold(true);
  return cold!;
}

/**
 * Rebuild cold state and publish it if it changed.
 *
 * `rescan` re-runs the expensive scans (`gh`, the skills walk). Without it the
 * scans' cached results are reused and only the cheap sqlite-backed parts —
 * repos and settings — are re-read, which is what a settings save or a repo
 * change needs. The slow timer passes `rescan: true`.
 *
 * Returns whether the published state changed.
 */
export function refreshCold(rescan = false): boolean {
  const repos = listRepos();
  const settings = getSettings();

  if (!scans || rescan) {
    // Closed sessions included deliberately: `listPrs` uses them only to
    // attach a `sessionId` to a PR, and a PR does not stop being that session's
    // work because the session was closed.
    const pr = listPrs(repos, listSessions(true));
    const skill = listSkills();
    scans = {
      prs: pr.prs,
      skills: skill.skills,
      // omp first: without it nothing can run at all, so it is the gap that
      // explains the most. `/api/health` reports it too, but health is fetched
      // on demand and this is what the UI already has open.
      warnings: [
        ...(ompAvailable() ? [] : ["`omp` is not on PATH — sessions cannot be started until it is installed"]),
        ...pr.warnings,
        ...skill.warnings,
      ],
    };
  }

  const next: ColdState = {
    repos,
    prs: scans.prs,
    skills: scans.skills,
    settings,
    warnings: scans.warnings,
  };

  // Compare the payload we would send, not its parts: the point is to avoid
  // waking every client with a message identical to the one it already has.
  const fingerprint = JSON.stringify(next);
  cold = next;
  if (fingerprint === coldFingerprint) return false;
  coldFingerprint = fingerprint;
  stateEvents.emit("cold", next);
  return true;
}

/**
 * Start the slow refresh loop. Returns the stopper so a test or a shutdown can
 * end it; the timer is unref'd so it never holds the process open by itself.
 */
export function startColdRefresh(intervalMs = COLD_REFRESH_MS): () => void {
  // Warm the cache once, off the current tick so binding the port is not held
  // up by `gh`. Without this the first client to connect pays for the scans.
  const warm = setTimeout(() => refreshCold(true), 0);
  const timer = setInterval(() => refreshCold(true), intervalMs);
  timer.unref?.();
  return () => {
    clearTimeout(warm);
    clearInterval(timer);
  };
}

/** Whole state, for `GET /api/state` and the initial WebSocket payload. */
export function getAppState(): AppState {
  return { ...getHotState(), ...getColdState() };
}

// ------------------------------------------------- engine-driven rescans

/**
 * The engine discovers a session's PR at a turn boundary and writes `prNumber`
 * on the session. Until the PR cache catches up, the same piece of work is two
 * rows — the session and an orphan PR that nothing claims yet. Waiting out the
 * 60s timer for that is exactly the "stale for no reason" the hot/cold split is
 * supposed to remove.
 *
 * So a `"cold"` from the engine re-runs the scans, but on a leash: coalesced,
 * and never more than once per RESCAN_FLOOR_MS. A bug that emits `"cold"` in a
 * loop must not turn into `gh` in a loop — that is the original bug wearing a
 * different hat.
 */
const RESCAN_DEBOUNCE_MS = 2_000;
const RESCAN_FLOOR_MS = 15_000;
let rescanTimer: ReturnType<typeof setTimeout> | null = null;
let lastRequestedRescan = 0;

export function requestColdRescan(): void {
  if (rescanTimer) return;
  const wait = Math.max(RESCAN_DEBOUNCE_MS, RESCAN_FLOOR_MS - (Date.now() - lastRequestedRescan));
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    lastRequestedRescan = Date.now();
    refreshCold(true);
  }, wait);
  rescanTimer.unref?.();
}

sessionEvents.on("cold", requestColdRescan);
