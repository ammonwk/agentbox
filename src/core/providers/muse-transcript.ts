/** Muse Code 1.3's retained session stream. The session log is the record;
 * run/task logs and model-input traces are projections, not more messages.
 * Timestamps are epoch microseconds. Permission transactions wrap records in
 * `children[].record_json`; omitted-live-only markers carry no conversation. */
import type { TranscriptFacts, TranscriptRef } from "./types";
import { cap, capJson, INPUT_CAP, OUTPUT_CAP, type Piece, type TranscriptFormat } from "./jsonl-reader";

const str = (v: unknown): string => typeof v === "string" ? v : "";
const num = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : 0;
const atOf = (r: any): number => Math.floor(num(r?.recorded_at) / 1000);

function records(value: any): any[] {
  if (value?.retained_frame && Array.isArray(value.children)) {
    return value.children.flatMap((c: any) => {
      try { return records(JSON.parse(c.record_json)); } catch { return []; }
    });
  }
  return value?.payload && typeof value.payload === "object" ? [value] : [];
}

function emptyFacts(id: string): TranscriptFacts {
  return {
    agentSessionId: id, cwd: null, resumeCwd: null, title: null,
    firstPrompt: null, lastPrompt: null, lastPromptAt: null, lastMessage: null,
    model: null, gitBranch: null, startedAt: null, lastActivityAt: null,
    lastTurnAt: null, turnOpen: false, turnError: null,
    contextUsed: null, contextLimit: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEquiv: 0 },
    usage: null, rateLimitHits: [], isSubagent: true, parentId: null,
  };
}

function toolInput(value: unknown): any {
  if (typeof value !== "string") return value ?? {};
  try { return JSON.parse(value); } catch { return { text: value }; }
}

function calls(e: any): any[] { return Array.isArray(e?.tool_calls) ? e.tool_calls : []; }
function results(e: any): any[] { return Array.isArray(e?.results) ? e.results : []; }
const callId = (c: any): string => str(c?.call_id) || str(c?.id);

function callPiece(c: any, at: number, prefix: string): Piece {
  const input = toolInput(c.args);
  const summary = str(input.command) || str(input.cmd) || str(input.path) || str(input.file_path) || str(input.query) || str(input.pattern) || str(c.name);
  return { kind: "call", callId: prefix + callId(c), event: {
    id: prefix + callId(c), at, kind: "tool", name: str(c.name), summary: cap(summary, 300),
    ...(str(input.description) ? { title: input.description } : {}),
    input: capJson(input, INPUT_CAP), status: "running",
  } };
}

function resultPiece(r: any, at: number, prefix: string): Piece {
  const text = str(r.text ?? r.result);
  const parsed = toolInput(text);
  const error = r.is_error === true || parsed.is_error === true || parsed.terminal_status === "failed" || (typeof parsed.exit_code === "number" && parsed.exit_code !== 0);
  return { kind: "result", callId: prefix + (str(r.tool_call_id) || callId(r)), output: cap(text, OUTPUT_CAP), error, at };
}

function piecesFor(r: any, index: number): Piece[] {
  const p = r.payload;
  const at = atOf(r);
  const id = str(r.id) || `muse:${index}`;
  if (r.payload_type === "session.fork.turn") {
    const t = p.turn;
    if (!t) return [];
    const prefix = `fork:${p.turn_index}:`;
    const started = Math.floor(num(t.source?.started_recorded_at) / 1000);
    const finished = Math.floor(num(t.source?.answer_recorded_at) / 1000);
    return [
      ...(str(t.prompt) ? [{ kind: "event", event: { id: prefix + "user", at: started, kind: "user", text: t.prompt } } as Piece] : []),
      ...(Array.isArray(t.tool) ? t.tool.flatMap((c: any) => [callPiece(c, started, prefix), resultPiece(c, finished, prefix)]) : []),
      ...(str(t.answer) ? [{ kind: "event", event: { id: prefix + "answer", at: finished, kind: "assistant", text: t.answer } } as Piece] : []),
    ];
  }
  if (p.kind !== "run") return [];
  const e = p.event;
  if (!e) return [];
  switch (e.kind) {
    case "started": return str(e.prompt) ? [{ kind: "event", event: { id, at, kind: "user", text: e.prompt } }] : [];
    case "inbox_item_queued": return e.source?.source === "user_steer" && str(e.body) ? [{ kind: "event", event: { id, at, kind: "user", text: e.body } }] : [];
    case "assistant_message_committed": return str(e.text) ? [{ kind: "event", event: { id, at, kind: "assistant", text: e.text } }] : [];
    case "reasoning_summary_committed":
    case "reasoning_committed": return str(e.text) ? [{ kind: "event", event: { id, at, kind: "thinking", text: e.text } }] : [];
    case "assistant_tool_calls_committed": return calls(e).filter((c) => callId(c)).map((c) => callPiece(c, at, ""));
    case "tool_result_batch_committed": return results(e).map((result) => resultPiece(result, at, ""));
    case "context_compaction_installed": return [{ kind: "event", event: { id, at, kind: "meta", text: "Context compacted", tone: "info" } }];
    case "terminal": return e.terminal === "failed" ? [{ kind: "event", event: { id, at, kind: "meta", text: str(e.reason) || "Muse run failed", tone: "error" } }] : [];
    default: return [];
  }
}

