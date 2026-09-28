/** Voice mode's hands: a shell and long-running commands whose output comes
 *  back as news.
 *
 * Every command runs in a fresh `bash -c` in the voice directory, with this
 * checkout's `agentbox` first on PATH. It runs as a process group of its own
 * (`setsid`), so a timeout or an unwatch takes everything it started with it.
 * `AGENTBOX_SEND_AS=you`: what voice mode types into a session is you,
 * spoken, and counts as your message (src/cli/sessions.ts `send`).
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxBin, agentboxHome } from "../core/paths";

const OUT_MAX = 8_000;
/** A watch printing more than this many lines a minute is stopped: every batch is a model turn. */
const CHATTY_PER_MIN = 60;
const MAX_WATCHES = 8;
/** Lines are gathered this long and delivered as one. */
const BATCH_MS = 1_500;

function voiceDir(): string {
  return join(agentboxHome(), "voice");
}

function spawn(command: string) {
  const cwd = voiceDir();
  mkdirSync(cwd, { recursive: true });
  return Bun.spawn(["setsid", "bash", "-c", command], {
    cwd,
    env: { ...process.env, PATH: `${dirname(agentboxBin())}:${process.env.PATH ?? ""}`, AGENTBOX_SEND_AS: "you" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** The whole group: bash and whatever it started. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

/** Long output keeps its start and, mostly, its end. */
function clipOut(s: string): string {
  if (s.length <= OUT_MAX) return s;
  return `${s.slice(0, 2_000)}\n…[${s.length - OUT_MAX} characters cut]…\n${s.slice(-(OUT_MAX - 2_000))}`;
}

/** One command, to completion or `timeoutMs`. */
export async function runShell(command: string, timeoutMs = 60_000): Promise<{ text: string; code: number | null }> {
  const proc = spawn(command);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(proc.pid);
  }, timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const parts = [out.trimEnd(), err.trim() ? `[stderr]\n${err.trimEnd()}` : ""].filter(Boolean);
  const status = timedOut ? `[killed after ${Math.round(timeoutMs / 1000)}s — for something long-running, use watch]` : `[exit ${code}]`;
  return { text: clipOut([...parts, status].join("\n")), code: timedOut ? null : code };
}

interface Watch {
  command: string;
  pid: number;
  startedAt: number;
  stopped: boolean;
}

/**
 * Background commands whose stdout is news. Each line a watch prints reaches
 * `deliver` as `[watch <name>] <line>`, gathered over a moment so a burst is
 * one message; its end is news too. They belong to the server, not to a
 * phone's connection, and die with it.
 */
export class Watches {
  private running = new Map<string, Watch>();
  private seq = 0;

  constructor(private deliver: (text: string) => void) {
    process.on("exit", () => {
      for (const w of this.running.values()) killGroup(w.pid);
    });
  }

  start(nameIn: string, command: string): string {
    const name = nameIn.trim().replace(/\s+/g, "-") || `w${++this.seq}`;
    if (this.running.has(name)) throw new Error(`a watch named "${name}" is already running; unwatch it or pick another name`);
    if (this.running.size >= MAX_WATCHES) throw new Error(`${MAX_WATCHES} watches are already running; unwatch one first`);
    const proc = spawn(command);
    const w: Watch = { command, pid: proc.pid, startedAt: Date.now(), stopped: false };
    this.running.set(name, w);
    void this.pump(name, w, proc);
    return `Watching as "${name}". Each line it prints will come to you as [watch ${name}] …, and so will its end.`;
  }

  stop(name: string): string {
    const w = this.running.get(name.trim());
    if (!w) throw new Error(`no watch named "${name}" (running: ${[...this.running.keys()].join(", ") || "none"})`);
    w.stopped = true;
    this.running.delete(name.trim());
    killGroup(w.pid);
    return `Stopped watch "${name}".`;
  }

  /** One line each, for the board glance. */
  list(): string[] {
    return [...this.running].map(([name, w]) => `watch "${name}" (since ${Math.round((Date.now() - w.startedAt) / 60_000)}m): ${w.command.replace(/\s+/g, " ").slice(0, 160)}`);
  }

  private async pump(name: string, w: Watch, proc: ReturnType<typeof spawn>): Promise<void> {
    const batch: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const recent: number[] = [];
    const flush = () => {
      timer = null;
      if (!batch.length || w.stopped) return;
      const lines = batch.splice(0);
      const shown = lines.slice(0, 30).map((l) => (l.length > 600 ? `${l.slice(0, 600)}…` : l));
      if (lines.length > shown.length) shown.push(`(${lines.length - shown.length} more lines)`);
      this.deliver(shown.map((l) => `[watch ${name}] ${l}`).join("\n"));
    };
    const errText = new Response(proc.stderr).text();
    const decoder = new TextDecoder();
    let partial = "";
    const reader = proc.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      partial += decoder.decode(value, { stream: true });
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      const now = Date.now();
      for (const l of lines) {
        if (!l.trim()) continue;
        batch.push(l.trimEnd());
        recent.push(now);
      }
      while (recent.length && now - recent[0]! > 60_000) recent.shift();
      if (recent.length > CHATTY_PER_MIN && !w.stopped) {
        flush();
        this.stop(name);
        this.deliver(`[watch ${name}] stopped: it printed over ${CHATTY_PER_MIN} lines a minute. Filter it to the lines worth hearing (grep) and start it again if still wanted.`);
        break;
      }
      if (batch.length && !timer) timer = setTimeout(flush, BATCH_MS);
    }
    const code = await proc.exited;
    if (partial.trim()) batch.push(partial.trimEnd());
    if (timer) clearTimeout(timer);
    flush();
    if (w.stopped) return;
    if (this.running.get(name) === w) this.running.delete(name);
    const err = (await errText).trim().split("\n").slice(-3).join(" / ");
    this.deliver(`[watch ${name}] ended (exit ${code})${code !== 0 && err ? `: ${err.slice(0, 400)}` : ""}`);
  }
}
