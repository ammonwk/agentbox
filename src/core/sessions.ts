import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  insertSession, updateSession, getSession, listSessions, deleteSession,
  getSettings, getDb,
} from "./db";
import { sessionDirFor, logPathFor } from "./paths";
import { createWorktree, run, findOpenPr, repoFullNameOf, currentBranch, repoCheckoutPath } from "./git";
import { AcpRunner } from "./acp";
import type { Repo, Session } from "./types";

export const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(0);

export function broadcast() {
  sessionEvents.emit("change");
}

interface Running {
  acp: AcpRunner;
  session: Session;
  liveText: string;
}

const running = new Map<string, Running>();

export function activeCount(): number {
  return running.size;
}

/** Live permission detail for a session, if it is blocked on an approval. */
export function pendingPermissionOf(id: string) {
  return running.get(id)?.acp.permission ?? null;
}

export function ompAvailable(): boolean {
  const r = run(["sh", "-lc", "command -v omp || which omp"]);
  return r.code === 0 && r.stdout.trim().length > 0;
}

// ---- log / transcript ----

function logLine(sessionId: string, obj: Record<string, unknown>) {
  try {
    appendFileSync(logPathFor(sessionId), JSON.stringify({ ts: Date.now(), ...obj }) + "\n");
  } catch {}
}

export interface TranscriptLine {
  role: "user" | "assistant" | "tool";
  text: string;
  ts: number;
  tool?: string;
}

export function transcriptOf(id: string): TranscriptLine[] {
  const path = logPathFor(id);
  if (!existsSync(path)) return [];
  const out: TranscriptLine[] = [];
  let assistantBuf = "";
  let lastTs = 0;
  const flush = () => {
    if (assistantBuf.trim()) {
      out.push({ role: "assistant", text: assistantBuf.trim(), ts: lastTs });
      assistantBuf = "";
    }
  };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    switch (ev.event) {
      case "user":
        flush();
        out.push({ role: "user", text: ev.text ?? "", ts: ev.ts ?? 0 });
        break;
      case "chunk":
        lastTs = ev.ts ?? lastTs;
        assistantBuf += ev.text ?? "";
        break;
      case "tool":
        flush();
        out.push({ role: "tool", text: ev.title ?? "", ts: ev.ts ?? 0, tool: ev.tool });
        break;
      case "stop":
        flush();
        break;
      case "perm":
        flush();
        out.push({ role: "tool", text: `— permission: ${ev.title} —`, ts: ev.ts ?? 0 });
        break;
    }
  }
  flush();
  return out;
}

// ---- runner wiring ----

function makeRunner(s: Session): AcpRunner {
  const r = new AcpRunner(
    s.id,
    {
      onText: (id, text) => {
        const rt = running.get(id);
        if (!rt) return;
        rt.liveText = (rt.liveText + text).slice(-4000);
        if (text) logLine(id, { event: "chunk", role: "assistant", text });
        updateSession(id, { lastMessage: tailText(rt.liveText) });
        scheduleThrottledBroadcast();
      },
      onTurnEnd: (id, stopReason) => {
        const rt = running.get(id);
        if (rt) {
          rt.liveText = tailText(rt.liveText) ?? "";
          updateSession(id, { lastMessage: tailText(rt.liveText), waitingForInput: true });
        }
        logLine(id, { event: "stop", stopReason });
        updateSession(id, { status: "waiting", waitingForInput: true, blocked: false });
        linkPr(id);
        broadcast();
      },
      onUsage: (id, tokens, cost) => {
        updateSession(id, { tokens, costUsd: cost });
      },
      onPermission: (id, info) => {
        logLine(id, { event: "perm", title: info.title, tool: info.tool });
        updateSession(id, { status: "waiting", waitingForInput: true, blocked: true });
        broadcast();
      },
      onError: (id, message) => {
        logLine(id, { event: "err", message });
      },
      onExit: (id) => {
        running.delete(id);
        const s = getSession(id);
        if (s && s.status === "running") {
          // Process died mid-turn but the omp session is resumable.
          updateSession(id, { status: "dead", pid: null, waitingForInput: true });
          broadcast();
        }
      },
    },
    () => getSettings().autoApprove
  );
  return r;
}

async function startRunner(s: Session, firstMessage: string, resumeId: string | null): Promise<void> {
  const acp = makeRunner(s);
  running.set(s.id, { acp, session: s, liveText: "" });
  updateSession(s.id, { status: "running", waitingForInput: false, blocked: false, pid: acp.pid ?? null });
  logLine(s.id, { event: "user", text: firstMessage });
  try {
    const sid = await acp.launch(s.worktree!, s.model, resumeId);
    updateSession(s.id, { ompSessionId: sid, pid: acp.pid ?? null });
    acp.send(firstMessage);
  } catch (e) {
    running.delete(s.id);
    updateSession(s.id, {
      status: "failed",
      exitCode: 1,
      waitingForInput: true,
      lastMessage: `Failed to start omp: ${(e as Error).message.slice(0, 300)}`,
    });
  }
  broadcast();
}

// ---- public API ----

/** Spawn a new session. Caller supplies the repo record.
 *  With `fromBranch`, check out that existing branch instead of a fresh one. */
