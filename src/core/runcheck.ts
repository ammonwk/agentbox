/**
 * Run a shell line at the lowest priority with a time limit, on Linux and
 * macOS alike. The scheduler's note command used `timeout`, which macOS does
 * not have, so every note command failed there with exit 127. The limit is
 * now Bun's own: past it the shell gets SIGTERM, then SIGKILL 5 s later.
 */
export type Ran = { code: number; out: string; err: string; timedOut: boolean };

export async function runShell(cmd: string, opts: { cwd: string; env?: Record<string, string | undefined>; timeoutS: number }): Promise<Ran> {
  const p = Bun.spawn(["nice", "-n", "19", "sh", "-c", cmd], {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
  });
  let timedOut = false;
  const term = setTimeout(() => {
    timedOut = true;
    p.kill("SIGTERM");
  }, opts.timeoutS * 1000);
  const kill = setTimeout(() => p.kill("SIGKILL"), opts.timeoutS * 1000 + 5000);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err, timedOut };
  } finally {
    clearTimeout(term);
    clearTimeout(kill);
  }
}
