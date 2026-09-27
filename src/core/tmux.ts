/** agentbox's tmux server: where every session agentbox runs lives.
 *
 * One tmux *session* per agent session, named `ab-<id>`, on a server of our
 * own (`tmux -L agentbox`) so your personal tmux and ours never share a
 * session list, a prefix key or a server restart. A session rather than a
 * window each, so a terminal and a browser can both be attached to one agent
 * without switching each other's view.
 *
 * Everything addresses a session by name. Pane ids (`%12`) are renumbered
 * when the tmux server restarts; our names are not, and they are never reused
 * because the agentbox id in them is not.
 */

import { tmuxSocket } from "./paths";

export interface TmuxResult {
  code: number;
  stdout: string;
  stderr: string;
}

function tmux(args: string[], input?: string): TmuxResult {
  const p = Bun.spawnSync(["tmux", "-L", tmuxSocket(), ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

export const tmuxName = (sessionId: string): string => `ab-${sessionId}`;

/**
 * Server-wide options, applied in the same invocation that creates a session.
 * They cannot be set ahead of time: with no sessions the server exits, taking
 * its options with it.
 *
 * - `remain-on-exit`: when the agent exits, keep its last screen for the
 *   browser to show instead of the session vanishing mid-read. The fleet kills
 *   dead sessions after a while.
 * - `window-size latest`: the most recently active client decides the size,
 *   so a phone-width browser does not shrink the terminal you are typing in.
 * - `status off`: the agent's own UI is the whole screen; a tmux status bar is
 *   noise in the browser. `agentbox attach` users can turn it on.
 */
const GLOBALS: string[][] = [
  ["set-option", "-g", "remain-on-exit", "on"],
  ["set-option", "-g", "window-size", "latest"],
  ["set-option", "-g", "history-limit", "50000"],
  ["set-option", "-g", "status", "off"],
  ["set-option", "-g", "mouse", "on"],
  ["set-option", "-g", "default-terminal", "tmux-256color"],
  ["set-option", "-sa", "terminal-features", ",xterm-256color:RGB"],
  ["set-option", "-s", "escape-time", "10"],
];

export interface NewSession {
  name: string;
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  unset?: string[];
  cols?: number;
  rows?: number;
}

/** Start `argv` in a new detached tmux session. Returns the pane's pid — the
 *  agent itself, since `env` execs it. */
export function newSession(s: NewSession): number {
  // `env -u` rather than tmux's `-e`: tmux can add variables but not remove
  // one the server inherited, and a stray CLAUDE_CONFIG_DIR from the shell
  // that started agentbox would put the session on the wrong account.
  const cmd = ["env", ...(s.unset ?? []).flatMap((v) => ["-u", v]), ...Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`), ...s.argv];
  const args: string[] = ["start-server"];
  for (const g of GLOBALS) args.push(";", ...g);
  args.push(
    ";",
    "new-session", "-d", "-s", s.name, "-c", s.cwd,
    "-x", String(s.cols ?? 200), "-y", String(s.rows ?? 50),
    "-P", "-F", "#{pane_pid}",
    "--", ...cmd,
  );
  const r = tmux(["list-sessions"]).code === 0 ? tmux(args) : startServer(args);
  if (r.code !== 0) throw new Error(`tmux could not start the session: ${r.stderr.trim() || r.stdout.trim()}`);
  const pid = Number(r.stdout.trim().split("\n").pop());
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`tmux started the session but reported no pid: ${r.stdout}`);
  return pid;
}

/**
 * Run the invocation that starts our tmux server in a systemd scope of its
 * own. Started plainly, the server lands in the cgroup of whatever started it
 * — the agentbox server's scope, whose `systemctl stop` then takes the tmux
 * server and every agent with it (each pane is in a scope of its own, but
 * loses its terminal when the server dies). Without systemd, or if the unit
 * name is still held by a scope being torn down, tmux runs plainly.
 */
function startServer(args: string[]): TmuxResult {
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    p = Bun.spawnSync(["systemd-run", "--user", "--scope", "--collect", "--quiet", "--unit=agentbox-tmux", "-p", "CPUWeight=1000", "tmux", "-L", tmuxSocket(), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return tmux(args);
  }
  const r = { code: p.exitCode ?? -1, stdout: p.stdout?.toString() ?? "", stderr: p.stderr?.toString() ?? "" };
  if (r.code !== 0 && /transient|systemd|Failed to connect/i.test(r.stderr)) return tmux(args);
  return r;
}

export interface PaneInfo {
  name: string;
  pid: number;
  dead: boolean;
  deadStatus: number | null;
  /** Clients attached to this session right now (terminals and browsers). */
  clients: number;
  width: number;
  height: number;
}

/** Every agentbox session on our tmux server. Empty when the server is not
 *  running, which is the normal state with nothing open. */
export function listPanes(): PaneInfo[] {
  const r = tmux([
    "list-panes", "-a", "-F",
    "#{session_name}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}\t#{session_attached}\t#{pane_width}\t#{pane_height}",
  ]);
  if (r.code !== 0) return [];
  const out: PaneInfo[] = [];
  for (const line of r.stdout.split("\n")) {
    const [name, pid, dead, status, clients, w, h] = line.split("\t");
    if (!name?.startsWith("ab-")) continue;
    out.push({
      name,
      pid: Number(pid),
      dead: dead === "1",
      deadStatus: status ? Number(status) : null,
      clients: Number(clients) || 0,
      width: Number(w) || 0,
      height: Number(h) || 0,
    });
  }
  return out;
}

/**
 * Type `text` into the session as one prompt: a bracketed paste (so a
 * multi-line message is not submitted line by line), then Enter on its own.
 * The pause matters — an Enter that arrives inside the paste is taken as a
 * newline in the prompt by some TUIs.
 */
export async function sendText(name: string, text: string): Promise<void> {
  const buffer = `ab-${process.pid}-${Date.now()}`;
  const load = tmux(["load-buffer", "-b", buffer, "-"], text);
  if (load.code !== 0) throw new Error(`tmux load-buffer failed: ${load.stderr.trim()}`);
  const paste = tmux(["paste-buffer", "-p", "-d", "-b", buffer, "-t", `=${name}:`]);
  if (paste.code !== 0) throw new Error(`tmux paste failed: ${paste.stderr.trim()}`);
  await Bun.sleep(120);
  sendKeys(name, ["Enter"]);
}

/** Press keys by tmux name: `Enter`, `Escape`, `C-c`, `Down`, or literal text. */
export function sendKeys(name: string, keys: string[]): void {
  if (keys.length === 0) return;
  const r = tmux(["send-keys", "-t", `=${name}:`, ...keys]);
  if (r.code !== 0) throw new Error(`tmux send-keys failed: ${r.stderr.trim()}`);
}

/** The visible screen as plain text (or with colour escapes). */
export function capture(name: string, opts: { ansi?: boolean; scrollback?: number } = {}): string | null {
  const args = ["capture-pane", "-p", "-J", "-t", `=${name}:`];
  if (opts.ansi) args.push("-e");
  if (opts.scrollback) args.push("-S", String(-opts.scrollback));
  const r = tmux(args);
  return r.code === 0 ? r.stdout : null;
}

/**
 * Zoom the session's active pane to the whole window, or undo that. Claude
 * splits its window into a pane per teammate, which can leave the lead a
 * column wide — too narrow to read a dialog off. Returns whether anything
 * changed, so a caller undoes only its own zoom.
 */
export function setZoom(name: string, on: boolean): boolean {
  const r = tmux(["display-message", "-p", "-t", `=${name}:`, "#{window_panes} #{window_zoomed_flag}"]);
  if (r.code !== 0) return false;
  const [panes, zoomed] = r.stdout.trim().split(" ");
  if (Number(panes) <= 1 || (zoomed === "1") === on) return false;
  return tmux(["resize-pane", "-Z", "-t", `=${name}:`]).code === 0;
}

/**
 * Give a window nobody is looking at a desk-sized screen again. With
 * `window-size latest` a window keeps the size of the last client to show it,
 * so a phone that looked at the terminal leaves it 43 columns wide, and a
 * dialog drawn at that size cannot be read off it. Resizing pins the size
 * (`window-size manual`); unsetting that hands it back to the next client.
 */
export function unsquash(name: string, min = { cols: 80, rows: 24 }, to = { cols: 140, rows: 45 }): boolean {
  const r = tmux(["display-message", "-p", "-t", `=${name}:`, "#{session_attached} #{window_width} #{window_height}"]);
  if (r.code !== 0) return false;
  const [attached, cols, rows] = r.stdout.trim().split(" ").map(Number);
  if (attached !== 0 || (cols! >= min.cols && rows! >= min.rows)) return false;
  if (tmux(["resize-window", "-t", `=${name}:`, "-x", String(to.cols), "-y", String(to.rows)]).code !== 0) return false;
  tmux(["set-option", "-w", "-u", "-t", `=${name}:`, "window-size"]);
  return true;
}

export function killSession(name: string): void {
  tmux(["kill-session", "-t", `=${name}`]);
}

/** The argv that attaches a terminal to a session. */
export function attachArgv(name: string): string[] {
  return ["tmux", "-L", tmuxSocket(), "attach-session", "-t", `=${name}`];
}

export function tmuxVersion(): string | null {
  const p = Bun.spawnSync(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
}
