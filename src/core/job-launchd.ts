/** One-shot macOS jobs. launchd owns the process group; neither the caller
 * nor the server must stay alive. These plists are never installed at login. */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "./paths";
import type { WaitSpec } from "./types";

type JobSpec = Extract<WaitSpec, { kind: "job" }>;
const target = /^(?:gui|user)\/(\d+)\/com\.agentbox\.job\.(mac[a-zA-Z0-9]+)$/;
export const isLaunchdJob = (unit: string): boolean => target.test(unit);
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

// A self-contained snapshot: an upgrade or moving the caller's checkout
// cannot change an already launched job. No environment values in this file
// or the plist. The payload is private and consumed before starting work.
export const launchdRunner = String.raw`import { openSync, closeSync, fsyncSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const payload = join(dir, "payload.json");
const result = join(dir, "result");
// Commit the attempt BEFORE spawn. A crash in this gap means unknown work,
// never permission to repeat it (even if launchd is kickstarted by hand).
try {
  const fd = openSync(join(dir, "attempted"), "wx", 0o600);
  fsyncSync(fd); closeSync(fd);
  const parent = openSync(dir, "r"); fsyncSync(parent); closeSync(parent);
} catch { rmSync(payload, { force: true }); process.exit(125); }
let finished = false;
function finish(word) {
  if (finished) return;
  finished = true;
  writeFileSync(result + ".tmp", word + "\n", { mode: 0o600 });
  renameSync(result + ".tmp", result);
}
for (const [signal, number] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]]) {
  process.on(signal, () => { finish("signal killed " + signal); process.exit(128 + number); });
}
try {
  let p;
  try { p = JSON.parse(readFileSync(payload, "utf8")); }
  finally { rmSync(payload, { force: true }); }
  const child = Bun.spawn(["/bin/bash", "-c", p.command], { cwd: p.cwd, env: p.env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  finish(child.signalCode ? "signal killed " + child.signalCode : (code === 0 ? "success" : "exit-code") + " exited " + code);
} catch {
  // Spawn/parse errors can contain credentials. Keep diagnostics categorical.
  finish("launch-error exited 126");
}
process.exit(0);
`;

