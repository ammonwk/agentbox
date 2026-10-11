import { expect, test } from "bun:test";
import { ForeignReasoning, refusedForeignReasoning } from "../../bridge/reasoning";

const request = (...input: unknown[]) => JSON.stringify({ model: "muse-spark-1.3-contributor", input, include: ["reasoning.encrypted_content"] });
const user = { role: "user", content: [{ type: "input_text", text: "go on" }] };
const call = { type: "function_call", name: "bash", call_id: "call_1", arguments: "{}" };
const silent = { type: "reasoning", summary: [], encrypted_content: "blob-of-the-first-account-1" };
const spoken = { type: "reasoning", summary: [{ type: "summary_text", text: "Checking CI." }], encrypted_content: "blob-of-the-first-account-2" };
const own = { type: "reasoning", summary: [], encrypted_content: "blob-of-the-second-account" };

test("Go's refusal of another account's reasoning is told from any other 400", () => {
  expect(refusedForeignReasoning(400, '{"error":{"message":"reasoning `encrypted_content` was not issued to this caller","type":"invalid_request_error"}}')).toBe(true);
  expect(refusedForeignReasoning(400, '{"error":{"message":"`arguments` must be valid JSON"}}')).toBe(false);
  expect(refusedForeignReasoning(500, "encrypted_content was not issued to this caller")).toBe(false);
});

test("a refused request goes again without its blobs, a summary kept as plain text", () => {
  const foreign = new ForeignReasoning();
  const body = request(user, silent, call, spoken, call);
  expect(foreign.strip("b", body)).toBeNull();
  const fixed = foreign.refused("b", body)!;
  expect(fixed.dropped).toBe(2);
  expect(JSON.parse(fixed.body).input).toEqual([user, call, { type: "reasoning", summary: spoken.summary }, call]);
});

test("later requests leave the same blobs out unasked and keep the account's own", () => {
  const foreign = new ForeignReasoning();
  foreign.refused("b", request(user, silent, call, spoken));
  const next = foreign.strip("b", request(user, silent, call, spoken, user, own, call))!;
  expect(next.dropped).toBe(2);
  expect(JSON.parse(next.body).input).toEqual([user, call, { type: "reasoning", summary: spoken.summary }, user, own, call]);
  // The account that issued them still sends them, byte for byte.
  expect(foreign.strip("a", request(user, silent, call, spoken))).toBeNull();
});

test("a body with no reasoning to leave out is not rewritten", () => {
  const foreign = new ForeignReasoning();
  expect(foreign.refused("b", request(user, call))).toBeNull();
  expect(foreign.refused("b", "not json encrypted_content")).toBeNull();
  foreign.refused("b", request(silent));
  expect(foreign.strip("b", request(user, own))).toBeNull();
});
