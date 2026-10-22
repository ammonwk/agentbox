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

import { chmodSync, readdirSync, statSync } from "node:fs";

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentboxHome, tmuxSocket } from "./paths";
import { agentAwsEnv, AWS_CREDENTIAL_ENV } from "./agent-aws";

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
  /** The agentbox session it runs, whose own AWS files it is given. */
  session: string;
  cwd: string;
  argv: string[];
  /** A file to feed the command's standard input: a CLI that takes its first
   *  prompt from stdin reads it there, so the words stay off the command
   *  line. */
  stdinFile?: string;
  env?: Record<string, string>;
  unset?: string[];
  /** Variables holding secrets. They are exported by the private launcher
   *  script (`writeLauncher`) rather than put on the command line tmux runs,
   *  which /proc/<pid>/cmdline and tmux's pane_start_command would show. */
  secretEnv?: Record<string, string>;
  cols?: number;
  rows?: number;
}

/** `sh` runs the command with the file as its standard input and execs it, so
 *  the pane's process is the agent itself. */
const STDIN_SCRIPT = 'f=$1; shift; exec "$@" <"$f"';

/**
 * Variables that say which session a process belongs to. The tmux server
 * keeps the environment of whatever started it — the agentbox server, which
 * an agent's shell may have started — and hands it to every pane, so each
 * agent would otherwise think it runs inside that one agent's session.
 */
const INHERITED_IDENTITY = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_NAME",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_PID",
  "AGENTBOX_SESSION",
];

/** Start `argv` in a new detached tmux session. Returns the pane's pid — the
 *  agent itself, since `env` execs it. */
export function newSession(s: NewSession): number {
  // `env -u` rather than tmux's `-e`: tmux can add variables but not remove
  // one the server inherited, and a stray CLAUDE_CONFIG_DIR from the shell
  // that started agentbox would put the session on the wrong account.
  const unset = [...new Set([...INHERITED_IDENTITY.filter((v) => !(v in (s.env ?? {}))), ...(s.unset ?? []), ...AWS_CREDENTIAL_ENV])];
  const run = s.stdinFile ? ["sh", "-c", STDIN_SCRIPT, "sh", s.stdinFile, ...s.argv] : s.argv;
  const argv = process.platform === "linux" && Bun.which("systemd-run")
    ? ["/usr/bin/python3", fileURLToPath(new URL("./session-owner.py", import.meta.url)), "launch", ...run]
    : run;
  const env: Record<string, string> = { ...(process.env.BASH_ENV ? { BASH_ENV: process.env.BASH_ENV } : {}), ...s.env, ...agentAwsEnv(s.session) };
  for (const key of AWS_CREDENTIAL_ENV) delete env[key];
  let cmd = ["env", ...unset.flatMap((v) => ["-u", v]), ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...argv];
  const launcher = cmd.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0) > MAX_INLINE ? writeLauncher(s.name, cmd) : null;
  if (launcher) cmd = ["sh", launcher];
  const args: string[] = ["start-server"];
  const secrets = Object.keys(s.secretEnv ?? {}).length ? writeLauncher(`${s.name}-env`, cmd, s.secretEnv) : null;
  if (secrets) cmd = ["sh", secrets];
  for (const g of GLOBALS) args.push(";", ...g);
  args.push(
    ";",
    "new-session", "-d", "-s", s.name, "-c", s.cwd,
    "-x", String(s.cols ?? 200), "-y", String(s.rows ?? 50),
    "-P", "-F", "#{pane_pid}",
    "--", ...cmd,
  );
  const r = tmux(["list-sessions"]).code === 0 ? tmux(args) : startServer(args);
  if (r.code !== 0 && launcher) rmSync(launcher, { force: true });
  if (r.code !== 0 && secrets) rmSync(secrets, { force: true });
  if (r.code !== 0) throw new Error(`tmux could not start the session: ${r.stderr.trim() || r.stdout.trim()}`);
  const pid = Number(r.stdout.trim().split("\n").pop());
  if (!Number.isFinite(pid) || pid <= 0) throw new Error(`tmux started the session but reported no pid: ${r.stdout}`);
  return pid;
}

