/** What a session was started with, carried across an adopt.
 *
 * Adopt stops a process some other terminal started and resumes the
 * conversation in our tmux. The transcript carries the conversation; it does
 * not carry how the CLI was launched — its permission flags, extra
 * directories, MCP config, the PATH of the shell it came from. Those are read
 * off the live process before it is stopped and kept on the session record,
 * so this resume and every later one start the same way.
 */

export interface Launch {
  /** Provider flags, from the adapter's `carryOver` (never the session id or prompt). */
  args: string[];
  /** Variables the launching shell set that the server's own environment lacks. */
  env: Record<string, string>;
}

/**
 * Where the process ran, not what it was: the terminal, the shell's own
 * bookkeeping, the service manager, and the per-account homes the account
 * pin already sets.
 */
const NOT_CARRIED =
  /^(PWD|OLDPWD|_|SHLVL|GPG_TTY|SSH_TTY|SSH_CONNECTION|SSH_CLIENT|TTY|WINDOWID|COLUMNS|LINES|TERM|TERM_PROGRAM(_VERSION)?|TERMINFO|COLORTERM|VTE_VERSION|(GHOSTTY|KITTY|WEZTERM|ALACRITTY|KONSOLE|ITERM)_\w+|TMUX|TMUX_PANE|STY|INVOCATION_ID|JOURNAL_STREAM|SYSTEMD_EXEC_PID|MANAGERPID|XDG_ACTIVATION_TOKEN|DESKTOP_STARTUP_ID|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|EXECPATH|MESSAGING_\w+)|CLAUDE_PID|CLAUDE_CONFIG_DIR|CODEX_HOME|PI_CODING_AGENT_DIR|AGENTBOX_\w+)$/;

/** The part of a process's environment that its shell chose and ours did not. */
export function carryEnv(theirs: ReadonlyMap<string, string>, ours: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of theirs) {
    if (NOT_CARRIED.test(k) || ours[k] === v) continue;
    out[k] = v;
  }
  return out;
}

/** How many values a carried flag takes: none, one, or every word up to the
 *  next flag (as commander parses a variadic option). */
export type Arity = "none" | "one" | "many";

/**
 * The flags of `argv` that `allowed` names, with their values, in order: an
 * adapter's `carryOver`. An allowlist, not a denylist: a flag we do not know
 * the arity of could swallow the prompt, and one we do not know the meaning
 * of could be the session id. `--flag=value` keeps its value attached.
 */
export function carryFlags(argv: string[], allowed: Readonly<Record<string, Arity>>): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const arity = allowed[flag];
    if (!arity) continue;
    out.push(a);
    if (arity === "none" || eq > 0) continue;
    if (arity === "one") {
      if (argv[i + 1] !== undefined) out.push(argv[++i]!);
      continue;
    }
    while (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-")) out.push(argv[++i]!);
  }
  return out;
}

/** Does `args` set any of `flags`, alone or as `--flag=value`? */
export function setsFlag(args: readonly string[], ...flags: string[]): boolean {
  return args.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));
}
