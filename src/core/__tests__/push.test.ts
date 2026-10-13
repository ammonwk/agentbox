import { describe, expect, test } from "bun:test";
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { b64url, blockedNews, encryptPush, PUSH_HOLD_MS } from "../push";
import type { Session } from "../types";

/** What a browser does with a push (RFC 8291), on node's crypto rather than the WebCrypto that sealed it. */
function open(body: Uint8Array, ua: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLen = body[20]!;
  const asPublic = body.subarray(21, 21 + idLen);
  const sealed = body.subarray(21 + idLen);
  const shared = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

describe("encryptPush", () => {
  test("a browser holding the subscription's keys reads the message", async () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
    const text = JSON.stringify({ title: "Fix the build", body: "Blocked: waiting on a prompt" });
    const body = await encryptPush({ keys: { p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) } }, new TextEncoder().encode(text));
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(open(body, ua, auth)).toBe(text);
  });
});

describe("blockedNews", () => {
  const blocked = (id: string, extra: Partial<Session> = {}) => ({ id, title: id, label: null, status: "blocked", autoResume: null, question: null, ...extra }) as Session;
  let now = 1_000_000;
  let typed: Record<string, number> = {};
  /** The board `ms` later. */
  const bodies = (sessions: Session[], reasons: Record<string, string>, ms = PUSH_HOLD_MS) => {
    now += ms;
    return blockedNews(sessions, (id) => reasons[id] ?? null, (id) => typed[id] ?? 0, now).news.map((m) => `${m.tag}: ${m.body}`);
  };

  test("an error screen is not pushed, retried or spent; the prompt after it is", () => {
    // The first board is what was blocked at startup: not news.
    expect(bodies([blocked("old")], { old: "permission: Bash" })).toEqual([]);
    const retried = blocked("a", { autoResume: { at: 1, attempt: 1, of: 3, after: "error" } });
    const first = { a: "error — agentbox retries it in 1m", b: "permission: Bash" };
    expect(bodies([retried, blocked("b")], first)).toEqual([]);
    expect(bodies([retried, blocked("b")], first)).toEqual(["b: Blocked: permission: Bash"]);
    // Its retries spent, the error is still only on the board.
    expect(bodies([blocked("a"), blocked("b")], { a: "error", b: "permission: Bash" })).toEqual([]);
    expect(bodies([blocked("a"), blocked("b")], { a: "folder trust", b: "permission: Bash" })).toEqual(["a: Blocked: folder trust"]);
    expect(bodies([], {})).toEqual([]);
  });

  test("a block gone within the hold is never pushed; one that stands is pushed once", () => {
    const board = [blocked("c")];
    const why = { c: "folder trust" };
    expect(blockedNews(board, (id) => why[id as "c"], () => 0, now)).toEqual({ news: [], next: now + PUSH_HOLD_MS });
    // Answered by the fleet a pass later, then a prompt that is yours.
    expect(bodies([], {}, 2_000)).toEqual([]);
    expect(bodies(board, { c: "permission: Bash" }, 2_000)).toEqual([]);
    expect(bodies(board, { c: "permission: Bash" }, PUSH_HOLD_MS - 1)).toEqual([]);
    expect(bodies(board, { c: "permission: Bash" }, 1)).toEqual(["c: Blocked: permission: Bash"]);
    expect(bodies(board, { c: "permission: Bash" })).toEqual([]);
    expect(bodies([], {})).toEqual([]);
  });

  test("a panel you opened in its terminal is not pushed; a prompt there is", () => {
    typed = { d: now + 1_000, e: now + 1_000 };
    const board = [blocked("d"), blocked("e")];
    const why = { d: "dialog open", e: "asking a question" };
    expect(bodies(board, why, 2_000)).toEqual([]);
    expect(bodies(board, why)).toEqual(["e: Blocked: asking a question"]);
    expect(bodies(board, why)).toEqual([]);
    // The same panel with nobody at the terminal is some dialog of Claude's own.
    expect(bodies([], {})).toEqual([]);
    expect(bodies([blocked("d")], why, 60_000)).toEqual([]);
    expect(bodies([blocked("d")], why)).toEqual(["d: Blocked: dialog open"]);
  });
});