interface LaunchctlReply {
  out: string;
  err: string;
  exit: number;
}
async function launchctl(args: string[]): Promise<LaunchctlReply> {
  const p = Bun.spawn(["/bin/launchctl", ...args], { timeout: 10_000, stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, exit };
}

/** Only launchd's explicit missing-service reply proves absence. */
function missing(p: LaunchctlReply, unit: string): boolean {
  return p.exit === 113 && p.err.includes(`Could not find service "${unit.split("/").at(-1)}"`);
}

/** Do not let a supplied wait spec turn cleanup into arbitrary file deletion. */
function jobDir(spec: JobSpec): string | null {
  const m = target.exec(spec.unit);
  if (!m || Number(m[1]) !== process.getuid?.()) return null;
  const dir = join(agentboxHome(), "jobs", m[2]!);
  return spec.result === join(dir, "result") && spec.log === join(dir, "output.log") ? dir : null;
}

function clearPayload(spec: JobSpec): void {
  const dir = jobDir(spec);
  if (dir) rmSync(join(dir, "payload.json"), { force: true });
}

/** Refusal cleanup, also used once the server has durable completion evidence.
 * Keep the attempt marker and evidence; reloading a leftover plist cannot replay. */
export async function stopLaunchdJob(spec: JobSpec): Promise<void> {
  if (!isLaunchdJob(spec.unit) || Number(target.exec(spec.unit)![1]) !== process.getuid?.()) throw new Error("not this user's agentbox job");
  const p = await launchctl(["bootout", spec.unit]);
  if (p.exit !== 0) {
    const state = await launchctl(["print", spec.unit]);
    if (!missing(state, spec.unit)) throw new Error(`could not confirm the job stopped; inspect ${spec.unit}`);
  }
  clearPayload(spec);
}

export async function startLaunchdJob(command: string, description: string): Promise<JobSpec> {
  const jobs = join(agentboxHome(), "jobs");
  mkdirSync(jobs, { recursive: true, mode: 0o700 });
  // mkdtemp creates 0700 even when the existing jobs directory is permissive.
  const dir = mkdtempSync(join(jobs, `mac${crypto.randomUUID().replaceAll("-", "")}`));
  const id = dir.slice(jobs.length + 1);
  const label = `com.agentbox.job.${id}`;
  // A logged-in Mac's agents belong to its GUI bootstrap domain. Select the
  // domain before launch; never retry a bootstrap in another domain.
  const uid = process.getuid!();
  const domain = (await launchctl(["print", `gui/${uid}`])).exit === 0 ? `gui/${uid}` : `user/${uid}`;
  const spec: JobSpec = { kind: "job", unit: `${domain}/${label}`, command: description, log: join(dir, "output.log"), result: join(dir, "result") };
  const plist = join(dir, `${label}.plist`);
  try {
    writeFileSync(join(dir, "payload.json"), JSON.stringify({ command, cwd: process.cwd(), env: process.env }), { mode: 0o600 });
    writeFileSync(join(dir, "run.mjs"), launchdRunner, { mode: 0o600 });
    writeFileSync(spec.log, "", { mode: 0o600 });
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(dir, "run.mjs"))}</string><string>${xml(dir)}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>AbandonProcessGroup</key><false/>
<key>ExitTimeOut</key><integer>5</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(spec.log)}</string>
<key>StandardErrorPath</key><string>${xml(spec.log)}</string>
</dict></plist>\n`, { mode: 0o600 });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const p = await launchctl(["bootstrap", domain, plist]);
  if (p.exit !== 0) {
    try { await stopLaunchdJob(spec); }
    catch { throw new Error(`job launch is unconfirmed; do not rerun it. Inspect ${spec.unit}; output: ${spec.log}; result: ${spec.result}. Stop with: launchctl bootout ${spec.unit}`); }
    throw new Error(`launchd refused the job or its reply was lost (exit ${p.exit}); it has been stopped. It may have run: inspect ${spec.log} and ${spec.result} before retrying`);
  }
  return spec;
}

/** Nonzero wrapper exits/signals are evidence of failure. A wrapper's exit 0
 * without a result is NOT evidence that the command succeeded. */
export async function readLaunchdJob(spec: JobSpec): Promise<{ running: boolean; result: { result: string; code: string; status: string } | null }> {
  if (process.platform !== "darwin") throw new Error("this launchd job can only be watched on macOS");
  const p = await launchctl(["print", spec.unit]);
  if (missing(p, spec.unit)) {
    clearPayload(spec);
    return { running: false, result: null };
  }
  if (p.exit !== 0) throw new Error(`launchctl could not read ${spec.unit} (exit ${p.exit})`);
  const out = p.out;
  const state = /^\s*state = (.+)$/m.exec(out)?.[1];
  if (/^\s*pid = \d+$/m.test(out) || ["running", "spawn scheduled", "spawning", "waiting", "pending", "xpcproxy"].includes(state ?? "")) return { running: true, result: null };
  if (state !== "not running" && state !== "exited") throw new Error(`launchctl returned an unknown job state for ${spec.unit}`);
  const signal = /^\s*last terminating signal = (.+)$/m.exec(out)?.[1];
  const code = /^\s*last exit code = (-?\d+)$/m.exec(out)?.[1];
  const result = signal ? { result: "signal", code: "killed", status: signal } : code && code !== "0" ? { result: "launch-error", code: "exited", status: code } : null;
  if (result) {
    // Persist manager evidence before bootout removes it. Never manufacture success.
    const dir = jobDir(spec);
    if (dir) {
      writeFileSync(spec.result + ".tmp", `${result.result} ${result.code} ${result.status.replaceAll(/\s+/g, "_")}\n`, { mode: 0o600 });
      renameSync(spec.result + ".tmp", spec.result);
      await stopLaunchdJob(spec);
    }
  }
  return { running: false, result };
}
