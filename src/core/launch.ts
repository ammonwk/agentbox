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
