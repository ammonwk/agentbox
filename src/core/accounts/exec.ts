/** A small async subprocess runner for the accounts module.
 *
 * Async because every caller here runs on the server's event loop on a timer
 * (`devin auth status`, `omp usage --json`), and `spawnSync` would freeze every
 * websocket for as long as the CLI takes — `omp usage` fans out to every
 * provider it knows and can take seconds.
 */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  env?: Record<string, string>;
  /** Removed from the inherited environment (e.g. a stray CLAUDE_CONFIG_DIR). */
  unset?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export type ExecFn = (argv: string[], opts?: ExecOptions) => Promise<ExecResult>;

export function childEnv(env: Record<string, string> = {}, unset: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  for (const k of unset) delete out[k];
  return { ...out, ...env };
}

export const exec: ExecFn = async (argv, opts = {}) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      env: childEnv(opts.env, opts.unset),
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    // A missing binary throws here rather than exiting 127.
    return { code: 127, stdout: "", stderr: `${argv[0]}: ${(err as Error).message}`, timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs ?? 20_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { code: timedOut ? -1 : code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
};
