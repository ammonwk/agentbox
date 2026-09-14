/** The omp subagent MCP server: `Agent` and `SendMessage`, backed by omp.
 *
 * This is a different product from `src/mcp/index.ts`. That one hands a
 * conductor the agentbox *board* — sessions with worktrees, branches, PRs and a
 * human watching. This one hands any MCP client a *subagent*: something it
 * calls like a function, in its own working directory, and blocks on until an
 * answer comes back. Nothing here touches the board, the database or the
 * agentbox server, and the agentbox server does not need to be running.
 *
 * The tool descriptions are the whole interface. A calling model has no other
 * documentation, so they say when to reach for a subagent and what a good task
 * looks like — a delegation that comes back useless is worse than no
 * delegation, because the caller paid for it and cannot see why.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION } from "../version";
import {
  SubagentPool,
  ago,
  pruneTranscripts,
  waitForTurn,
  type ConversationTurn,
  type Subagent,
  type TurnReport,
} from "../core/subagents";
import { describePlace, renderPlace } from "../core/place";
import { budget, healthWord, renderBudget, verdict, type Verdict } from "../core/health";
import * as live from "../core/live";
import {
  runWorkflow,
  parseJsonArgs,
  DEFAULT_CONCURRENCY,
  HEARTBEAT_MS,
  MAX_AGENTS,
  type Progress,
} from "../core/workflow";

/**
 * Block until the agent is done. There is no way to ask for less.
 *
 * This used to be a default with a `timeout_seconds` beside it, including a 0
 * that returned a receipt and left the agent running. That parameter is gone,
 * because every value it could take was worse than blocking — and the reason
 * is worth writing down, since it is a fact about the client and not about us.
 *
 * Claude Code races each MCP tool call against a 120-second timer
 * (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`). If the call settles first it is
 * returned inline and nothing else happens. If the timer wins, the call is
 * registered as a background task, the model is told so and carries on, and
 * when the call finally resolves its result is delivered as a task
 * notification at `priority: "next"` — the same channel background shell
 * commands and native subagents use. The task outlives the turn and dies with
 * the session.
 *
 * All of that is keyed on one thing: the request still being open. A call that
 * answers early has hung up. Returning a handle after 200ms does not start a
 * background task, it prevents one — the work goes on inside this process with
 * no way left to reach the caller, and the caller has to remember to come back
 * for an answer nothing will remind it about. That mistake cost five hours
 * once. So: block, and let the client do the thing it is already good at.
 *
 * Two client limits bound the block. The per-call hard timeout
 * (`MCP_TOOL_TIMEOUT`) defaults to about 28 hours, comfortably past this. The
 * idle timeout for a stdio server is 30 minutes — but it is reset by progress
 * notifications, which is why the heartbeat in `watch` is load-bearing rather
 * than decorative: a quiet agent with no progress being published would have
 * its call killed at the half hour.
 */
const DEFAULT_TIMEOUT_S = 3600;

/**
 * Where this server runs, resolved once at startup.
 *
 * It is the default working directory for every agent, it is fixed for the
 * life of the process, and until now the only place it appeared was a line on
 * stderr that no model ever reads. A caller working in a worktree therefore
 * had no way to discover that its agents were not. Naming it in the tool
 * descriptions costs two `git` calls at boot and closes that gap for good.
 */
const HERE = describePlace(process.cwd());

/**
 * How long `collect` waits before answering with progress instead.
 *
 * Deliberately not the hour above. `agent` blocks that long because one call
 * and one answer is what makes a delegation feel native. `collect` is the
 * opposite kind of call: it is reached for when the caller is *unsure*, and
 * inheriting the hour makes every check-in a second hour-long background task.
 * The caller, still unsure, checks again — and the tasks accumulate, each one
 * a completion notification that lands whenever it lands. A caller trying to
 * find out whether anything is happening should not have to wait an hour to be
 * told.
 *
 * A minute is long enough that a nearly-finished turn is simply handed over,
 * and short enough that a check-in stays a check-in: it comes back promptly
 * with the partial prose and a tool count, which is what was actually being
 * asked for.
 */
const COLLECT_TIMEOUT_S = 60;

const pool = new SubagentPool(process.cwd());

// One sweep at startup. Transcripts are per-spawn and nothing else removes
// them; a client that starts this server every session is exactly the thing
// that would otherwise grow the directory without bound.
const pruned = pruneTranscripts();
// Lines from a previous server that was killed rather than closed. Readers
// already ignore them by age; this stops them accumulating one per workflow.
live.prune();

/**
 * A standing reminder of answers nobody has picked up.
 *
 * Appended to every result this server returns, which is the point: it costs
 * nothing when the mailbox is empty, and when it is not it reaches the caller
 * on whatever call it happens to make next, rather than waiting to be asked.
 * Nothing else can reach a caller that has stopped waiting — there is no push
 * on this protocol, only answers to questions — so the next question is the
 * channel.
 *
 * It carries the beginning of the answer, not just its existence. An announced
 * report still has to be fetched; a quoted one is often already enough, and
 * the caller can decide whether the rest is worth a call.
 */
