/** The Project session: one agent pinned to the top of the board whose job is
 *  the other sessions.
 *
 * It is an ordinary session — same tmux, same transcript, same account pin —
 * that runs in a directory of its own, where a CLAUDE.md / AGENTS.md teaches it
 * the `agentbox` CLI. Which session it is, and on which harness, is kept in the
 * kv table; "clear" starts a fresh one and archives the old, so a clean slate
 * works the same on every provider.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getKv, getSessionRecord, setKv } from "./db";
import { FleetError, type Fleet } from "./fleet";
import { agentboxHome } from "./paths";
import type { ProjectState, ProviderId, Session } from "./types";

const KEY = "project";

/** How each harness compacts its own context; absent means it cannot. */
const COMPACT: Partial<Record<ProviderId, string>> = { claude: "/compact", codex: "/compact", omp: "/compact" };

export function projectDir(): string {
  return join(agentboxHome(), "project");
}

export function projectState(): ProjectState {
  const s = getKv<ProjectState>(KEY);
  const sessionId = s?.sessionId && getSessionRecord(s.sessionId) ? s.sessionId : null;
  return { provider: s?.provider ?? "claude", sessionId, canCompact: !!COMPACT[s?.provider ?? "claude"] };
}

function save(provider: ProviderId, sessionId: string | null): void {
  setKv(KEY, { provider, sessionId });
}

/** Rewritten on every start, so the guide follows the CLI as it changes. */
function writeGuide(): string {
  const dir = projectDir();
  mkdirSync(dir, { recursive: true });
  for (const name of ["CLAUDE.md", "AGENTS.md"]) writeFileSync(join(dir, name), GUIDE);
  return dir;
}

/** Keep the pointer on the conversation when a `/clear` or `/resume` inside
 *  the TUI moves the pane to a new session row. */
export function followProject(fleet: Fleet, onChange: () => void): void {
  fleet.on("paneMoved", (from: string, to: string) => {
    const p = projectState();
    if (p.sessionId !== from) return;
    save(p.provider, to);
    onChange();
  });
}

/** The Project session, running: resumed if stopped, started if there is none
 *  or the harness changed (the old one is archived). */
export async function ensureProject(fleet: Fleet, provider?: ProviderId): Promise<Session> {
  const p = projectState();
  const want = provider ?? p.provider;
  if (p.sessionId && want === p.provider) {
    const s = fleet.get(p.sessionId);
    if (s.host !== "none") return s;
    try {
      return await fleet.resume(p.sessionId);
    } catch {
      // Never got as far as a conversation, or its account is gone: start over.
    }
  }
  return fresh(fleet, want, p.sessionId);
}

/** A clean slate: stop and archive the current one, start a new one. */
export async function clearProject(fleet: Fleet): Promise<Session> {
  const p = projectState();
  return fresh(fleet, p.provider, p.sessionId);
}

export async function compactProject(fleet: Fleet): Promise<void> {
  const p = projectState();
  const cmd = COMPACT[p.provider];
  if (!cmd) throw new FleetError(409, `${p.provider} has no compact command; clear it instead`);
  if (!p.sessionId || fleet.get(p.sessionId).host !== "tmux") throw new FleetError(409, "the Project session is not running");
  await fleet.send(p.sessionId, cmd);
}

async function fresh(fleet: Fleet, provider: ProviderId, old: string | null): Promise<Session> {
  if (old) {
    const s = fleet.get(old);
    if (s.host !== "none") await fleet.stopSession(old);
    await fleet.archive(old, true);
  }
  const { session } = await fleet.spawn({ provider, cwd: writeGuide() });
  save(provider, session.id);
  return fleet.patch(session.id, { label: "Project" });
}

const GUIDE = `# Project

You are the Project session in agentbox: the user's agent for seeing and
managing all of their other coding-agent sessions (Claude Code, Codex, Devin,
omp) across accounts. You do not work on code here; you look at, sort, nudge
and tidy the sessions that do.

Everything goes through the \`agentbox\` CLI. It behaves like a Unix tool: plain
text out, the session id in the first column, and every verb that takes ids
also reads them from stdin with \`-\`, so pipes and xargs work.

## Looking

    agentbox ls                     # one line each: id status idle host provider repo branch title
    agentbox ls --status waiting,blocked --idle '>2h'
    agentbox ls --repo widget --all   # --all includes archived
    agentbox ls --roots             # without the helpers other sessions started
    agentbox ls -q ...              # ids only, for piping
    agentbox ls --json | jq ...     # every field
    agentbox show <id>              # the header: where, model, context, first/last prompt, last reply
    agentbox log <id> | tail -60    # the conversation as text, oldest first
    agentbox log <id> --tools       # with tool calls and their output
    agentbox grep <regex> [-i] [--all]   # search every conversation: id  time  who  line
    agentbox screen <id>            # what its terminal shows right now (tmux sessions)
    agentbox diff <id>              # its worktree's changes
    agentbox usage                  # each account's limits

## Doing

    agentbox send <id> 'text'       # type a message into it (echo ... | agentbox send <id> -)
    agentbox archive <id>...        # off the board; reversible (unarchive), transcript kept
    agentbox unarchive <id>...
    agentbox stop <id>...           # end its process; it stays resumable
    agentbox resume <id>... --detach
    agentbox adopt <id>... --detach # move a session from another terminal into agentbox
    agentbox label <id> 'name'      # rename it on the board
    agentbox claude|codex|omp|devin --detach [--account X] [--model M] 'prompt'   # start one, from the directory it should work in

## Conventions

- Statuses: running (mid-turn), blocked (a prompt needs answering), waiting
  (turn over, the user's move), stopped (no process, resumable), archived.
- Idle is the time since the conversation last moved. Resuming a session
  does not reset it.
- Host: \`box\` runs in agentbox's tmux, so \`screen\` and \`send\` work on it;
  \`ext\` runs in a terminal of the user's, which agentbox can see but not
  read or type into; \`-\` has no process. \`adopt\` moves an \`ext\` session
  into agentbox by restarting it, which closes it in the user's terminal, so
  ask first.
- Repo is the repository, also for a session in a worktree; the branch says
  which worktree (agentbox's own are \`ab/<id>\`).
- Archiving is cheap and reversible. A session that is still running stays
  on the board until it stops; \`stop\` then \`archive\` puts it away now.
- Stopping a running session interrupts its work, and a message sent to one
  lands mid-turn. Ask before stopping or sending to a running session.
- \`ls\` leaves out your own session (labelled "Project"), so piping its
  output into archive or stop cannot take you down.
- A session another one started (a teammate, a \`codex exec\` run from a
  Bash tool) is listed right after its parent with its title indented \`└\`,
  and \`show\` names its parent and children. Every verb acts on exactly the
  ids it is given: archiving or stopping a parent leaves its children alone,
  so list them (\`ls | grep\`, or \`ls --json | jq\` on \`.parent\`) to act on
  them too. What you start with \`agentbox claude|codex --detach\` is
  top-level, never your child.
- Prefer reading \`show\` and the tail of \`log\` over whole transcripts; they
  are long.
`;
