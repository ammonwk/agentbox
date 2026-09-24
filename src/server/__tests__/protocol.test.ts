import { describe, expect, test } from "bun:test";
import { parseClientMessage } from "../protocol";

function ok(raw: unknown) {
  const r = parseClientMessage(raw);
  if (!r.ok) throw new Error(`expected a valid message, got: ${r.error}`);
  return r.message;
}

function err(raw: unknown): string {
  const r = parseClientMessage(raw);
  if (r.ok) throw new Error(`expected a rejection, got: ${JSON.stringify(r.message)}`);
  return r.error;
}

describe("ClientMessage validation", () => {
  test("accepts ping", () => {
    expect(ok('{"type":"ping"}')).toEqual({ type: "ping" });
  });

  test("accepts watch with a session id", () => {
    expect(ok('{"type":"watch","sessionId":"s1"}')).toEqual({ type: "watch", sessionId: "s1" });
  });

  test("accepts watch with a null session id — that is how a client unsubscribes", () => {
    expect(ok('{"type":"watch","sessionId":null}')).toEqual({
      type: "watch",
      sessionId: null,
    });
  });

  test("accepts a binary text frame", () => {
    expect(ok(new TextEncoder().encode('{"type":"ping"}'))).toEqual({ type: "ping" });
  });

  test("rejects garbage instead of throwing", () => {
    expect(err("not json at all")).toContain("valid JSON");
    expect(err("")).toContain("valid JSON");
    expect(err("[1,2,3]")).toContain("JSON object");
    expect(err('"just a string"')).toContain("JSON object");
    expect(err("null")).toContain("JSON object");
  });

  test("rejects an unknown or missing type, and names what it expected", () => {
    expect(err('{"type":"subscribe"}')).toContain("watch");
    expect(err("{}")).toContain("watch");
    expect(err('{"type":42}')).toContain("watch");
  });

  test("rejects a watch whose sessionId is not a string or null", () => {
    expect(err('{"type":"watch","sessionId":7}')).toContain("sessionId");
    expect(err('{"type":"watch"}')).toContain("sessionId");
    expect(err('{"type":"watch","sessionId":""}')).toContain("empty");
  });
});
