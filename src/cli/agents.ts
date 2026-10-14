import { readFileSync } from "node:fs";
import type { Api } from "../client";
import { parseArgs } from "./sessions";

export async function agent(api: Api, args: string[]): Promise<number> {
  const [verb, ...more] = args;
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
        if (!str("key") || (what === "prefer" && !str("text")))
          throw new Error("agent memory <ID> prefer --key <key> --text <text>, or forget --key <key>");
        value = await api("POST", `${base}/prefer`, { body: { key: str("key"), text: what === "prefer" ? str("text") : "" } });
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
        "agent takes status, bind, sync, read, progress, prepare, review, collect, retry-review, action, experts, finish, rotate; local work uses work-start, work, work-validation, work-review, work-collect, work-retry-review, work-retry-start, work-publish, work-follow, work-reconcile, work-failure; create agents through Jupiter",
      );
  }
  console.log(JSON.stringify(value, null, 2));
  return 0;
}
