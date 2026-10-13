/** Muse Code: XDG config holds credentials; XDG data holds retained logs.
 * Dedicated accounts force Muse's file credential backend so a login cannot
 * overwrite another account's macOS Keychain item. No credentials are copied.
 */
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Account, ModelOption } from "../types";
import { userHome } from "../paths";
import { carryFlags, setsFlag, type Arity } from "../launch";
import { cliVersion } from "./cli-version";
import { JsonlTranscriptReader } from "./jsonl-reader";
import { museFormat } from "./muse-transcript";
import { cwdOf, environOf, findProcesses, startedAtOf } from "./procs";

/** The paths a process holds open, from /proc (the macOS reader comes with
 *  the macOS port's procs.ts). */
function openFilesOf(pid: number): string[] {
  try {
    return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
      try {
        return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
import { underInput } from "./tui-screen";
import type { Command, LiveProcess, ProviderAdapter, TranscriptRef } from "./types";

type Home = Pick<Account, "home" | "isDefault">;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const configHome = () => process.env.XDG_CONFIG_HOME || join(userHome(), ".config");
export function museDataHome(account: Home): string {
  return account.isDefault ? process.env.XDG_DATA_HOME || join(userHome(), ".local", "share") : join(account.home, "data");
}
const sessionRoot = (account: Home) => join(museDataHome(account), "muse", "sessions");
const canonical = (path: string): string => { try { return realpathSync(path); } catch { return resolve(path); } };

function accountCommand(account: Home): Pick<Command, "env" | "unset"> {
  return {
    env: {
      XDG_CONFIG_HOME: account.home,
      XDG_DATA_HOME: museDataHome(account),
      ...(!account.isDefault ? { XDG_CACHE_HOME: join(account.home, "cache"), TBH_CREDENTIAL_BACKEND: "file" } : {}),
    },
    // A key in the server's shell wins over Muse's stored login. Account
    // placement must never silently run on that key (or another runtime).
    unset: ["META_API_KEY", "MUSE_AUTH_PATH", "MUSE_MODEL", "MUSE_CURRENT_SESSION_LOG", "MUSE_SESSION_ID", "MUSE_CUSTOM_HEADERS", "XDG_RUNTIME_DIR",
      ...(account.isDefault ? ["TBH_CREDENTIAL_BACKEND"] : [])],
  };
}

function dirs(path: string, match: RegExp): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory() && match.test(e.name)).map((e) => e.name); }
  catch { return []; }
}

