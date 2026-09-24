/** Validation for the client → server half of the WebSocket protocol.
 *
 * The old server's message handler was `message(_ws) {}` — it threw away
 * everything a client sent, which is why per-session watching could not
 * exist. Anything arriving here is untrusted text, so it is validated rather
 * than cast.
 */

import type { ClientMessage } from "../core/types";

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string };

export function parseClientMessage(raw: unknown): ParseResult {
  const text =
    typeof raw === "string"
      ? raw
      : raw instanceof Uint8Array
        ? new TextDecoder().decode(raw)
        : null;
  if (text === null) return { ok: false, error: "expected a text frame" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "message is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "message must be a JSON object" };
  }

  const msg = parsed as Record<string, unknown>;
  switch (msg.type) {
    case "ping":
      return { ok: true, message: { type: "ping" } };

    case "watch": {
      const sessionId = msg.sessionId;
      if (typeof sessionId !== "string" && sessionId !== null) {
        return { ok: false, error: "watch.sessionId must be a session id or null" };
      }
      if (sessionId === "") {
        return { ok: false, error: "watch.sessionId must not be empty — use null to stop watching" };
      }
      return { ok: true, message: { type: "watch", sessionId } };
    }

    default:
      return {
        ok: false,
        error: `unknown message type ${JSON.stringify(msg.type)} — expected "watch" or "ping"`,
      };
  }
}