function mailboxNotice(): string {
  const waiting = pool.list().filter((a) => a.uncollected > 0);
  if (waiting.length === 0) return "";
  const lines = [
    ``,
    `---`,
    `⚠ Uncollected: ${waiting.length} agent${waiting.length === 1 ? " has" : "s have"} ` +
      `finished turns nobody has read. You paid for these.`,
  ];
  for (const a of waiting) {
    const when = a.answeredAt ? ago(Date.now() - a.answeredAt) : "just now";
    lines.push(
      `- "${a.name}" — ${a.uncollected} turn${a.uncollected === 1 ? "" : "s"}, last one ` +
        `${when} (${renderPlace(a.place)})`,
    );
  }
  const first = waiting[0]!;
  const held = first.peek();
  if (held && held.report) {
    const body = held.report.length > 800 ? `${held.report.slice(0, 800)}…` : held.report;
    lines.push(
      ``,
      `The start of what "${first.name}" said (turn ${held.turn}; \`collect\` for all of it):`,
      ``,
      body,
    );
  }
  return lines.join("\n");
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: `${body}${mailboxNotice()}` }] };
}

/** Ids for the live files. Only has to be unique among this process's own
 *  in-flight calls, and readable in a directory listing while debugging. */
let calls = 0;
/** Every id this process has published and not yet retracted, so a shutdown
 *  can take its lines with it rather than leaving ghosts to time out. */
const publishing = new Set<string>();

/**
 * Say what a long call is doing, to everyone who might be looking.
 *
 * Two audiences, and neither is enough alone. MCP's `notifications/progress`
 * reaches the caller's client, which is the right place — it resets the
 * client's idle-call watchdog, so an hour-long fan-out is not mistaken for a
 * hung server, and its `message` is what the client shows while the call is in
 * flight. But a client shows it only while the call is in the foreground, and
 * a client that backgrounds a slow call stops looking at exactly the point the
 * work becomes worth watching.
 *
 * So the same line also goes to a file, where a status line or a second
 * terminal can find it for as long as the call is running, however bored the
 * client got. See `core/live`.
 *
 * The notification half is skipped when the client did not ask for progress —
 * sending it unrequested is a protocol violation.
 *
 * The file half is now opt-in, and only the workflow asks for it. A single
 * agent's status line is published by the pool instead, for as long as the
 * *agent* lives rather than as long as the call does — the two used to be the
 * same thing and are not, since an agent whose caller stopped waiting is
 * exactly the one worth watching. A workflow keeps its own line because what
 * it has to say is about the fan-out, not about any one agent.
 */
function publisher(
  label: string,
  file: boolean,
  extra: {
    _meta?: { progressToken?: string | number };
    sendNotification: (n: {
      method: "notifications/progress";
      params: {
        progressToken: string | number;
        progress: number;
        total?: number;
        message?: string;
      };
    }) => Promise<void>;
  },
) {
  const progressToken = extra._meta?.progressToken;
  const id = `${process.pid}-${++calls}`;
  const cwd = process.cwd();
  const send = (message: string, progress: number, total?: number) => {
    if (file) {
      publishing.add(id);
      live.publish(id, cwd, `${label} ${message}`);
    }
    if (progressToken === undefined) return;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, message, ...(total === undefined ? {} : { total }) },
      })
      .catch(() => {
        // The client may be gone; the work must keep running regardless.
      });
  };
  return {
    send,
    done: () => {
      publishing.delete(id);
      live.retract(id);
    },
  };
}

/**
 * Narrate one agent's turn for as long as a call is blocked on it.
 *
 * `agent` and `send_message` block for up to an hour on a single omp process
 * and, until now, said nothing at all in the meantime — so a client showed a
 * spinner and a tool name, and a watcher could not tell a subagent reading
 * its way through a repository from one that died three minutes in. The
 * agent already knows what it last did and when; this just says so, on a
 * clock, and stops when the caller stops waiting.
 */
