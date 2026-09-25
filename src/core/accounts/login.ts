/** Logging an account in, by running the provider's own login CLI in a PTY and
 * showing you the URL / code it prints.
 *
 * A PTY rather than pipes because every one of these CLIs changes behaviour
 * when stdout is not a terminal — claude's `auth login` reads the pasted code
 * from a line reader on stdin that only prompts on a TTY, devin's manual token
 * flow is a TUI prompt. Bun's `terminal` spawn option gives us one; the
 * terminal must be `close()`d or the process lingers after exit.
 *
 * Security: the PTY echoes what we type, so a pasted `code#state` or devin
 * token comes straight back in the output. Every pasted string is scrubbed
 * from the output buffer before the buffer is exposed (see `scrubSecrets`),
 * and nothing here logs output or pasted text.
 */

import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Account, LoginFlow, ProviderId } from "../types";
import { childEnv } from "./exec";
import { userHome } from "../paths";
import { AccountError, authEnv, credentialsPath } from "./homes";

const OUTPUT_KEEP = 4096;
/** Raw (unscrubbed) text kept internally; larger than OUTPUT_KEEP so a secret
 *  that straddles the visible window's start is still whole when scrubbed. */
const RAW_KEEP = 16384;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const KEEP_FINISHED_MS = 10 * 60_000;
/** Any run of this many characters of a pasted secret is redacted wherever it
 *  appears — catches echoes split by a TUI's cursor movement or line wrap. */
const SCRUB_NGRAM = 12;

export interface LoginCommand {
  argv: string[];
  env: Record<string, string>;
  unset: string[];
  cwd?: string;
  /** Present after a successful login. */
  credentialFile: string;
  needsPaste: boolean;
}

/**
 * The login command for an account. `BROWSER=true` makes claude's "open the
 * browser" step a no-op on the server (it runs `$BROWSER <url>`), which is what
 * we want: the URL is shown in the UI of whichever machine you are on.
 */
export function loginCommand(account: Pick<Account, "provider" | "home" | "isDefault">): LoginCommand {
  if (account.provider === "omp") {
    throw new AccountError(400, "omp logins are managed by omp itself — run `omp auth-broker login <provider>` in a terminal");
  }
  const { env, unset } = authEnv(account);
  const common = {
    env: { BROWSER: "true", NO_COLOR: "1", ...env },
    unset,
    credentialFile: credentialsPath(account.provider, account.home)!,
  };
  switch (account.provider) {
    case "claude":
      return { argv: ["claude", "auth", "login", "--claudeai"], ...common, needsPaste: true };
    case "codex":
      return { argv: ["codex", "login", "--device-auth"], ...common, needsPaste: false };
    case "devin":
      return { argv: ["devin", "auth", "login", "--force-manual-token-flow"], ...common, needsPaste: true };
  }
}

// ---------------------------------------------------------------- parsing

/**
 * Strip terminal control sequences. OSC first (claude prints its URL as an
 * OSC 8 hyperlink, `ESC ] 8 ; ; URL BEL text ESC ] 8 ; ; BEL`, and the URL
 * must survive as the visible text, not be glued to the escape), then CSI,
 * then the odd single-character escapes, then carriage returns that are not
 * part of a CRLF.
 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r(?!\n)/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

const URL_RE = /https?:\/\/[^\s"'<>\x1b]+/g;

/**
 * The URL to open and (codex) the one-time code, from what the CLI printed so
 * far. Each CLI announces its URL after a phrase of its own; the first URL
 * after that phrase wins, falling back to the first URL at all.
 *
 *   claude: "If the browser didn't open, visit: <url>"
 *   codex:  "1. Open this link in your browser and sign in to your account\n   <url>"
 *           "2. Enter this one-time code (expires in 15 minutes)\n   ABCD-12345"
 *   devin:  "Visit <url> to sign in, then copy the token and paste it below."
 */
export function parseLoginOutput(provider: ProviderId, text: string): { url: string | null; userCode: string | null } {
  const anchors: Record<ProviderId, RegExp> = {
    claude: /visit:/i,
    codex: /open this link/i,
    devin: /visit\s/i,
    omp: /https?:/,
  };
  const m = anchors[provider].exec(text);
  const after = m ? text.slice(m.index) : text;
  const url = (after.match(URL_RE)?.[0] ?? text.match(URL_RE)?.[0] ?? null)?.replace(/[).,;]+$/, "") ?? null;
  let userCode: string | null = null;
  if (provider === "codex") {
    const i = text.search(/one-time code/i);
    if (i >= 0) userCode = /\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/.exec(text.slice(i))?.[1] ?? null;
  }
  return { url, userCode };
}

