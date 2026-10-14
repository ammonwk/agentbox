import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Api } from "../client";
import type { AppState } from "../core/types";
import type { LocalAgent } from "../core/agents/conversation";
import { parseArgs } from "./sessions";

type Board = Pick<AppState, "sessions" | "repos">;
const projectName = (board: Board, a: LocalAgent) => (a.repo ? board.repos.find((r) => r.id === a.repo)?.displayName ?? "unregistered" : "general");

/** The agent `name` means: an ID, or a name, of the caller's own project when
 *  several projects have one (each project has its own instance), or of
 *  `project` when given. */
export function pickAgent(agents: LocalAgent[], board: Board, name: string, project: string | null, caller: string | null): LocalAgent {
  const exact = agents.find((a) => a.id === name);
  if (exact) return exact;
  let found = agents.filter((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!found.length) throw new Error(`no agent "${name}"; agentbox agent ls lists them`);
  const mine = caller ? agents.find((a) => [a.session, ...a.previous, ...(a.workSessions ?? [])].includes(caller)) : undefined;
  const repo = project
    ? board.repos.find((r) => r.id === project || r.displayName.toLowerCase() === project.toLowerCase())?.id ?? null
    : mine?.repo;
  if (project && repo === null) throw new Error(`no project "${project}"`);
  if (found.length > 1 && repo !== undefined) found = found.filter((a) => a.repo === repo);
  if (found.length !== 1)
    throw new Error(`${found.length ? `"${name}" is in several projects` : `no "${name}" in that project`}; name one with --project or use its ID:\n${agents.filter((a) => a.name.toLowerCase() === name.toLowerCase()).map((a) => `  ${a.id}  ${projectName(board, a)}`).join("\n")}`);
  return found[0]!;
}

/** `agentbox agent ls [--project P] [--json]`: each local agent, switched on
 *  or not, and the session its chat is in now. */
async function agentList(api: Api, args: string[]): Promise<number> {
  const { flags } = parseArgs(args, ["project"], ["json"]);
  const [agents, board] = await Promise.all([api<LocalAgent[]>("GET", "/api/agents/local"), api<Board>("GET", "/api/state")]);
  const project = typeof flags.get("project") === "string" ? (flags.get("project") as string).toLowerCase() : null;
  const shown = agents.filter((a) => !a.unavailable && (!project || a.repo === project || projectName(board, a).toLowerCase() === project));
  const rows = shown.map((a) => {
    const s = a.session ? board.sessions.find((x) => x.id === a.session) : undefined;
    return { id: a.id, name: a.name, role: a.role, project: projectName(board, a), enabled: a.enabled, session: a.session, status: s?.status ?? null };
  });
  if (flags.has("json")) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  for (const r of rows)
    console.log([r.name.padEnd(10), (r.enabled ? "on" : "paused").padEnd(6), r.project.slice(0, 20).padEnd(20), (r.session ?? "no chat").padEnd(8), (r.status ?? "").padEnd(8), r.id].join("  "));
  return 0;
}

/** `agentbox agent send <agent> [--project P] <text…|->`: a message to
 *  another agent's chat. Its current chat takes it as a send from this
 *  session, with its sender recorded; an agent with no chat starts one. */
async function agentSend(api: Api, args: string[]): Promise<number> {
  let [name, ...words] = args;
  let project: string | null = null;
  if (words[0] === "--project") [, project, ...words] = words;
  if (!name || !words.length) throw new Error("agent send <agent> [--project P] <text…|->");
  const text = words.length === 1 && words[0] === "-" ? (await new Response(Bun.stdin.stream()).text()).trim() : words.join(" ");
  if (!text) throw new Error("nothing to send");
  const [agents, board] = await Promise.all([api<LocalAgent[]>("GET", "/api/agents/local"), api<Board>("GET", "/api/state")]);
  const a = pickAgent(agents, board, name, project, process.env.AGENTBOX_SESSION ?? null);
  if (!a.enabled) throw new Error(`${a.name} is paused; switch it on in its Agents page first`);
  if (a.unavailable) throw new Error(a.unavailable);
  if (a.session && board.sessions.some((s) => s.id === a.session)) {
    // Waking it is the point of messaging an agent, so --wake is implied.
    const sent = await api<{ to: string } | null>("POST", `/api/sessions/${a.session}/send`, { text, from: "agent", wake: true, fromSession: process.env.AGENTBOX_SESSION, callerPid: process.pid });
    console.log(`sent to ${a.name} (${a.id}): its chat ${sent?.to ?? a.session} took it`);
    return 0;
  }
  const r = await api<{ state: string; result: string }>("POST", `/api/agents/local/${encodeURIComponent(a.id)}/chat`, { request: randomUUID(), body: text, target: null });
  if (r.state !== "sent") throw new Error(`${a.name} did not take it (${r.state}): ${r.result}`);
  const now = (await api<LocalAgent[]>("GET", "/api/agents/local")).find((x) => x.id === a.id);
  console.log(`sent to ${a.name} (${a.id}): it had no chat, so this started a new conversation, session ${now?.session ?? "unknown"}`);
  return 0;
}

export async function agent(api: Api, args: string[]): Promise<number> {
  const [verb, ...more] = args;
  // These two print lines of their own, and send's text may hold any word.
  if (verb === "ls") return agentList(api, more);
  if (verb === "send") return agentSend(api, more);
  const { flags, rest } = parseArgs(
    more,
    [
      "file",
      "stage",
      "next",
      "outcome",
      "evidence",
      "evidence-label",
      "decision",
      "request",
      "paths",
      "areas",
      "repo",
      "kind",
      "number",
      "condition",
      "key",
      "text",
      "activity",
      "reason",
    ],
    ["json"],
  );
  const str = (k: string) =>
    typeof flags.get(k) === "string" ? (flags.get(k) as string) : "";
  const id = rest[0],
    callerPid = process.pid;
  const file = () => {
    if (!str("file")) throw new Error("give --file <json-file>");
    return JSON.parse(readFileSync(str("file"), "utf8"));
  };
  let value: unknown;
  switch (verb) {
    case "session": {
      const [, session, action] = rest;
      if (!id || !session || !["close", "restore"].includes(action ?? "") || !str("request") || !str("activity") || !str("reason"))
        throw new Error("agent session <agent ID> <session ID> close|restore --request <UUID> --activity <lastActivityAt> --reason <why>");
      value = await api("POST", `/api/agents/local/${encodeURIComponent(id)}/sessions/${encodeURIComponent(session)}`, {
        request: str("request"), action, activity: Number(str("activity")), reason: str("reason"),
      });
      break;
    }
    case "work-start":
      value = await api("POST", "/api/agents/work", file());
      break;
    case "work":
      value = await api(
        "GET",
        `/api/agents/work${id ? `/${encodeURIComponent(id)}` : ""}`,
      );
      break;
    case "work-validation":
    case "work-review":
    case "work-follow":
    case "work-collect":
    case "work-publish":
    case "work-failure":
    case "work-milestone":
    case "work-retry-review":
    case "work-reconcile":
    case "work-retry-start":
      if (!id) throw new Error(`${verb} requires a work family UUID`);
      value = await api(
        "POST",
        `/api/agents/work/${encodeURIComponent(id)}/${verb.slice(5)}`,
        ["work-follow", "work-collect", "work-reconcile", "work-retry-start"].includes(verb)
          ? {}
          : file(),
      );
      break;
    case "prepare":
    case "review":
    case "collect":
    case "retry-review":
      if (!id) throw new Error(`${verb} requires a run UUID`);
      value = await api(
        "POST",
        `/api/agents/runs/${encodeURIComponent(id)}/${verb}`,
        verb === "collect" ? {} : file(),
      );
      break;
    case "intake":
      if (!id) throw new Error("agent intake <run UUID> --file <work.json>");
      value = await api(
        "POST",
        `/api/agents/runs/${encodeURIComponent(id)}/intake`,
        { item: file() },
      );
      break;
    case "draft":
      if (!id || !str("request"))
        throw new Error(
          "agent draft <creator agent ID|run UUID> --request <stable UUID> --file <creation.json>",
        );
      value = await api(
        "POST",
        `/api/agents/${encodeURIComponent(id)}/creation-drafts`,
        { request: str("request"), spec: file() },
      );
      break;
    case "recommend":
      if (!id || !str("request"))
        throw new Error(
          "agent recommend <run UUID|local agent ID> --request <stable UUID> --file <proposal.json>",
        );
      value = await api(
        "POST",
        `/api/agents/${encodeURIComponent(id)}/recommend`,
        { request: str("request"), proposal: file() },
      );
      break;
    case "memory": {
      const [, what, ...words] = rest;
      if (!id)
        throw new Error(
          "agent memory <local agent ID|run UUID> [search WORDS | show ID | handoff|note --request UUID --file JSON | prefer --key K --text T | forget --key K]",
        );
      const base = `/api/agents/${encodeURIComponent(id)}/memory`;
      if (!what || what === "search")
        value = await api("GET", `${base}?q=${encodeURIComponent(words.join(" "))}`);
      else if (what === "show") {
        if (!words[0]) throw new Error("agent memory <ID> show <record ID>");
        value = await api("GET", `${base}/${encodeURIComponent(words[0])}`);
      } else if (what === "handoff" || what === "note") {
        if (!str("request")) throw new Error(`agent memory <ID> ${what} --request <stable UUID> --file <JSON>`);
        value = await api("POST", `${base}/${what}`, { request: str("request"), body: file() });
      } else if (what === "prefer" || what === "forget") {
        // --file: the text of a file, for a rule too long to quote on a command line.
        const text = what === "prefer" ? (str("file") ? readFileSync(str("file"), "utf8").trim() : str("text")) : "";
        if (!str("key") || (what === "prefer" && !text))
          throw new Error("agent memory <ID> prefer --key <key> --text <text> | --file <text file>, or forget --key <key>");
        value = await api("POST", `${base}/prefer`, { body: { key: str("key"), text } });
      } else throw new Error(`unknown memory verb ${what}`);
      break;
    }
    case undefined:
    case "status":
      value = await api("GET", "/api/agents/runtime");
      break;
    case "bind":
      value = await api("POST", "/api/agents/binding", {
        callerPid,
        humanToken: process.env.AGENTBOX_HUMAN_ACCESS_TOKEN,
        binding: file(),
      });
      break;
    case "sync":
      value = await api("POST", "/api/agents/sync", {});
      break;
    case "check":
    case "read":
      if (!id || !str("repo") || !str("number"))
        throw new Error(
          "agent read <run UUID> --repo owner/repo --number N [--kind issue|pull|checks|reviews]",
        );
      value = await api(
        "POST",
        `/api/agents/runs/${encodeURIComponent(id)}/read`,
        {
          callerPid,
          source: {
            repo: str("repo"),
            number: Number(str("number")),
            kind:
              verb === "check"
                ? str("condition") === "merged"
                  ? "pull"
                  : "checks"
                : str("kind") || "issue",
          },
        },
      );
      if (verb === "check") {
        if (!["merged", "checks"].includes(str("condition")))
          throw new Error("agent check requires --condition merged|checks");
        const r = value as {
          merged?: boolean;
          mergeCommit?: string;
          checks?: {
            total_count: number;
            check_runs: { status: string; conclusion: string }[];
          };
          status?: { total_count: number; statuses: { state: string }[] };
        };
        const ready =
          str("condition") === "merged"
            ? !!r.merged && !!r.mergeCommit
            : !!r.checks &&
              !!r.status &&
              r.checks.total_count <= r.checks.check_runs.length &&
              r.status.total_count <= r.status.statuses.length &&
              r.checks.check_runs.every(
                (c) =>
                  c.status === "completed" &&
                  ["success", "skipped", "neutral"].includes(c.conclusion),
              ) &&
              r.status.statuses.every((s) => s.state === "success");
        console.log(
          ready
            ? `${str("condition")} confirmed by configured GitHub actor`
            : `${str("condition")} not confirmed yet`,
        );
        return ready ? 0 : 1;
      }
      break;
    case "progress":
      if (!id || !str("stage"))
        throw new Error(
          "agent progress <run UUID> --stage <stage> --next <action> [--outcome <verification>] [--evidence <url> --evidence-label <label>] [--decision <question>]",
        );
      value = await api(
        "POST",
        `/api/agents/runs/${encodeURIComponent(id)}/progress`,
        {
          callerPid,
          progress: {
            stage: str("stage"),
            next: str("next"),
            outcome: str("outcome"),
            evidence: str("evidence")
              ? [
                  {
                    url: str("evidence"),
                    label: str("evidence-label") || "Evidence",
                  },
                ]
              : [],
          },
          decision: str("decision"),
        },
      );
      break;
    case "action":
      if (!id || !str("request"))
        throw new Error(
          "agent action <run UUID> --request <UUID retained for retries> --file <action JSON>",
        );
      value = await api(
        "POST",
        `/api/agents/runs/${encodeURIComponent(id)}/actions`,
        { callerPid, action: file(), request: str("request") },
      );
      break;
    case "finish":
    case "rotate":
      if (!id) throw new Error(`agent ${verb} needs a run UUID`);
      value = await api(
        "POST",
        `/api/agents/runs/${encodeURIComponent(id)}/${verb}`,
        {
          callerPid,
          ...(verb === "rotate"
            ? { humanToken: process.env.AGENTBOX_HUMAN_ACCESS_TOKEN }
            : {}),
        },
      );
      break;
    case "experts":
      if (!id)
        throw new Error(
          "agent experts <agent UUID> [--areas comma,list] [--paths comma,list]",
        );
      value = await api(
        "POST",
        `/api/agents/${encodeURIComponent(id)}/experts`,
        {
          areas: str("areas").split(",").filter(Boolean),
          paths: str("paths").split(",").filter(Boolean),
        },
      );
      break;
    default:
      throw new Error(
        "agent takes ls, send, status, bind, sync, read, progress, prepare, review, collect, retry-review, action, experts, finish, rotate; local work uses work-start, work, work-validation, work-review, work-collect, work-retry-review, work-retry-start, work-publish, work-follow, work-reconcile, work-failure; create agents through Jupiter",
      );
  }
  console.log(JSON.stringify(value, null, 2));
  return 0;
}