function watch(agent: Subagent, send: (m: string, p: number, t?: number) => void) {
  let frame = 0;
  const tick = () => {
    const a = agent.activity();
    // How long the action has been the current one — which is how long a
    // tool has been running, or how long the agent has been thinking since
    // the last one ended. Suppressed while it is small, where it is noise.
    const since = a.idleMs >= 5000 ? ` ${Math.round(a.idleMs / 1000)}s` : "";
    const action = a.action.length > 40 ? `${a.action.slice(0, 39)}…` : a.action;
    send(
      `${agent.name} ${Math.round(a.turnMs / 1000)}s · ${a.toolCalls} tool call` +
        `${a.toolCalls === 1 ? "" : "s"} → ${action}${since}`,
      ++frame,
    );
  };
  tick();
  const timer = setInterval(tick, HEARTBEAT_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

/**
 * Where each message to an agent stands, one line apiece.
 *
 * "Did my follow-up land" has three honest answers — waiting behind another
 * turn, running, answered — and a caller that cannot tell them apart resends,
 * which pays for the same work twice. `handed back` is the most this side can
 * know: it says the answer left here, not that it reached the caller's context,
 * which is why the line for it points at re-reading.
 */
function renderConversation(turns: ConversationTurn[], now = Date.now()): string[] {
  return turns.map((t) => {
    const oneLine = t.message.replace(/\s+/g, " ").trim();
    const preview = oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine;
    let status: string;
    if (t.status === "queued") {
      status = `queued behind turn ${t.turn - 1}, sent ${ago(now - t.sentAt)}`;
    } else if (t.status === "running") {
      status = `running, sent ${ago(now - t.sentAt)}`;
    } else {
      status =
        `answered ${t.answeredAt === null ? "" : ago(now - t.answeredAt)}` +
        (t.handedBackAt === null ? ", UNCOLLECTED" : ", handed back") +
        (t.toolCalls === null ? "" : `, ${t.toolCalls} tool call${t.toolCalls === 1 ? "" : "s"}`) +
        (t.stopReason === null || t.stopReason === "end_turn" ? "" : `, ended ${t.stopReason}`);
    }
    return `  turn ${t.turn} ${status}: "${preview}"`;
  });
}

function tokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k ctx` : `${n} ctx`;
}

/**
 * Render a finished turn.
 *
 * The report leads, unadorned, because it is the answer and everything else is
 * bookkeeping. The status line exists so a caller can tell a real investigation
 * from a model that answered from thin air without reading anything — an agent
 * that made zero tool calls and produced a confident report is the single most
 * useful thing to be able to notice here.
 */
function renderTurn(r: TurnReport): string {
  const parts: string[] = [];
  // Ahead of the answer, deliberately. An agent that wrote outside its working
  // directory has produced a report about work that is not where its caller
  // believes it is, and every sentence below is worth less until that has been
  // checked. Putting it under the report would be putting it where a satisfied
  // reader has already stopped.
  if (r.wroteOutside.length > 0) {
    const n = r.wroteOutside.length;
    parts.push(
      `⚠ WRONG TREE? This agent's writing tool calls touched ${n} path` +
        `${n === 1 ? "" : "s"} outside its working directory (${r.cwd}):\n` +
        r.wroteOutside.map((path) => `  ${path}`).join("\n") +
        `\nCheck those before you act on anything below.\n`,
    );
  }
  parts.push(r.report || "[the agent finished its turn without saying anything]");

  const ctx =
    r.contextTokens === null
      ? []
      : [
          r.contextSize === null || r.contextSize <= 0
            ? tokens(r.contextTokens)
            : `${tokens(r.contextTokens)} of ${Math.round(r.contextSize / 1000)}k ` +
              `(${Math.round((r.contextTokens / r.contextSize) * 100)}%)`,
        ];
  const stats = [
    r.name,
    renderPlace(describePlace(r.cwd)),
    `turn ${r.turn}`,
    r.state,
    `${r.toolCalls} tool call${r.toolCalls === 1 ? "" : "s"}`,
    `${Math.round(r.durationMs / 1000)}s`,
    // Cost and context are omitted when omp never reported them. A column of
    // em-dashes in every report teaches the reader to skip the whole line,
    // which is the line that says whether the agent did any work at all.
    ...(r.costUsd === null ? [] : [`$${r.costUsd.toFixed(4)} total`]),
    ...ctx,
  ].join(" · ");
  parts.push(`\n---\n${stats}`);

  if (r.stopReason === "deadline") {
    parts.push(
      `This turn hit its wall clock and was interrupted, so the report above is a ` +
        `partial. The agent kept its context: look at \`transcript\` to see where it ` +
        `went, then \`send_message\` it a narrower task rather than restarting.`,
    );
  } else if (r.stopReason !== "end_turn") {
    parts.push(
      `Turn ended with \`${r.stopReason}\`, not a normal finish — the report above may be ` +
        `cut off mid-thought. Treat it as partial.`,
    );
  }
  if (r.errors.length > 0) parts.push(`Errors during the turn:\n- ${r.errors.join("\n- ")}`);
  if (r.state === "dead") {
    parts.push(`This agent is gone and cannot be messaged again. Start a fresh one if you need more.`);
  } else {
    parts.push(`Follow up with \`send_message\` to "${r.name}"; \`stop_agent\` when you are done with it.`);
  }
  return parts.join("\n");
}

/**
 * Render a wait that ended without a turn.
 *
 * Two cases and one shape. The ordinary one is a call that ran out of clock
 * while the agent worked, which is not a failure and must not read as one. The
 * other is a wait broken early because the agent stopped making progress, and
 * that one leads with what is wrong -- the reason the wait was broken at all
 * is to put a sentence the caller can act on in front of it.
 *
 * Both end in the same place: the answer is still coming and is held for you.
 */