/** Redact every pasted secret, and any ≥ SCRUB_NGRAM-long fragment of one. */
export function scrubSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("[pasted]");
    if (s.length < SCRUB_NGRAM) continue;
    const grams = new Set<string>();
    for (let i = 0; i + SCRUB_NGRAM <= s.length; i++) grams.add(s.slice(i, i + SCRUB_NGRAM));
    const mask = new Uint8Array(out.length);
    let hit = false;
    for (let i = 0; i + SCRUB_NGRAM <= out.length; i++) {
      if (grams.has(out.slice(i, i + SCRUB_NGRAM))) {
        mask.fill(1, i, i + SCRUB_NGRAM);
        hit = true;
      }
    }
    if (!hit) continue;
    let r = "";
    for (let i = 0; i < out.length; i++) {
      if (mask[i]) {
        if (i === 0 || !mask[i - 1]) r += "[pasted]";
      } else r += out[i];
    }
    out = r;
  }
  return out;
}

// ---------------------------------------------------------------- manager

interface Running {
  flow: LoginFlow;
  account: Account;
  cmd: LoginCommand;
  proc: ReturnType<typeof Bun.spawn> | null;
  raw: string;
  secrets: string[];
  timer: ReturnType<typeof setTimeout> | null;
  finished: boolean;
}

export interface LoginManagerOptions {
  /** Override the command (tests run a fake script). */
  command?: (account: Account) => LoginCommand;
  /**
   * Called once when a login succeeds, before the flow is marked done — the
   * service re-identifies the account here. May return a warning to show on
   * the finished flow (e.g. "this is the same login as account X").
   */
  onSuccess?: (account: Account) => Promise<string | null | void>;
  timeoutMs?: number;
  keepFinishedMs?: number;
}

export class LoginManager extends EventEmitter {
  private flows = new Map<string, Running>();

  constructor(private opts: LoginManagerOptions = {}) {
    super();
  }

  list(): LoginFlow[] {
    return [...this.flows.values()].map((r) => ({ ...r.flow }));
  }

  get(id: string): LoginFlow | null {
    const r = this.flows.get(id);
    return r ? { ...r.flow } : null;
  }

  private active(): Running[] {
    return [...this.flows.values()].filter((r) => !r.finished);
  }