function refFor(account: Account, path: string): TranscriptRef | null {
  const id = basename(dirname(path));
  if (!UUID.test(id)) return null;
  try {
    const st = statSync(path);
    return st.isFile() ? { provider: "muse", accountId: account.id, agentSessionId: id, path, size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch { return null; }
}

/** Walk only YYYY/MM/DD/<uuid>/session.jsonl, never subagents or tool logs.
 * Old day directories can contain sessions still being appended to. */
function transcripts(account: Account, since: number, id?: string): TranscriptRef[] {
  const root = sessionRoot(account), out: TranscriptRef[] = [];
  for (const y of dirs(root, /^\d{4}$/)) for (const m of dirs(join(root, y), /^\d{2}$/)) for (const d of dirs(join(root, y, m), /^\d{2}$/)) {
    const day = join(root, y, m, d);
    for (const session of id ? [id] : dirs(day, UUID)) {
      const ref = refFor(account, join(day, session, "session.jsonl"));
      if (ref && ref.mtimeMs >= since) out.push(ref);
    }
  }
  return out;
}

/** The launcher execs a versioned native binary (`muse-bin-1.3.0-R…`). */
export function isMuseArgv(argv: string[]): boolean {
  const name = basename(argv[0] ?? "");
  return name === "muse" || /^muse-bin-\d/.test(name);
}
const NON_SESSION = new Set(["config", "export", "trace", "skills", "plugins", "sandbox", "schema", "session-message", "mcp", "auth", "login", "logout", "init", "help"]);
function isSession(argv: string[]): boolean {
  return isMuseArgv(argv) && !NON_SESSION.has(argv[1] ?? "") && !argv.slice(1).some((v) => ["--help", "-h", "--version", "-V"].includes(v));
}

const CARRIED: Record<string, Arity> = {
  "--provider": "one", "--preset": "one", "--model": "one", "--reasoning-effort": "one", "--base-url": "one",
  "--agents": "one", "--parallel-tool-calls": "none", "--no-parallel-tool-calls": "none",
  "--subagent-worktree-isolation": "none", "--approval-mode": "one", "--permission-profile": "one", "--approval-judge": "one",
  "--yolo": "none", "--trust-workspace": "none", "--disable-approval": "none", "--disable-sandbox": "none",
  "--sandbox-network": "one", "--disable-write": "none", "--disable-shell": "none", "--enable-shell-tool": "none",
};
function flags(opts: { cwd: string; model?: string; effort?: string; autoApprove: boolean; carry?: string[] }): string[] {
  const a = [...(opts.carry ?? []), "--workspace", opts.cwd];
  if (opts.model && !setsFlag(a, "--model")) a.push("--model", opts.model);
  if (opts.effort && !setsFlag(a, "--reasoning-effort")) a.push("--reasoning-effort", opts.effort);
  if (!opts.carry) a.push(opts.autoApprove ? "--yolo" : "--trust-workspace");
  return a;
}

/** The CLI's own account-local catalog; no network calls or invented models. */
export function museModels(account: Home): ModelOption[] {
  const dir = join(museDataHome(account), "muse", "model-catalog");
  const out = new Map<string, ModelOption>();
  try {
    for (const file of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      try {
        const catalog = JSON.parse(readFileSync(join(dir, file), "utf8"));
        for (const row of Array.isArray(catalog.rows) ? catalog.rows : []) {
          if (typeof row.model_id !== "string" || row.visibility !== "visible") continue;
          const efforts = Array.isArray(row.reasoning_effort_variants) ? row.reasoning_effort_variants.map((e: any) => e.tier).filter((v: unknown) => typeof v === "string") : [];
          out.set(row.model_id, { id: row.model_id, label: row.display_label || row.model_id,
            releasedAt: typeof row.release_date === "string" ? row.release_date : null,
            ...(efforts.length ? { efforts } : {}), ...(row.is_default ? { note: "default" } : {}),
          });
        }
      } catch { /* another profile's catalog may be refreshing */ }
    }
  } catch { /* populated after Muse first contacts the provider */ }
  return [...out.values()];
}

export const museAdapter: ProviderAdapter = {
  id: "muse", label: "Muse Code",
  efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  detect: () => cliVersion(["muse", "--version"]),
  defaultHome: configHome,
  accountCommand, authEnv: accountCommand,
  async listTranscripts(account, sinceMs) { return transcripts(account, sinceMs); },
  async findTranscript(account, id) { return UUID.test(id) ? transcripts(account, 0, id)[0] ?? null : null; },
  reader: (ref) => new JsonlTranscriptReader(ref, museFormat(ref)),
  subagentLogDir: (ref) => join(dirname(ref.path), "subagent"),
  async liveProcesses(accounts) {
    const out: LiveProcess[] = [];
    for (const proc of findProcesses(isSession)) {
      const env = environOf(proc.pid);
      const cwd = cwdOf(proc.pid), startedAt = startedAtOf(proc.pid);
      if (!cwd || startedAt === null) continue;
      const cfg = env?.get("XDG_CONFIG_HOME") || join(env?.get("HOME") || userHome(), ".config");
      const account = env ? accounts.find((a) => a.provider === "muse" && canonical(a.home) === canonical(cfg)) : undefined;
      let id: string | null = null;
      if (account) {
        const root = canonical(sessionRoot(account)) + sep;
        // Muse closes the JSONL between writes, but holds .session.lock for
        // the session's lifetime. It can hold two descriptors to that lock.
        const locked = [...new Set(openFilesOf(proc.pid).filter((path) => path.startsWith(root) && /^\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]+\/\.session\.lock$/i.test(path.slice(root.length))))];
        // One MSP host can have several sessions; it must not be adopted as
        // if it were one interactive TUI. The CLI's exec is headless too.
        if (locked.length === 1) id = basename(dirname(locked[0]!));
        if (!id && proc.argv[1] === "resume" && UUID.test(proc.argv[2] ?? "")) id = proc.argv[2]!;
      }
      out.push({ pid: proc.pid, accountId: account?.id ?? null, agentSessionId: id, cwd, startedAt });
    }
    return out;
  },
  spawnCommand(opts) {
    return { argv: ["muse", ...flags(opts), ...(opts.prompt ? ["--", opts.prompt] : [])], ...accountCommand(opts.account), agentSessionId: null };
  },
  resumeCommand(opts) { return { argv: ["muse", "resume", opts.agentSessionId, ...flags(opts)], ...accountCommand(opts.account) }; },
  resumePromptInTerminal: true,
  carryOver: (argv) => carryFlags(argv, CARRIED),
  headless: (argv) => argv[1] === "exec" || argv[1] === "serve",
  blockedOn(screen) {
    const s = underInput(screen, (lines, i) => /^\s*❯/.test(lines[i]!) && i > 0 && /^\s*─{3,}/.test(lines[i - 1]!));
    if (/Allow once/i.test(s) && /Reject/.test(s)) return "permission";
    if (/Sign in/i.test(s) && /API key/i.test(s)) return "login";
    return null;
  },
};