function renderWaiting(agent: Subagent, v: Verdict, alsoWaiting = 0): string {
  const s = agent.summary();
  const snap = agent.snapshot();
  const out: string[] = [];

  if (v.escalate && v.note !== null) {
    out.push(
      `"${s.name}" is still running, but it does not look like it is getting anywhere:`,
      ``,
      `  ${v.concern}: ${v.note}`,
      ``,
      `This wait was ended early to tell you. Nothing was lost -- the agent is still going ` +
        `and its answer will be held for you either way.`,
    );
  } else {
    out.push(`"${s.name}" is still working -- this is not a failure and nothing was lost.`);
  }

  out.push(
    ``,
    `Working in ${renderPlace(agent.place)}.`,
    `${renderBudget(budget(snap))} - ${snap.turnToolCalls} tool call` +
      `${snap.turnToolCalls === 1 ? "" : "s"} this turn - now: ${snap.lastAction || "starting"}`,
  );

  // Everything else worth knowing, once the headline is out of the way. A
  // caller deciding whether to interrupt wants the whole picture, not just the
  // worst part of it.
  const rest = v.findings.filter((f) => f.concern !== v.concern);
  if (rest.length > 0) {
    out.push(``, `Also:`, ...rest.map((f) => `  ${f.concern}: ${f.note}`));
  }

  // What it has said so far. `transcript` shows the tool calls, but prose is
  // where the agent says what it is concluding -- and a half-written report is
  // usually enough to tell "on the right track" from "answering the wrong
  // question", which is the decision the caller is actually facing here.
  const partial = agent.partial();
  if (partial) out.push(``, `What it has said so far:`, ``, partial);

  out.push(
    ``,
    v.escalate
      ? `\`interrupt\` it and \`send_message\` a correction if you agree it is stuck; ` +
        `\`transcript\` shows the calls behind this; \`collect\` picks up the answer if you ` +
        `would rather let it finish.`
      : `Call \`collect\` with name "${s.name}" to keep waiting; its answer is held for you ` +
        `whether or not anyone is waiting when the turn ends. \`transcript\` shows the tool ` +
        `calls behind the prose, and \`interrupt\` stops the turn if it is going nowhere.`,
  );

  // A caller cannot see its own backlog: every one of these calls looks the
  // same from the outside, and only one of them will be handed the turn.
  if (alsoWaiting > 0) {
    out.push(
      ``,
      `Note: ${alsoWaiting} other \`collect\` call${alsoWaiting === 1 ? "" : "s"} on ` +
        `"${s.name}" ${alsoWaiting === 1 ? "is" : "are"} still blocked right now, probably ` +
        `yours. The turn goes to exactly one of them, so the rest will come back like this ` +
        `one having learned nothing. Stop collecting and do other work -- the answer is kept ` +
        `for you and one call is enough to get it.`,
    );
  }
  return out.join("\n");
}

const server = new McpServer({ name: "omp", version: VERSION });

/** The wall clock a caller may set on one turn, in hours. */
const turnHoursArg = z
  .number()
  .min(0.1)
  .max(12)
  .optional()
  .describe(
    "Hours a single turn may run before it is interrupted and its partial report handed " +
      "back. Defaults to 4, which is far past any turn that is going well. Raise it only " +
      "for a job you know is long, and lower it when you would rather find out early.",
  );

const cwdArg = z
  .string()
  .optional()
  .describe(
    `Absolute path the agent works in. Defaults to ${HERE.path}` +
      `${HERE.branch === null ? "" : ` (branch ${HERE.branch})`} — this server's own ` +
      `working directory, fixed when your client started it and never updated since. ` +
      `If you are working anywhere else — a git worktree, a sibling checkout, a repo you ` +
      `cd'd into — you MUST pass it, or the agent will edit the wrong tree and report ` +
      `success for it.`,
  );

server.registerTool(
  "agent",
  {
    title: "Delegate a task to an omp subagent",
    description:
      `Runs an omp agent on \`prompt\` and blocks until it answers. Unless you pass ` +
      `\`cwd\`, it runs in ${renderPlace(HERE)} — see \`cwd\` below, and check it against ` +
      `where you are actually working before you delegate anything that writes. The agent ` +
      "sees that repository exactly as you would, uncommitted changes included: this is not " +
      "a worktree and its edits are real.\n\n" +
      "Delegate when the work is wide but the answer is narrow: sweeping many files for a " +
      "conclusion you need, running down a lead you would rather not read the output of, " +
      "grinding a mechanical change. The agent's tool output never enters your context — only " +
      "its final report does — so the wider the search, the more you save. Do not delegate a " +
      "single lookup you could do in one call; you would pay a whole agent for it.\n\n" +
      "The prompt is the entire brief. The agent cannot ask you anything, so anything you " +
      "leave out it will invent:\n" +
      "  • state the deliverable — what you want back, in what form;\n" +
      "  • name where to look, when you know: files, directories, symbols;\n" +
      "  • give the acceptance test — the command that must pass, the behaviour that must " +
      "change. Without one it decides for itself when it is done;\n" +
      "  • say what is out of scope, or it will tidy adjacent code.\n\n" +
      "Bad: \"look at the auth code\". Good: \"Find every caller of refreshToken() under src/ " +
      "and report, as a list of path:line, which ones handle a null return. Read only — change " +
      "nothing.\"\n\n" +
      "Run several at once by calling this tool several times in one message when the tasks " +
      "are independent. Each one notifies you separately when it lands, so there is nothing " +
      "to coordinate. They do share one working tree, though, so fan out writers only when " +
      "their files cannot collide; parallel readers are always safe (set `read_only` and it " +
      "is guaranteed). To hand an agent context too big for the prompt, write it to a file " +
      "and name the path.\n\n" +
      "Just call it and let it finish. After about two minutes your client moves the call to " +
      "the background, tells you it has, and delivers the answer to you as a notification " +
      "whenever it lands — you keep working in the meantime.\n\n" +
      "You do not have to wonder how it is going. `list_agents` is one small result and no " +
      "waiting, and once the call is backgrounded you are free to make it. This call also " +
      "watches on your behalf: if the agent starts repeating itself or goes quiet, the wait " +
      "ends early and says so, rather than spending the rest of the clock on it.",
    inputSchema: {
      prompt: z.string().min(1).describe("The full brief, written per this description."),
      name: z
        .string()
        .optional()
        .describe(
          "Handle you will address it by later. Name it after its job (`test-sweep`, " +
            "`migrate-imports`) — you will be reading these back in a list. Generated if omitted.",
        ),
      role: z
        .string()
        .optional()
        .describe(
          "Standing instructions appended to the agent's system prompt, in force for every " +
            "turn — the durable half of who this agent is, as against the task. Use it for " +
            "constraints that must not decay over a long conversation. For read-only, prefer " +
            "the `read_only` flag, which is enforced rather than requested.",
        ),
      read_only: z
        .boolean()
        .optional()
        .describe(
          "Hard-enforce read-only: the harness denies every tool call that edits, moves, " +
            "deletes or executes — including shell — so the agent cannot touch your tree no " +
            "matter what its model decides. The agent is told, and each denial appears in its " +
            "report's errors. Set it on any agent that only needs to look: audits, searches, " +
            "reviews, fan-outs. Defaults to FALSE here, because a single deliberate delegation " +
            "is often meant to change something; inside a `workflow` it defaults to true.",
        ),
      cwd: cwdArg,
      allow_outside_cwd: z
        .boolean()
        .optional()
        .describe(
          "Permit a prompt that names files in a different git work tree. Without this, such " +
            "a spawn is refused — a brief written about one checkout and run against another " +
            "edits real files and reports success, which is the most expensive mistake this " +
            "tool can make. Set it only when the task genuinely spans repositories, never to " +
            "get past a refusal that is telling the truth.",
        ),
      max_turn_hours: turnHoursArg,
    },
  },
  async ({ prompt, name, role, cwd, read_only, allow_outside_cwd, max_turn_hours }, extra) => {
    const agent = await pool.spawn({
      prompt,
      name,
      role,
      cwd,
      readOnly: read_only,
      allowOutsideCwd: allow_outside_cwd,
      maxTurnMs: max_turn_hours === undefined ? undefined : max_turn_hours * 3_600_000,
    });
    const out = publisher("agent", false, extra);
    const stop = watch(agent, out.send);
    try {
      // The spawn's own prompt is turn 1; wait for that answer specifically.
      const r = await waitForTurn(agent, 1, DEFAULT_TIMEOUT_S * 1000, { signal: extra.signal });
      return text("stuck" in r ? renderWaiting(agent, r.stuck) : renderTurn(r));
    } finally {
      stop();
      out.done();
    }
  },
);