export function spawnSession(repo: Repo, prompt: string, model?: string, fromBranch?: string): Session {
  const settings = getSettings();
  const id = randomUUID();
  const branch = fromBranch ?? `vk/ab-${id.slice(0, 8)}`;
  const session: Session = {
    id,
    title: titleFromPrompt(prompt),
    prompt,
    status: "spawning",
    repo: repo.ref,
    branch,
    worktree: null,
    sessionDir: sessionDirFor(id),
    model: model ?? settings.model,
    followUps: 0,
    lastMessage: null,
    exitCode: null,
    pid: null,
    prNumber: null,
    repoFullName: null,
    costUsd: null,
    tokens: null,
    waitingForInput: false,
    blocked: false,
    ompSessionId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archivedAt: null,
  };
  insertSession(session);

  try {
    const { path, fullName } = createWorktree(repo, id, branch, fromBranch);
    session.worktree = path;
    session.repoFullName = fullName;
    updateSession(id, { worktree: path, repoFullName: fullName });
    void startRunner(session, prompt, null);
  } catch (e) {
    updateSession(id, {
      status: "failed",
      exitCode: 1,
      waitingForInput: true,
      lastMessage: `Setup failed: ${(e as Error).message.slice(0, 300)}`,
    });
    broadcast();
  }
  return getSession(id)!;
}

/** Queue a message for an interactive session, resurrecting it if the process died. */
export async function sendMessage(id: string, text: string): Promise<Session> {
  const s = getSession(id);
  if (!s) throw new Error("session not found");
  if (!text.trim()) throw new Error("message is empty");

  const rt = running.get(id);
  if (rt && rt.acp.alive) {
    try {
      logLine(id, { event: "user", text: text.trim() });
      updateSession(id, {
        status: "running", waitingForInput: false, blocked: false,
        followUps: s.followUps + 1,
      });
      rt.acp.send(text.trim());
    } catch (e) {
      // runner present but not connected — fall through to respawn
      running.delete(id);
      await startRunner(s, text.trim(), s.ompSessionId);
      updateSession(id, { followUps: s.followUps + 1 });
    }
  } else {
    if (!s.worktree || !existsSync(s.worktree)) throw new Error("worktree is gone");
    await startRunner(s, text.trim(), s.ompSessionId);
    updateSession(id, { followUps: s.followUps + 1 });
  }
  broadcast();
  return getSession(id)!;
}

/** Interrupt the current turn (soft cancel); the queue survives. */
export async function interruptSession(id: string): Promise<Session> {
  const rt = running.get(id);
  if (rt && rt.acp.alive) rt.acp.interrupt();
  const s = getSession(id);
  if (!s) throw new Error("session not found");
  return s;
}

/** Approve or deny a surfaced permission request. */
export async function replyPermission(id: string, approved: boolean): Promise<Session> {
  const rt = running.get(id);
  if (!rt || !rt.acp.hasPendingPermission) throw new Error("no pending permission");
  rt.acp.replyPermission(rt.acp.permission!.id, approved);
  updateSession(id, { status: "running", blocked: false, waitingForInput: false });
  broadcast();
  return getSession(id)!;
}

export function killSession(id: string): Session | null {
  const rt = running.get(id);
  if (rt) rt.acp.kill();
  return getSession(id);
}

export function archiveSession(id: string): Session | null {
  const s = getSession(id);
  if (!s) return null;
  updateSession(id, { archivedAt: Date.now() });
  return getSession(id);
}

export function destroySession(id: string) {
  const rt = running.get(id);
  if (rt) rt.acp.kill();
  running.delete(id);
  const s = getSession(id);
  if (s?.worktree && s.repo) {
    const repo = getDb().query("SELECT * FROM repos WHERE ref = ?").get(s.repo) as Repo | null;
    if (repo) {
      run(["git", "worktree", "remove", "--force", s.worktree], repoCheckoutPath(repo));
      if (s.branch.startsWith("vk/ab-")) {
        run(["git", "branch", "-D", s.branch], repoCheckoutPath(repo));
      }
    }
  }
  deleteSession(id);
}

/** Mark sessions dead when their process vanished and we no longer watch it. */
export function reconcile() {
  for (const s of listSessions()) {
    if (s.status === "running" && !running.has(s.id)) {
      updateSession(s.id, { status: "dead", pid: null, waitingForInput: true });
    }
  }
}

// ---- helpers ----

function tailText(text: string): string | null {
  const clean = text.trim().replace(/\s+/g, " ").slice(-400);
  return clean || null;
}

function titleFromPrompt(prompt: string): string {
  const one = prompt.trim().replace(/\s+/g, " ").slice(0, 72);
  return one || "Untitled session";
}

function linkPr(id: string) {
  const s = getSession(id);
  if (!s || !s.worktree || !existsSync(s.worktree) || s.prNumber) return;
  const fullName = s.repoFullName ?? repoFullNameOf(s.worktree);
  const branch = currentBranch(s.worktree);
  const pr = findOpenPr(fullName ?? "", branch);
  if (pr) updateSession(id, { prNumber: pr.number, repoFullName: fullName });
}

// throttled broadcasts for the chatty text-delta path
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleThrottledBroadcast() {
  if (throttleTimer) return;
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    broadcast();
  }, 500);
}
