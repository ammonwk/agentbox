/**
 * A replayed tool call whose arguments are not JSON, made valid.
 *
 * A model now and then emits a call that is noise: a tool that does not exist
 * with nothing for arguments (muse-spark-1.3: `default.b65555353`, `""`). The
 * CLI answers it "Tool … not found" and keeps both in the session's history,
 * as it should. But OpenCode Go refuses any request whose history holds a
 * call with arguments that do not parse ("400 `arguments` must be valid
 * JSON"), so from that turn on every request of the session is refused the
 * same way, a continue included: one bad call ends the session. The history
 * is the CLI's to keep; what goes upstream is the proxy's, so the proxy sends
 * such a call with `{}` for arguments. Its output, already in the history,
 * still tells the model what went wrong.
 *
 * Both OpenAI shapes: Responses (`input[].type == "function_call"`) and chat
 * completions (`messages[].tool_calls[].function`). Returns null when there
 * was nothing to repair, so an untouched body goes out byte for byte.
 */

const isJson = (s: unknown): boolean => {
  if (typeof s !== "string") return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

export function repairToolArguments(body: string): { body: string; repaired: string[] } | null {
  // Every valid arguments string is quoted JSON; cheap to rule the rest out.
  if (!body.includes('"arguments"')) return null;
  let req: { input?: unknown; messages?: unknown };
  try {
    req = JSON.parse(body);
  } catch {
    return null;
  }
  const repaired: string[] = [];
  const fix = (call: { name?: unknown; arguments?: unknown } | undefined | null): void => {
    if (!call || isJson(call.arguments)) return;
    call.arguments = "{}";
    repaired.push(String(call.name ?? "?"));
  };
  if (Array.isArray(req.input)) {
    for (const item of req.input) if (item?.type === "function_call") fix(item);
  }
  if (Array.isArray(req.messages)) {
    for (const m of req.messages) if (Array.isArray(m?.tool_calls)) for (const c of m.tool_calls) fix(c?.function);
  }
  return repaired.length ? { body: JSON.stringify(req), repaired } : null;
}