server.registerTool(
  "send_message",
  {
    title: "Continue a subagent, with its context intact",
    description:
      "Sends another message to an agent you already started and blocks for its reply. It " +
      "keeps everything it learned, which is the entire reason to reuse one instead of " +
      "starting a fresh agent that must re-read the same files.\n\n" +
      "This is the follow-up channel: correct a report that missed the point, ask the obvious " +
      "next question, hand it the second half of the job. Be specific about what was wrong — " +
      "quote the line of its report you are disputing. \"That's not right\" gets you the same " +
      "answer again.\n\n" +
      "Like `agent`, it blocks for the reply and you do not need to manage that: a long one " +
      "is backgrounded by your client after about two minutes and delivered to you as a " +
      "notification, and the wait ends early if the agent stops making progress.\n\n" +
      "It keeps working wherever the agent already was; you cannot move an agent between " +
      "directories, so start a new one if the next job is in a different tree.\n\n" +
      "If it is mid-turn the message is queued and delivered when that turn ends; `interrupt` " +
      "first if you need it to stop now.\n\n" +
      "If this call errors or its result goes missing, do NOT resend — that pays for the " +
      "same work twice. `list_agents` shows every message and whether it is queued, running " +
      "or answered, and `collect` with its `turn` number returns the answer, even one that " +
      "was already handed back.",
    inputSchema: {
      to: z.string().describe("The agent's name, as `agent` or `list_agents` reported it."),
      message: z.string().min(1),
      max_turn_hours: turnHoursArg,
    },
  },
  async ({ to, message, max_turn_hours }, extra) => {
    const agent = pool.get(to);
    if (max_turn_hours !== undefined) agent.maxTurnMs = max_turn_hours * 3_600_000;
    // Wait for the answer to *this* message. An older uncollected report is
    // somebody else's mail and would otherwise be handed back as the reply.
    const turn = agent.send(message);
    const out = publisher("agent", false, extra);
    const stop = watch(agent, out.send);
    try {
      const r = await waitForTurn(agent, turn, DEFAULT_TIMEOUT_S * 1000, { signal: extra.signal });
      return text("stuck" in r ? renderWaiting(agent, r.stuck) : renderTurn(r));
    } finally {
      stop();
      out.done();
    }
  },
);

