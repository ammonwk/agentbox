/** Waits from the CLI (src/core/waits.ts): the one way a session waits on
 *  something outside its own turn. Plain text out, the id first on every line. */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError, type Api } from "../client";
import { isLaunchdJob, startLaunchdJob, stopLaunchdJob } from "../core/job-launchd";
import { agentboxHome } from "../core/paths";
import { describe, span } from "../core/waits";
import type { Wait, WaitSpec } from "../core/types";
import { parseArgs } from "./sessions";

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** `90s`, `45m`, `3h`, `2d`: milliseconds. */
function duration(v: string, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(v.trim());
  if (!m) throw new Error(`${flag} takes a length of time, as in 45m, 3h or 2d: not "${v}"`);
  return Math.round(Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]!.toLowerCase() as "s" | "m" | "h" | "d"]);
}

const USAGE = `wait takes what to wait for:
  agentbox wait pr <n|owner/repo#n|url> [--require 'Reviewed head'] [--only 'Build,API Tests'] [--head <sha>]
                        its checks concluding on a head: every check, with --require
                        those among them (each must report), or with --only just those
                        (a name takes its shards too; Merge gate is excluded)
  agentbox wait pr <n> --feedback --head <sha>     new/edited review feedback or failed checks, independent of readiness
  agentbox wait pr <n> --merged [--head <sha>]
                        its merge; with --head, also its head moving off that commit
                        (a PR yours is stacked on)
  agentbox wait run <run id|url> [-R owner/repo]     a GitHub Actions run concluding
  agentbox wait job [--name N] -- <command…>         start a long command as a unit of its
                        own, which outlives this session's process; told when it ends
  agentbox wait session <id>...      the first of those sessions to end its turn or stop
  agentbox wait until [--every 2m] -- <command>      asked again and again: exit 0 is the
                        event (what it prints is said), exit 1 with nothing on stderr is
                        not yet, anything else is a look that failed. One argument is a
                        shell line, several an argv. For a PR, use wait pr
  agentbox wait time <45m>           nothing but the time
all take --timeout <3h> and --for <session id>.`;