/**
 * tmux sends a command to its server as one message of at most 16 KiB, so a
 * long prompt in the argv fails with "command too long". Past this, the
 * command goes in a script instead and tmux only runs `sh <script>`.
 */
const MAX_INLINE = 8192;

/** A script that deletes itself and execs `cmd`, so the pane's pid is still
 *  the agent's. Private (0600 in a 0700 directory): the prompt and `secret`
 *  are in it until the agent starts. One whose pane never ran it is deleted
 *  by the next launch. */
function writeLauncher(name: string, cmd: string[], secret: Record<string, string> = {}): string {
  const dir = join(agentboxHome(), "launch");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const f of readdirSync(dir)) {
    try {
      if (Date.now() - statSync(join(dir, f)).mtimeMs > LAUNCHER_TTL_MS) rmSync(join(dir, f), { force: true });
    } catch {
      /* gone meanwhile */
    }
  }
  const path = join(dir, `${name}.sh`);
  const quote = (a: string) => `'${a.replaceAll("'", `'\\''`)}'`;
  const exports = Object.entries(secret).map(([k, v]) => `export ${k}=${quote(v)}\n`).join("");
  rmSync(path, { force: true });
  writeFileSync(path, `rm -f -- "$0"\n${exports}exec ${cmd.map(quote).join(" ")}\n`, { mode: 0o600 });
  return path;
}

/** A launcher older than this was never run: its pane did not start. */
const LAUNCHER_TTL_MS = 60_000;

/**
 * Run the invocation that starts our tmux server in a systemd scope of its
 * own. Started plainly, the server lands in the cgroup of whatever started it
 * — the agentbox server's scope, whose `systemctl stop` then takes the tmux
 * server and every agent with it (each pane is in a scope of its own, but
 * loses its terminal when the server dies). The scope is `agentbox-tmux`
 * while that name is free: a tmux server that was killed leaves it held for
 * as long as anything one of its panes started is still running, and then the
 * scope goes unnamed (`run-….scope`) rather than not being one. Only without
 * systemd does tmux run plainly.
 */
function startServer(args: string[]): TmuxResult {
  const scoped = (unit: string[]): TmuxResult | null => {
    try {
      const p = Bun.spawnSync(["systemd-run", "--user", "--scope", "--collect", "--quiet", ...unit, "-p", "CPUWeight=1000", "tmux", "-L", tmuxSocket(), ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: p.exitCode ?? -1, stdout: p.stdout?.toString() ?? "", stderr: p.stderr?.toString() ?? "" };
    } catch {
      return null;
    }
  };
  let r = scoped(["--unit=agentbox-tmux"]);
  if (r && r.code !== 0 && /already loaded|already exists/i.test(r.stderr)) r = scoped([]);
  if (!r) return tmux(args);
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
  /** Epoch s of the window's last output: a screen captured in a later
   *  second, at this size, is still what it shows. */
  activity: number;
  /** The tmux server it is on — its pid and start (epoch ms). A different one
   *  later means this one died, and every session with it (src/core/recovery.ts). */
  server: { pid: number; start: number };
}

/** Every agentbox session on our tmux server. Empty when the server is not
 *  running, which is the normal state with nothing open. */
export function listPanes(): PaneInfo[] {
  // `|` and not a tab: under a non-UTF-8 locale tmux rewrites tabs in `-F`
  // output, and every pane then failed to parse. Session names are `ab-<id>`,
  // so a `|` in one is not possible.
  const r = tmux([
    "list-panes", "-a", "-F",
    "#{session_name}|#{pane_pid}|#{pane_dead}|#{pane_dead_status}|#{session_attached}|#{pane_width}|#{pane_height}|#{pid}|#{start_time}|#{window_activity}",
  ]);
  if (r.code !== 0) return [];
  const out: PaneInfo[] = [];
  for (const line of r.stdout.split("\n")) {
    const [name, pid, dead, status, clients, w, h, serverPid, serverStart, activity] = line.split("|");
    if (!name?.startsWith("ab-")) continue;
    out.push({
      name,
      pid: Number(pid),
      dead: dead === "1",
      deadStatus: status ? Number(status) : null,
      clients: Number(clients) || 0,
      width: Number(w) || 0,
      height: Number(h) || 0,
      activity: Number(activity) || 0,
      server: { pid: Number(serverPid) || 0, start: (Number(serverStart) || 0) * 1000 },
    });
  }
  return out;
}

/**
 * Leave copy mode first, in the same invocation. A wheel-up in the browser's
 * terminal puts a pane that is not on the alternate screen (Devin's) into
 * copy mode and leaves it there; the paste still reaches the agent, but
 * copy mode takes the Enter, so every message sits unsent in its input box.
 */
const LEAVE_MODE = (name: string): string[] => ["copy-mode", "-q", "-t", `=${name}:`, ";"];

/** The pause after a paste before its first look at the pane. */
const PASTE_SETTLE_MS = 120;
const PASTE_POLL_MS = 30;
/** How long to look for the message's own words in the pane before settling
 *  for any row the paste changed: a TUI that collapses a long paste shows a marker. */
const PASTE_SHOWN_MS = 2_000;
/** A pane that shows nothing of a paste for this long has not taken it. */
const PASTE_WAIT_MS = 10_000;
/** How long one Enter has to empty the input box, and how many are pressed. */
const ENTER_WAIT_MS = 3_000;
const ENTER_TRIES = 3;

/** The message is in the pane's input box, or nowhere, and was not submitted. */
export class Unsubmitted extends Error {}

/**
 * Type `text` into the session as one prompt: a bracketed paste (so a
 * multi-line message is not submitted line by line), then Enter on its own,
 * and return only once the message has left the input box.
 *
 * The Enter must be read *after* the paste, or the TUI takes it as part of the
 * paste, so it is pressed once the pane shows what was pasted. One Enter is
 * not proof either: a completion popup the pasted text opened takes it, as
 * does a TUI that is slow to read. The row the draft starts on is watched, and
 * Enter pressed again while the draft still sits there; a draft that outlasts
 * them throws `Unsubmitted`, so nothing reports a message sent that was only typed.
 *
 * With `pieces` (`ProviderAdapter.pasteInPieces`), the message goes in as many
 * small pastes, with the line breaks pressed as keys: see `pasteInPieces`.
 */
export async function sendText(name: string, text: string, opts: { pieces?: number } = {}): Promise<void> {
  const before = screenRows(name);
  if (opts.pieces) pasteInPieces(name, text, opts.pieces);
  else pasteBuffers(name, [text]);
  const draft = await draftRow(name, text, before);
  if (!draft) {
    throw new Unsubmitted(`its pane showed nothing of the message for ${PASTE_WAIT_MS / 1000}s, so Enter was not pressed: a dialog may be up, or it is not reading its terminal`);
  }
  await submit(name, draft);
}

/**
 * Press Enter on a message an earlier `sendText` left in the input box
 * because the pane showed it only after that stopped looking (a TUI starved
 * of CPU). The bottom row that starts with the message's first words is the
 * draft; false when no row does.
 */
export async function submitDraft(name: string, text: string): Promise<boolean> {
  const said = text.replace(/\s+/g, "");
  const rows = screenRows(name);
  for (let index = rows.length - 1; index >= 0; index--) {
    const head = rowHead(rows[index]!);
    if (head.words.length < Math.min(6, said.length) || !said.startsWith(head.words)) continue;
    await submit(name, { index, ...head, below: rowsBelow(rows, index) });
    return true;
  }
  return false;
}

async function submit(name: string, draft: DraftRow): Promise<void> {
  for (let press = 0; press < ENTER_TRIES; press++) {
    sendKeys(name, ["Enter"]);
    if (await leftRow(name, draft)) return;
  }
  throw new Unsubmitted(`the message was typed, but it is still in the input box after Enter was pressed ${ENTER_TRIES} times: something on its screen is taking the key`);
}

const screenRows = (name: string): string[] => (capture(name) ?? "").split("\n");

/** A row as an input box holds it: its border or prompt glyph, and its first words, both without spaces. */
interface RowHead {
  frame: string;
  words: string;
}

function rowHead(row: string): RowHead {
  const [, frame = "", rest = ""] = /^((?:[\s>|]|[^\x20-\x7e])*)(.*)$/.exec(row) ?? [];
  const words = rest.replace(/(?:[\s|]|[^\x20-\x7e])+$/, "").replace(/\s+/g, "");
  return { frame: frame.replace(/\s+/g, ""), words: words.slice(0, 24) };
}

interface DraftRow extends RowHead {
  index: number;
  /** Rows with anything on them under it: a TUI that prints the sent message
   *  where its box was puts the reply and the box under that. */
  below: number;
}

const rowsBelow = (rows: string[], index: number): number => rows.slice(index + 1).filter((r) => r.trim()).length;

/**
 * The topmost row the paste drew: one that changed and starts with words of
 * the message, or, when none shows them in time, the topmost that changed.
 * Null when the pane never changed. The top row, because a completion popup
 * and the tail of the draft are below it, and both change without a submit.
 */
async function draftRow(name: string, text: string, before: string[]): Promise<DraftRow | null> {
  await Bun.sleep(PASTE_SETTLE_MS);
  const said = text.replace(/\s+/g, "");
  const started = Date.now();
  for (;;) {
    const rows = screenRows(name);
    const changed = rows.map((row, index) => ({ index, row, ...rowHead(row) })).filter((r) => r.row !== before[r.index] && r.words);
    const shown = changed.find((r) => r.words.length >= Math.min(6, said.length) && said.includes(r.words));
    const waited = Date.now() - started;
    const found = shown ?? (waited >= PASTE_SHOWN_MS ? changed[0] : undefined);
    if (found) return { index: found.index, frame: found.frame, words: found.words, below: rowsBelow(rows, found.index) };
    if (waited >= PASTE_WAIT_MS) return null;
    await Bun.sleep(PASTE_POLL_MS);
  }
}

/**
 * Whether the draft left its row within one Enter's wait. It is still there
 * while the row has the same frame and words with no more under it; the same
 * words in another frame, or over a reply, are the sent message shown back.
 */
async function leftRow(name: string, draft: DraftRow): Promise<boolean> {
  const deadline = Date.now() + ENTER_WAIT_MS;
  for (;;) {
    const rows = screenRows(name);
    const now = rowHead(rows[draft.index] ?? "");
    if (now.words !== draft.words || now.frame !== draft.frame || rowsBelow(rows, draft.index) > draft.below) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(PASTE_POLL_MS);
  }
}

/** tmux refuses a command line past a length it does not document ("command
 *  too long"); this many pastes and key presses at a time stays well inside. */
const PASTE_BATCH = 40;

/**
 * Paste each line in pieces of at most `max` characters, and press Ctrl+J (a
 * line break in the prompt, where Enter would send it) between lines. To the
 * TUI the message was typed: no single paste is long enough, or has line
 * breaks enough, for it to be set apart as pasted.
 */
function pasteInPieces(name: string, text: string, max: number): void {
  const steps: (string | null)[] = [];
  for (const [i, line] of text.split(/\r\n|\r|\n/).entries()) {
    if (i > 0) steps.push(null);
    steps.push(...pieces(line, max));
  }
  for (let i = 0; i < steps.length; i += PASTE_BATCH) pasteBuffers(name, steps.slice(i, i + PASTE_BATCH));
}

/** `line` cut every `max` UTF-16 units (what a TUI written in JS counts), never inside a surrogate pair. */
function pieces(line: string, max: number): string[] {
  const out: string[] = [];
  for (let at = 0; at < line.length; ) {
    let end = Math.min(line.length, at + max);
    const last = line.charCodeAt(end - 1);
    if (end < line.length && last >= 0xd800 && last <= 0xdbff && end - at > 1) end--;
    out.push(line.slice(at, end));
    at = end;
  }
  return out;
}

/** Paste each string, in order and in one tmux invocation; a `null` is a line break pressed as a key. */
function pasteBuffers(name: string, steps: (string | null)[]): void {
  const target = `=${name}:`;
  const args = LEAVE_MODE(name).slice(0, -1);
  for (const [i, step] of steps.entries()) {
    if (step === null) {
      args.push(";", "send-keys", "-t", target, "C-j");
      continue;
    }
    const buffer = `ab-${process.pid}-${Date.now()}-${i}`;
    const load = tmux(["load-buffer", "-b", buffer, "-"], step);
    if (load.code !== 0) throw new Error(`tmux load-buffer failed: ${load.stderr.trim()}`);
    args.push(";", "paste-buffer", "-p", "-d", "-b", buffer, "-t", target);
  }
  const paste = tmux(args);
  if (paste.code !== 0) throw new Error(`tmux paste failed: ${paste.stderr.trim()}`);
}

/** The paste buffers' names, newest first. A TUI that copies inside tmux adds one (`load-buffer`). */
export function bufferNames(): string[] {
  const r = tmux(["list-buffers", "-F", "#{buffer_name}"]);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

/** A paste buffer's contents, and the buffer gone. */
export function takeBuffer(buffer: string): string | null {
  const r = tmux(["show-buffer", "-b", buffer]);
  if (r.code !== 0) return null;
  tmux(["delete-buffer", "-b", buffer]);
  return r.stdout;
}

/** Press keys by tmux name: `Enter`, `Escape`, `C-c`, `Down`, or literal text. */
export function sendKeys(name: string, keys: string[]): void {
  if (keys.length === 0) return;
  const r = tmux([...LEAVE_MODE(name), "send-keys", "-t", `=${name}:`, ...keys]);
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
 * The visible screens of many panes in one tmux call — the same text `capture`
 * returns for each, null for a pane that is gone. One call per pass rather
 * than one per pane: a busy tmux server answers each call in ~50ms.
 */
export function captureMany(names: string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const marker = `\u001fab-capture-${crypto.randomUUID()}:`;
  let pending = names;
  while (pending.length) {
    const args = pending.flatMap((n) => ["display-message", "-p", `${marker}${n}`, ";", "capture-pane", "-p", "-J", "-t", `=${n}:`, ";"]);
    const r = tmux(args.slice(0, -1));
    let name: string | null = null;
    let lines: string[] = [];
    const flush = () => {
      if (name !== null) out.set(name, lines.length ? `${lines.join("\n")}\n` : "");
    };
    for (const line of r.stdout.split("\n").slice(0, -1)) {
      if (line.startsWith(marker)) {
        flush();
        name = line.slice(marker.length);
        lines = [];
      } else lines.push(line);
    }
    flush();
    // tmux stops a command sequence at the first failure: the pane it named is
    // gone, and the ones after it still need their own call.
    if (r.code !== 0 && name !== null) out.set(name, null);
    const done = name === null ? pending.length : pending.indexOf(name) + 1;
    if (name === null) for (const n of pending) out.set(n, null);
    pending = pending.slice(done);
  }
  return out;
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

/**
 * Give a window room to answer a dialog in, or hand it back. A terminal tab
 * squeezed under the answer card leaves the window a dozen rows tall, and a
 * dialog taller than that scrolls its tab bar and question off the top,
 * where they cannot be read. Resizing pins the size (`window-size manual`)
 * while the answer is typed; handing it back lets an attached client's size
 * decide again, or leaves a window nobody is looking at the bigger size.
 * Returns whether it grew, so a caller undoes only its own.
 */
export function setRoomy(name: string, on: boolean, min = { cols: 80, rows: 24 }, to = { cols: 140, rows: 45 }): boolean {
  const r = tmux(["display-message", "-p", "-t", `=${name}:`, "#{session_attached} #{window_width} #{window_height}"]);
  if (r.code !== 0) return false;
  const [attached, cols, rows] = r.stdout.trim().split(" ").map(Number);
  if (!on) {
    tmux(["set-option", "-w", "-u", "-t", `=${name}:`, "window-size"]);
    if (attached! > 0) tmux(["resize-window", "-A", "-t", `=${name}:`]);
    return true;
  }
  if (cols! >= min.cols && rows! >= min.rows) return false;
  const x = Math.max(cols!, to.cols);
  const y = Math.max(rows!, to.rows);
  return tmux(["resize-window", "-t", `=${name}:`, "-x", String(x), "-y", String(y)]).code === 0;
}

/** The argv that attaches a terminal to a session. */
export function attachArgv(name: string): string[] {
  return ["tmux", "-L", tmuxSocket(), "attach-session", "-t", `=${name}`];
}

export function tmuxVersion(): string | null {
  const p = Bun.spawnSync(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
}