server.registerTool(
  "collect",
  {
    title: "Pick up an answer you stopped waiting for",
    description:
      "Picks up a finished answer, or tells you how the agent is getting on. Unlike `agent` " +
      "and `send_message` this does NOT block for long: it waits about " +
      `${COLLECT_TIMEOUT_S} seconds and then comes back with the agent's progress so far.\n\n` +
      "You need it only when something went sideways — a client that dropped the call, an " +
      "agent you interrupted, a turn that hit its wall clock. In the ordinary flow the answer " +
      "is delivered to you and this tool never comes up.\n\n" +
      "A finished turn is held for you whether or not anyone was waiting, so an answer is " +
      "never lost by timing out — call this and you get it, however long ago it landed. **One " +
      "call is enough.** A turn is handed to exactly one waiting caller, so collecting the " +
      "same agent again while the first call is outstanding wins you nothing: the extra calls " +
      "come back with progress and no answer. If it is still working, go and do something " +
      "else rather than collecting in a loop.\n\n" +
      "Answers come back oldest first, and each is stamped with the turn it answers — turn 1 " +
      "is the task you spawned it with, turn 2 the first `send_message`, and so on. If you " +
      "fired off several messages, match them up by that number rather than assuming the next " +
      "report is the one you are thinking of.\n\n" +
      "Pass `turn` to ask for one answer by number. That also works for an answer already " +
      "handed back — the way to recover a result that went missing on your side.",
    inputSchema: {
      name: z.string(),
      turn: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Which answer: 1 is the spawning task, 2 the first `send_message`, and so on. Returns " +
            "it even if it was handed back before; waits for it if it is still coming.",
        ),
      timeout_seconds: z
        .number()
        .int()
        .min(0)
        .max(3600)
        .optional()
        .describe(
          `Seconds to wait for an answer before returning progress instead. Default ` +
            `${COLLECT_TIMEOUT_S}, kept short on purpose so a check-in stays a check-in. ` +
            `Raise it only when you have nothing else to do and mean to block; 0 reports the ` +
            `agent's state without waiting at all.`,
        ),
    },
  },
  async ({ name, turn, timeout_seconds }, extra) => {
    const agent = pool.get(name);
    if (turn !== undefined) {
      const status = agent.conversation().find((t) => t.turn === turn)?.status;
      const kept = agent.reread(turn);
      const handed = agent.handedBackAt(turn);
      // Already handed back: repeat it. Still in the mailbox falls through to
      // `settle` below, which takes it the ordinary way.
      if (kept && handed !== null) {
        return text(
          `Turn ${turn} of "${name}" was already handed back ${ago(Date.now() - handed)}; ` +
            `repeating it.\n\n${renderTurn(kept)}`,
        );
      }
      if (!kept && (status === undefined || status === "answered")) {
        const sent = agent.conversation().at(-1)?.turn ?? 0;
        return text(
          turn > sent
            ? `"${name}" has no turn ${turn} — it has been sent ${sent} message` +
                `${sent === 1 ? "" : "s"}.`
            : `Turn ${turn} of "${name}" is older than the answers kept in memory. The full ` +
                `text is in ${agent.dir}/transcript.jsonl.`,
        );
      }
    }
    const out = publisher("agent", false, extra);
    const stop = watch(agent, out.send);
    let r: TurnReport | null;
    try {
      r = await agent.settle((timeout_seconds ?? COLLECT_TIMEOUT_S) * 1000, turn, extra.signal);
    } finally {
      stop();
      out.done();
    }
    if (r) return text(renderTurn(r));
    if (agent.state === "dead") {
      return text(
        `"${name}" is dead — its process is gone and there is nothing left to collect. ` +
          `Start a fresh agent if you still need the work done.`,
      );
    }
    if (agent.state === "idle") {
      // Nothing new, but "you already have it" is exactly what a caller whose
      // result went missing cannot act on. Repeat the last answer instead.
      const last = agent.reread();
      const handed = last === null ? null : agent.handedBackAt(last.turn);
      if (last !== null && handed !== null) {
        return text(
          `"${name}" is idle with nothing new. Its last answer, turn ${last.turn}, was handed ` +
            `back ${ago(Date.now() - handed)}; repeating it in case it never reached you.\n\n` +
            renderTurn(last),
        );
      }
      return text(`"${name}" is idle and owes you nothing. Send it a message to give it more work.`);
    }
    // Read after settling, not before: our own waiter has been dropped by
    // then, so this counts the callers genuinely still queued behind us.
    return text(renderWaiting(agent, verdict(agent.snapshot()), agent.queuedCollectors));
  },
);

server.registerTool(
  "list_agents",
  {
    title: "How every subagent is getting on",
    description:
      "One cheap call that answers \"is anything wrong\". For each agent: where it is running, " +
      "what it is doing right now, what it has spent, and a plain-language verdict when " +
      "something looks off -- repeating itself, gone quiet, running out of context or clock, " +
      "or answering without having read anything.\n\n" +
      "Checking is cheap and you are welcome to do it. Once a blocked `agent` call has been " +
      "in flight about two minutes your client backgrounds it and hands you back the floor, " +
      "so calling this while agents run costs you one small result and no waiting. It is the " +
      "right thing to reach for when a fan-out has been going a while and you want to know " +
      "whether to let it run.\n\n" +
      "Budgets rather than progress bars, deliberately: there is no honest estimate of how " +
      "much of a task is left, but context, clock and money are real ceilings, and " +
      "consumption against them is what decides let-it-run from kill-it. `uncollected` above " +
      "zero means an agent finished a turn you never picked up.\n\n" +
      "Each agent also lists its unanswered messages and its latest answer, by turn number: " +
      "queued, running, or answered. That is how you tell whether a `send_message` whose " +
      "result you never saw actually landed.",
    inputSchema: {},
  },
  async () => {
    const agents = pool.list();
    if (agents.length === 0) return text("No subagents running.");
    const now = Date.now();
    const blocks = agents.map((a) => {
      const snap = a.snapshot(now);
      const v = verdict(snap, now);
      const head =
        `${snap.name}  ${renderPlace(a.place)}  [${healthWord(v, snap).toUpperCase()}]` +
        (snap.readOnly ? "  read-only" : "") +
        (snap.uncollected > 0 ? `  ${snap.uncollected} UNCOLLECTED` : "");
      const lines = [head];
      if (snap.state === "running") {
        lines.push(
          `  ${renderBudget(budget(snap, now))} - ${snap.turnToolCalls} tool call` +
            `${snap.turnToolCalls === 1 ? "" : "s"} this turn`,
          `  now: ${snap.lastAction || "starting"}`,
        );
      } else {
        lines.push(
          `  ${snap.totalToolCalls} tool call${snap.totalToolCalls === 1 ? "" : "s"} in all` +
            (snap.costUsd === null ? "" : ` - $${snap.costUsd.toFixed(2)}`) +
            (a.answeredAt ? ` - last answered ${ago(now - a.answeredAt)}` : ""),
        );
      }
      for (const f of v.findings) lines.push(`  ${f.concern}: ${f.note}`);
      // Everything not yet answered, plus the latest answer: enough to say
      // whether a follow-up landed, without replaying a long conversation.
      const turns = a.conversation();
      const lastAnswered = turns.filter((t) => t.status === "answered").at(-1);
      lines.push(
        ...renderConversation(
          turns.filter((t) => t === lastAnswered || t.status !== "answered"),
          now,
        ),
      );
      return lines.join("\n");
    });
    return text(blocks.join("\n\n"));
  },
);