export function museFormat(ref: TranscriptRef): TranscriptFormat {
  let facts = emptyFacts(ref.agentSessionId);
  const prompt = (text: string, at: number) => {
    if (!text) return;
    facts.firstPrompt ??= text;
    facts.lastPrompt = text;
    facts.lastPromptAt = at || facts.lastPromptAt;
  };
  return {
    reset() { facts = emptyFacts(ref.agentSessionId); },
    facts() { return facts; },
    state() { return facts; },
    restore(saved) {
      const s = saved as TranscriptFacts;
      if (s?.agentSessionId !== ref.agentSessionId || !s.tokens) throw new Error("invalid Muse fold");
      facts = s;
    },
    add(value) {
      for (const r of records(value)) {
        const p = r.payload;
        const at = atOf(r);
        if (at) facts.startedAt ??= at;
        if (p.kind === "metadata" && str(p.record?.workspace_root)) {
          facts.cwd = facts.resumeCwd = p.record.workspace_root;
          facts.isSubagent = false; // approval-only side streams have no workspace/session header
        }
        if (p.kind === "workspace_branch") {
          if (str(p.record?.workspace_root)) facts.cwd = facts.resumeCwd = p.record.workspace_root;
          if (p.record?.reference?.kind === "branch") facts.gitBranch = str(p.record.reference.name) || null;
        }
        if (r.payload_type === "session.name.changed") facts.title = str(p.new_name) || null;
        if (p.kind === "run_model") facts.model = str(p.record?.model_id) || facts.model;
        if (r.payload_type === "runtime.session.permission_profile_committed") facts.skipsPermissions = p.resolved_snapshot?.approval === "allow_all";
        if (p.kind === "security_mode") facts.skipsPermissions = p.event?.approval === "disabled";
        if (r.payload_type === "session.fork.turn" && p.turn) {
          const t = p.turn;
          prompt(str(t.prompt), Math.floor(num(t.source?.started_recorded_at) / 1000));
          if (str(t.answer)) facts.lastMessage = t.answer.slice(-300);
        }
        if (p.kind !== "run" || !p.event) continue;
        const e = p.event;
        switch (e.kind) {
          case "started":
            prompt(str(e.prompt), at);
            facts.turnOpen = true;
            facts.turnError = null;
            break;
          case "inbox_item_queued":
            if (e.source?.source !== "user_steer") continue;
            prompt(str(e.body), at);
            break;
          case "assistant_message_committed":
            if (str(e.text)) facts.lastMessage = e.text.slice(-300);
            break;
          case "assistant_tool_calls_committed":
          case "tool_result_batch_committed":
          case "reasoning_summary_committed":
          case "reasoning_committed": break;
          case "model_completed": {
            const u = e.usage ?? {};
            const cached = num(u.cache_read_tokens ?? u.cached_tokens);
            const written = num(u.cache_write_tokens);
            facts.tokens.input += Math.max(0, num(u.input_tokens) - cached - written);
            facts.tokens.output += num(u.output_tokens);
            facts.tokens.cacheRead += cached;
            facts.tokens.cacheWrite += written;
            facts.contextUsed = num(u.input_tokens) + num(u.output_tokens);
            facts.lastTurnAt = at;
            facts.model = str(e.model) || facts.model;
            break;
          }
          case "context_compaction_installed":
            facts.contextUsed = num(e.budget_after?.estimated_prompt_tokens) || facts.contextUsed;
            break;
          case "terminal": {
            facts.turnOpen = false;
            const detail = str(e.reason);
            if (e.terminal === "failed" && detail) {
              if (/rate.?limit|quota|usage limit|too many requests|\b429\b/i.test(detail)) {
                facts.rateLimitHits.push({ at, detail });
              } else {
                const kind = /max.?output|max.?tokens|output.?limit/i.test(detail) ? "output-cap"
                  : /overload|capacity|timed? ?out|timeout|connection|network|\b50[0234]\b/i.test(detail) ? "transient" : "fatal";
                facts.turnError = { at, kind, detail };
              }
            }
            break;
          }
          default: continue; // Background bookkeeping does not keep the turn busy.
        }
        if (at) facts.lastActivityAt = at;
      }
    },
    links(value) {
      const opened: string[] = [], closed: string[] = [];
      for (const r of records(value)) {
        const p = r.payload;
        if (p.kind === "run" && p.event?.kind === "assistant_tool_calls_committed") opened.push(...calls(p.event).map(callId).filter(Boolean));
        if (p.kind === "run" && p.event?.kind === "tool_result_batch_committed") closed.push(...results(p.event).map((t) => str(t.tool_call_id)).filter(Boolean));
        if (r.payload_type === "session.fork.turn" && Array.isArray(p.turn?.tool)) {
          const ids = p.turn.tool.map((c: any) => `fork:${p.turn_index}:${callId(c)}`);
          opened.push(...ids); closed.push(...ids);
        }
      }
      return opened.length || closed.length ? { calls: opened, results: closed } : null;
    },
    pieces(value, index) { return records(value).flatMap((r) => piecesFor(r, index)); },
    // `piecesFor` names an event by its record's id, or its index when it has none.
    locate(id) {
      const r = /^muse:(\d+)/.exec(id);
      const own = id.split(":")[0];
      return r ? { index: Number(r[1]) } : own && own !== "fork" ? { text: `"id":${JSON.stringify(own)}` } : null;
    },
  };
}
