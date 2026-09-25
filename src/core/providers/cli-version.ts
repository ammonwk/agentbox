/**
 * Is a provider's CLI installed, and what version: `<cli> --version`, for ten
 * seconds at most. A CLI that cannot be spawned is not installed; one that
 * runs but exits non-zero is installed with a version we cannot read.
 */
export async function cliVersion(argv: string[]): Promise<{ installed: boolean; version: string | null }> {
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) return { installed: true, version: null };
    // `2.1.280 (Claude Code)`, `codex-cli 0.156.1`, `devin 3000.11.3 (…)`, `omp/17.2.11`.
    const version = /\d+\.\d+(?:\.\d+)?[\w.-]*/.exec(out)?.[0] ?? (out.trim().split("\n")[0] || null);
    return { installed: true, version };
  } catch {
    return { installed: false, version: null };
  }
}