server.registerTool(
  "transcript",
  {
    title: "What a subagent actually did",
    description:
      "The agent's recent tool calls: what it read, ran and edited, with results. Its report " +
      "is a claim; this is the evidence. It opens with every message the agent was sent and " +
      "where each stands.\n\n" +
      "Reach for it when a report is surprising, thinner than the task deserved, or arrived " +
      "with a suspiciously low tool-call count — and while a long agent is still running, to " +
      "see whether it is making progress or repeating itself. Costs you context, so read it " +
      "when you doubt something, not by habit.",
    inputSchema: {
      name: z.string(),
      limit: z.number().int().min(1).max(200).optional().describe("Most recent N calls. Default 40."),
    },
  },
  async ({ name, limit }) => {
    const agent = pool.get(name);
    const calls = agent.transcript(limit ?? 40);
    const head = [`"${name}" is ${agent.state}. Messages:`, ...renderConversation(agent.conversation())];
    if (calls.length === 0) return text(`${head.join("\n")}\n\nNo tool calls yet.`);
    return text(`${head.join("\n")}\n\nTool calls, most recent ${calls.length}:\n${JSON.stringify(calls, null, 2)}`);
  },
);

server.registerTool(
  "interrupt",
  {
    title: "Stop the turn a subagent is in the middle of",
    description:
      "Cancels the current turn. Cheap and reversible: the agent keeps its context and goes " +
      "idle, and you can `send_message` it straight after.\n\n" +
      "Use it the moment a `transcript` shows a loop — the same command three times, one file " +
      "thrashed — instead of letting the turn burn to its end. Follow it with a message saying " +
      "what to do instead, or it will resume the same approach.",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    const agent = pool.get(name);
    if (!agent.interrupt()) {
      return text(
        `"${name}" is ${agent.state}, so there was no turn to interrupt and nothing changed. ` +
          `If you meant to give it new instructions, use \`send_message\`.`,
      );
    }
    return text(`Interrupted "${name}". It keeps its context; send it a correction now.`);
  },
);

server.registerTool(
  "stop_agent",
  {
    title: "Shut a subagent down",
    description:
      "Kills the agent's process and frees its name. Its context is gone for good — anything " +
      "it knew and did not put in a report is lost, so read its last answer first.\n\n" +
      "Stop agents as you finish with them. An idle agent holds a live process and its whole " +
      "context window open, which is a real cost for something you are not going to ask " +
      "anything else.",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    const agent = pool.get(name);
    // `nameFor` already refuses to reuse a dead agent's name over its unread
    // mail; this is the same rule from the other side. Stopping is the one
    // operation here that destroys an answer, and doing it silently is how a
    // caller loses work it has already paid for.
    if (agent.uncollected > 0) {
      return text(
        `Not stopping "${name}": it has ${agent.uncollected} finished turn` +
          `${agent.uncollected === 1 ? "" : "s"} you have never collected, and stopping it ` +
          `would throw ${agent.uncollected === 1 ? "that answer" : "those answers"} away. ` +
          `\`collect\` first, then stop it.`,
      );
    }
    pool.remove(name);
    return text(`Stopped "${name}".`);
  },
);