  /**
   * Start a login for an account. One per provider at a time: codex's callback
   * server binds a fixed port (1455), and two concurrent claude logins would
   * leave you guessing which browser tab belongs to which account.
   */
  start(account: Account): LoginFlow {
    const busy = this.active().find((r) => r.flow.provider === account.provider);
    if (busy) {
      if (busy.flow.accountId === account.id) return { ...busy.flow };
      throw new AccountError(409, `a ${account.provider} login is already running (for "${busy.account.label}") — finish or cancel it first`);
    }
    const cmd = (this.opts.command ?? loginCommand)(account);
    const flow: LoginFlow = {
      id: randomUUID().slice(0, 8),
      provider: account.provider,
      accountId: account.id,
      state: "starting",
      url: null,
      userCode: null,
      needsPaste: cmd.needsPaste,
      output: "",
      error: null,
      startedAt: Date.now(),
    };
    const run: Running = {
      flow, account, cmd, proc: null, raw: "", secrets: [], timer: null,
      finished: false,
    };
    this.flows.set(flow.id, run);

    const decoder = new TextDecoder();
    try {
      run.proc = Bun.spawn(cmd.argv, {
        env: childEnv(cmd.env, cmd.unset),
        cwd: cmd.cwd ?? userHome(),
        terminal: {
          cols: 120,
          rows: 40,
          data: (_t, bytes) => this.onOutput(run, decoder.decode(bytes, { stream: true })),
        },
      });
    } catch (err) {
      this.finish(run, "failed", `could not start ${cmd.argv[0]}: ${(err as Error).message}`);
      return { ...flow };
    }
    run.timer = setTimeout(() => {
      if (run.finished) return;
      this.kill(run);
      this.finish(run, "failed", "timed out after 15 minutes");
    }, this.opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
    run.timer.unref?.();
    void run.proc.exited.then((code) => this.onExit(run, code));
    this.emit("change", { ...flow });
    return { ...flow };
  }

  /** Type what the browser gave you into the CLI. */
  paste(id: string, text: string): LoginFlow {
    const run = this.flows.get(id);
    if (!run) throw new AccountError(404, `no login ${id}`);
    if (run.finished) throw new AccountError(409, `login ${id} has already ${run.flow.state === "done" ? "finished" : "failed"}`);
    const value = text.trim();
    if (!value) throw new AccountError(400, "nothing to paste");
    run.secrets.push(value);
    run.proc?.terminal?.write(`${value}\r`);
    run.flow.state = "verifying";
    this.render(run);
    return { ...run.flow };
  }

  cancel(id: string): void {
    const run = this.flows.get(id);
    if (!run || run.finished) return;
    this.kill(run);
    this.finish(run, "failed", "cancelled");
  }

  /** Cancel whatever is running for an account (it is being forgotten). */
  cancelForAccount(accountId: string): void {
    for (const r of this.active()) if (r.flow.accountId === accountId) this.cancel(r.flow.id);
  }

  stop(): void {
    for (const r of this.active()) this.cancel(r.flow.id);
  }

  // ------------------------------------------------------------ internals

  private onOutput(run: Running, chunk: string): void {
    run.raw = (run.raw + chunk).slice(-RAW_KEEP);
    this.render(run);
  }

  /** Recompute the public view of a flow from its raw output. */
  private render(run: Running): void {
    const text = stripAnsi(run.raw);
    const visible = scrubSecrets(text, run.secrets);
    run.flow.output = visible.slice(-OUTPUT_KEEP);
    if (!run.finished) {
      // Parse from the scrubbed text: a URL is never a pasted secret, and
      // parsing the raw text would let a pasted value masquerade as a code.
      const { url, userCode } = parseLoginOutput(run.flow.provider, visible);
      if (url) run.flow.url = url;
      if (userCode) run.flow.userCode = userCode;
      const ready = run.flow.provider === "codex" ? !!(run.flow.url && run.flow.userCode) : !!run.flow.url;
      if (run.flow.state === "starting" && ready) run.flow.state = "awaiting-user";
    }
    this.emit("change", { ...run.flow });
  }

  private async onExit(run: Running, code: number): Promise<void> {
    try {
      run.proc?.terminal?.close();
    } catch {
      /* already closed */
    }
    if (run.finished) return;
    const wrote = existsSync(run.cmd.credentialFile);
    if (code === 0 && wrote) {
      run.flow.state = "verifying";
      this.emit("change", { ...run.flow });
      let warning: string | null = null;
      try {
        warning = (await this.opts.onSuccess?.(run.account)) ?? null;
      } catch (err) {
        warning = `logged in, but reading the new login failed: ${(err as Error).message}`;
      }
      this.finish(run, "done", warning);
      return;
    }
    const lastLine = run.flow.output.trim().split("\n").filter(Boolean).pop() ?? "";
    this.finish(
      run,
      "failed",
      code === 0
        ? `the CLI exited without writing ${run.cmd.credentialFile}`
        : `the CLI exited with code ${code}${lastLine ? `: ${lastLine.slice(0, 200)}` : ""}`,
    );
  }

  private kill(run: Running): void {
    try {
      run.proc?.kill();
    } catch {
      /* already gone */
    }
    try {
      run.proc?.terminal?.close();
    } catch {
      /* already closed */
    }
  }

  private finish(run: Running, state: "done" | "failed", error: string | null): void {
    if (run.finished) return;
    run.finished = true;
    if (run.timer) clearTimeout(run.timer);
    run.flow.state = state;
    run.flow.error = error;
    // Drop what we typed from memory now the CLI is done with it.
    run.flow.output = scrubSecrets(stripAnsi(run.raw), run.secrets).slice(-OUTPUT_KEEP);
    run.raw = "";
    run.secrets = [];
    this.emit("change", { ...run.flow });
    const t = setTimeout(() => {
      this.flows.delete(run.flow.id);
      this.emit("change", null);
    }, this.opts.keepFinishedMs ?? KEEP_FINISHED_MS);
    t.unref?.();
  }
}