/** `agentbox wait <what> … [--timeout 3h] [--for ID]`: arm one and return at once. */
export async function wait(api: Api, args: string[]): Promise<number> {
  const [kind, ...more] = args;
  const { flags, rest } = parseArgs(more, ["require", "only", "head", "timeout", "for", "R", "repo", "name", "every"], ["merged", "feedback"]);
  const timeout = str(flags.get("timeout"));
  const body: Record<string, unknown> = {
    session: str(flags.get("for")) ?? process.env.AGENTBOX_SESSION,
    callerPid: process.pid,
    cwd: process.cwd(),
    timeoutMs: timeout ? duration(timeout, "--timeout") : undefined,
  };
  let spec: Partial<WaitSpec> & { kind: WaitSpec["kind"] };
  switch (kind) {
    case "pr": {
      if (!rest[0]) throw new Error("wait pr needs the pull request: its number, owner/repo#number, or its URL");
      body.pr = rest[0];
      const names = (flag: string) => str(flags.get(flag))?.split(",").map((c) => c.trim()).filter(Boolean) ?? [];
      if (flags.has("require") && flags.has("only")) throw new Error("--require adds checks that must report to every check; --only waits for just those: take one");
      spec = { kind: "pr", checks: [...names("require"), ...names("only")], all: !flags.has("feedback") && !flags.has("only") && !flags.has("merged"), head: str(flags.get("head")) ?? null, merged: flags.has("merged"), ...(flags.has("feedback") ? { feedback: true } : {}) };
      break;
    }
    case "run": {
      const id = /(\d+)(?:\/job\/\d+)?\/?$/.exec(rest[0] ?? "")?.[1];
      if (!id) throw new Error("wait run needs a GitHub Actions run: its id (gh run list shows it) or its URL");
      const repo = str(flags.get("R")) ?? str(flags.get("repo")) ?? /github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\//.exec(rest[0]!)?.[1];
      spec = { kind: "run", run: Number(id), ...(repo ? { repo } : {}) };
      break;
    }
    case "job":
      spec = startJob(rest, str(flags.get("name")));
      break;
    case "session":
      if (rest.length === 0) throw new Error("wait session needs the ids of the sessions to wait on");
      spec = { kind: "session", ids: rest };
      break;
    case "until": {
      if (rest.length === 0) throw new Error("wait until needs the command to ask, after --: exit 0 when it has happened, 1 while it has not");
      const every = str(flags.get("every"));
      spec = { kind: "until", cmd: commandLine(rest), cwd: process.cwd(), ...(every ? { everyMs: duration(every, "--every") } : {}) };
      break;
    }
    case "time":
      if (!rest[0]) throw new Error("wait time needs how long: agentbox wait time 45m");
      body.timeoutMs = duration(rest[0], "wait time");
      spec = { kind: "time" };
      break;
    default:
      throw new Error(USAGE);
  }
  let made: { wait: Wait; already: boolean };
  try {
    made = await api<{ wait: Wait; already: boolean }>("POST", "/api/waits", { ...body, spec });
    if (spec.kind === "job" && spec.unit && isLaunchdJob(spec.unit)) {
      const w = made?.wait;
      if (!w || !Number.isInteger(w.id) || typeof w.sessionId !== "string" || !Number.isFinite(w.deadline) || !Number.isFinite(w.createdAt) ||
        w.spec?.kind !== "job" || w.spec.unit !== spec.unit || w.spec.log !== spec.log || w.spec.result !== spec.result) {
        throw new Error("the server did not return this job's wait receipt");
      }
    }
  } catch (e) {
    if (spec.kind === "job" && spec.unit) {
      if (isLaunchdJob(spec.unit)) {
        const job = spec as Extract<WaitSpec, { kind: "job" }>;
        // The route validates and arm() refuses before inserting. Transport,
        // malformed replies and 5xx can instead follow a committed wait.
        if (e instanceof ApiError && e.status !== null && [400, 401, 403, 404, 409, 422, 429].includes(e.status)) {
          try { stopLaunchdJob(job); }
          catch (stop) { throw new Error(`${(e as Error).message}; ${(stop as Error).message}. ${jobEvidence(job)}`); }
          throw new Error(`${e.message}; the job was stopped after registration was refused. It may have run. ${jobEvidence(job)}`);
        }
        throw new Error(`wait registration is unconfirmed: ${(e as Error).message}. The job may still run and the wait may be armed. Do not rerun the command; inspect agentbox waits and ${job.unit}. ${jobEvidence(job)}`);
      }
      // Preserve the systemd launcher's existing refusal behavior.
      Bun.spawnSync(["systemctl", "--user", "stop", spec.unit]);
    }
    throw e;
  }
  const w = made.wait;
  const by = new Date(w.deadline).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  console.log(`${w.id}  ${made.already ? "already armed" : "armed"}  ${describe(w.spec)}`);
  if (w.spec.kind === "job") console.log(`${w.id}  ${jobEvidence(w.spec)}`);
  console.log(
    w.spec.kind === "time"
      ? `${w.id}  ${w.sessionId} is told at ${by}. End your turn or carry on with other work.`
      : `${w.id}  ${w.sessionId} is told the moment it happens, can no longer happen, or cannot be watched, and at ${by} (${span(w.deadline - w.createdAt)}) if none has. End your turn or carry on with other work: do not poll for it or sleep on it.`,
  );
  return 0;
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** One argument is a shell command line; several are an argv, each quoted, so `bash -c '<script>'` reaches sh whole. */
export const commandLine = (argv: string[]): string => (argv.length === 1 ? argv[0]! : argv.map(shq).join(" "));

const stopCommand = (spec: Extract<WaitSpec, { kind: "job" }>) => isLaunchdJob(spec.unit) ? `launchctl bootout ${spec.unit}` : `systemctl --user stop ${spec.unit}`;
const jobEvidence = (spec: Extract<WaitSpec, { kind: "job" }>) => `Output: ${spec.log}; result: ${spec.result}; stop with: ${stopCommand(spec)}`;

/**
 * Start the command as a systemd service of the user's own, in this
 * directory and environment. It is no part of the session's process tree, so
 * parking, stopping or moving the session leaves it running, and its
 * `ExecStopPost` writes how it ended (also when it was killed) where the
 * server reads it. One argument is a shell command line; several are an argv.
 */
function startJob(argv: string[], name: string | undefined): Extract<WaitSpec, { kind: "job" }> {
  if (argv.length === 0) throw new Error("wait job needs the command to run, after --: agentbox wait job -- 'npx tsx scripts/census.ts --prod > census.log 2>&1'");
  if (process.platform === "darwin") {
    const command = commandLine(argv);
    return startLaunchdJob(argv.length === 1 ? `exec bash -c ${shq(command)}` : `exec ${command}`, name ? `${name}: ${command}` : command);
  }
  if (process.platform !== "linux" || !Bun.which("systemd-run")) throw new Error("wait job runs the command as a systemd user service, which this machine does not have");
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const unit = `agentbox-job-${id}.service`;
  const dir = join(agentboxHome(), "jobs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ender = join(dir, "job-end.sh");
  if (!existsSync(ender)) writeFileSync(ender, `#!/bin/sh\n# What systemd says of a job's end, where the server reads it (src/core/waitreads.ts).\nprintf '%s %s %s\\n' "$SERVICE_RESULT" "$EXIT_CODE" "$EXIT_STATUS" > "$1.tmp" && mv "$1.tmp" "$1"\n`, { mode: 0o755 });
  const log = join(dir, `${id}.log`);
  const result = join(dir, `${id}.result`);
  // The environment holds credentials: the launcher lives on tmpfs, readable by the user alone.
  const runtime = join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`, "agentbox-jobs");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const launcher = join(runtime, `${id}.sh`);
  const command = commandLine(argv);
  const env = Object.entries(process.env)
    .filter(([k, v]) => v !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `export ${k}=${shq(v!)}`)
    .join("\n");
  writeFileSync(launcher, `#!/bin/bash\n${env}\ncd ${shq(process.cwd())} || exit 126\n${argv.length === 1 ? `exec bash -c ${shq(command)}` : `exec ${command}`}\n`, { mode: 0o700 });
  chmodSync(launcher, 0o700);
  const p = Bun.spawnSync(
    [
      "systemd-run", "--user", "--quiet", "--collect", "--service-type=exec", `--unit=${unit}`,
      `--description=agentbox job${name ? ` ${name}` : ""}: ${command.slice(0, 80)}`,
      "--property=KillMode=control-group", "--property=OOMPolicy=kill",
      `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`,
      `--property=ExecStopPost=/bin/sh ${ender} ${result}`,
      "/bin/bash", launcher,
    ],
    { env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}` } },
  );
  if (p.exitCode !== 0) throw new Error(`the job did not start: ${p.stderr.toString().trim() || `systemd-run exited ${p.exitCode}`}`);
  return { kind: "job", unit, command: name ? `${name}: ${command}` : command, log, result };
}

/** `agentbox waits [--session ID | --mine] [--all] [--json]`: what is waited on, and how the rest ended. */
export async function list(api: Api, args: string[]): Promise<number> {
  const { flags } = parseArgs(args, ["session"], ["mine", "all", "json"]);
  const session = str(flags.get("session")) ?? (flags.has("mine") ? process.env.AGENTBOX_SESSION : undefined);
  const q = [session ? `session=${encodeURIComponent(session)}` : "", flags.has("all") ? "all=1" : ""].filter(Boolean).join("&");
  const waits = await api<Wait[]>("GET", `/api/waits${q ? `?${q}` : ""}`);
  if (flags.has("json")) console.log(JSON.stringify(waits, null, 2));
  else if (waits.length === 0) console.error(session ? `${session} is waiting on nothing` : "nothing is waited on");
  else for (const w of waits) console.log(line(w));
  return 0;
}

/** `agentbox unwait <id>...`: its session is not told. A job it started keeps running. */
export async function unwait(api: Api, args: string[]): Promise<number> {
  const { rest } = parseArgs(args, []);
  if (rest.length === 0) throw new Error("unwait needs wait ids (agentbox waits lists them)");
  let failed = 0;
  for (const id of rest) {
    try {
      const w = await api<Wait>("DELETE", `/api/waits/${encodeURIComponent(id)}`);
      console.log(`${id}  cancelled${w.spec.kind === "job" ? `; its job still runs (${stopCommand(w.spec)})` : ""}`);
    } catch (e) {
      failed++;
      console.error(`${id}  unwait failed: ${(e as Error).message}`);
    }
  }
  return failed ? 1 : 0;
}

/** `id  session  state  what · detail`: one line per wait. */
export function line(w: Wait, now = Date.now()): string {
  const state = !w.ended ? "armed" : w.ended === "cancelled" ? "cancelled" : w.toldAt ? `${w.ended}, told` : `${w.ended}, NOT TOLD`;
  const detail = !w.ended
    ? `${w.seen ?? "not looked at yet"}${w.checkedAt ? ` (${span(now - w.checkedAt)} ago)` : ""} · times out in ${span(w.deadline - now)}`
    : `${(w.outcome ?? "").split("\n")[0]!.slice(0, 160)}${w.untold ? ` · ${w.untold}` : ""}`;
  return `${String(w.id).padEnd(4)} ${w.sessionId}  ${state.padEnd(9)} ${describe(w.spec)} · ${detail}`;
}