server.registerTool(
  "workflow",
  {
    title: "Run many subagents from one script",
    description:
      "Runs a JavaScript script in which `agent(prompt, opts)` spawns an omp subagent and " +
      "returns its answer. One call, however many agents. Only what your script RETURNS comes " +
      "back to you — a hundred agents' reports cost you nothing unless you keep them.\n\n" +
      "Use it when you want several agents at once, or agents whose work feeds other agents. " +
      "A single question is still `agent`; this is for fan-out, and for the deterministic work " +
      "around a fan-out — collecting, deduping, counting, deciding — which belongs in code " +
      "rather than in your own context.\n\n" +
      "HOOKS (all available as bare identifiers; the body is an async function, so `await` and " +
      "`return` work at the top level):\n" +
      "  • `agent(prompt, opts?)` → the agent's answer as a string. `opts`: `label`, `role`, " +
      "`cwd`, `allowOutsideCwd`, `readOnly` (**defaults to true** — pass `false` deliberately " +
      "for an agent meant to edit files), and `schema`.\n" +
      "  • `agent(prompt, {schema})` → returns a PARSED VALUE, not prose. Pass a plain example " +
      "object describing the shape you want. This is the point of a workflow: a value can be " +
      "counted, filtered and branched on by the script; prose can only be fed to another model.\n" +
      "  • `parallel([fn, fn, …])` → runs thunks concurrently and waits for ALL of them. A " +
      "failure becomes `null` rather than sinking the batch, so filter before you use them.\n" +
      "  • `pipeline(items, stage1, stage2, …)` → each item flows through every stage " +
      "independently, with NO barrier between stages. Each stage gets `(previous, item, index)`.\n" +
      "  • `log(message)` → a progress line, returned with the result.\n" +
      "  • `args` → whatever you passed as `args`.\n\n" +
      "PIPELINE, NOT BARRIER. `pipeline` is the default for multi-stage work. A barrier costs " +
      "the sum over stages of the slowest item in each; a pipeline costs the slowest single " +
      "item's whole chain. Agents vary wildly in duration, so that gap is most of your wall " +
      "clock. Use `parallel` between stages only when a stage truly needs every result at once " +
      "— deduping across all findings, or deciding whether to go on at all. \"I need to flatten " +
      "the array first\" is not such a reason: do it inside a stage.\n\n" +
      "DO THE DETERMINISTIC WORK IN CODE. Merging, deduping, counting, sorting and thresholding " +
      "are things JavaScript does exactly and an agent does approximately, slowly and for money.\n\n" +
      "Example — survey in parallel, then verify each finding as soon as it appears:\n" +
      "```\n" +
      "const AREAS = ['src/core', 'src/server', 'web/src'];\n" +
      "const found = await pipeline(AREAS,\n" +
      "  area => agent(`List every TODO comment under ${area} with its path:line.`,\n" +
      "                { label: area, schema: { todos: [{ path: '', line: 0, text: '' }] } }),\n" +
      "  res => res.todos.slice(0, 5));\n" +
      "const all = found.filter(Boolean).flat();          // plain code, not an agent\n" +
      "log(`${all.length} TODOs`);\n" +
      "return all;\n" +
      "```\n\n" +
      `Bounds: ${DEFAULT_CONCURRENCY} agents run at once by default (the rest queue), at most ` +
      `${MAX_AGENTS} agents in total, and the whole run has a wall-clock deadline. Agents are ` +
      "stopped when the script ends, so nothing is left running.",
    inputSchema: {
      script: z
        .string()
        .min(1)
        .describe(
          "The script body. Not a function or a module — just statements, ending in a `return`.",
        ),
      // Declared as an explicit type union, not z.unknown(): a schema with no
      // `type` gives MCP clients nothing to parse object parameters against,
      // so JSON arrives as its raw text. The union lets a schema-aware client
      // send real values; parseJsonArgs below recovers strings from clients
      // still holding the old schema (schemas bind at session start).
      args: z
        .union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string(), z.number(), z.boolean(), z.null()])
        .optional()
        .describe(
          "Passed through to the script as `args`. Use it to parameterise a script. " +
            "Objects and arrays arrive as real values (a JSON string of one is parsed back).",
        ),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(16)
        .optional()
        .describe(`How many agents run at once. Default ${DEFAULT_CONCURRENCY}.`),
      deadline_seconds: z.number().int().min(30).max(7200).optional(),
      cwd: cwdArg,
    },
  },
  async ({ script, args, concurrency, deadline_seconds, cwd }, extra) => {
    const out = publisher("workflow", true, extra);
    let r;
    try {
      r = await runWorkflow(pool, {
        script,
        args: parseJsonArgs(args),
        concurrency,
        cwd,
        // `progress`/`total` and not just prose: a client handed both renders
        // a percentage of its own. Both grow during the run, because the
        // script decides how many agents there are as it goes.
        onProgress: (p: Progress) => out.send(p.message, p.done, p.total),
        deadlineMs: deadline_seconds === undefined ? undefined : deadline_seconds * 1000,
      });
    } finally {
      out.done();
    }
    const head =
      `${r.ok ? "Workflow finished" : "Workflow FAILED"} · ${r.agentsRun} agent` +
      `${r.agentsRun === 1 ? "" : "s"} · ${Math.round(r.durationMs / 1000)}s · ` +
      `in ${renderPlace(describePlace(cwd ?? process.cwd()))}`;
    const parts = [head];
    if (r.error) parts.push(`\nError: ${r.error}`);
    // The value leads when there is one: it is the answer, and the log is
    // bookkeeping a caller reads only when the answer looks wrong.
    parts.push(`\nReturned:\n${JSON.stringify(r.value ?? null, null, 2)}`);
    if (r.agents.some((a) => a.failed)) {
      parts.push(
        `\nAgents that failed:\n` +
          r.agents.filter((a) => a.failed).map((a) => `- ${a.label}`).join("\n"),
      );
    }
    parts.push(`\nLog:\n${r.log.join("\n")}`);
    return text(parts.join("\n"));
  },
);

/** The agents are children of this process. Leaving them running after it goes
 *  would strand omp processes nobody can address or see. */
function shutdown() {
  for (const id of publishing) live.retract(id);
  pool.stopAll();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("beforeExit", () => {
  for (const id of publishing) live.retract(id);
  pool.stopAll();
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `omp subagent MCP server ${VERSION} ready (cwd: ${process.cwd()})` +
    (pruned > 0 ? ` · pruned ${pruned} old transcript${pruned === 1 ? "" : "s"}` : ""),
);
