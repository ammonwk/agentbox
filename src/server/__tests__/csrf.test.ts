import { describe, expect, test } from "bun:test";
import { checkRequest } from "../csrf";

const PORT = 4479;
const req = (method: string, headers: Record<string, string>) =>
  new Request(`http://127.0.0.1:${PORT}/api/x`, { method, headers });

describe("checkRequest", () => {
  test("the app itself: same-origin GET and a POST with the header", () => {
    expect(checkRequest(req("GET", { host: "127.0.0.1:4479" }), PORT).ok).toBe(true);
    expect(checkRequest(req("POST", { host: "127.0.0.1:4479", origin: "http://127.0.0.1:4479", "x-agentbox": "1" }), PORT).ok).toBe(true);
    expect(checkRequest(req("POST", { host: "localhost:4479", origin: "http://localhost:5173", "x-agentbox": "1" }), PORT).ok).toBe(true);
  });

  test("the CLI: no Origin, header set", () => {
    expect(checkRequest(req("POST", { host: "127.0.0.1:4479", "x-agentbox": "1" }), PORT).ok).toBe(true);
  });

  test("a simple cross-site form post has no custom header", () => {
    const v = checkRequest(req("POST", { host: "127.0.0.1:4479", "content-type": "text/plain" }), PORT);
    expect(v.ok).toBe(false);
  });

  test("any other origin is refused, including on a websocket upgrade", () => {
    expect(checkRequest(req("POST", { host: "127.0.0.1:4479", origin: "https://evil.example", "x-agentbox": "1" }), PORT).ok).toBe(false);
    expect(checkRequest(req("GET", { host: "127.0.0.1:4479", origin: "http://127.0.0.1:8080" }), PORT, { upgrade: true }).ok).toBe(false);
    expect(checkRequest(req("GET", { host: "127.0.0.1:4479", origin: "null" }), PORT, { upgrade: true }).ok).toBe(false);
  });

  test("DNS rebinding: a foreign Host is refused even with no Origin", () => {
    expect(checkRequest(req("GET", { host: "evil.example:4479" }), PORT).ok).toBe(false);
    expect(checkRequest(req("GET", { host: "127.0.0.1:9999" }), PORT).ok).toBe(false);
  });

  test("tailnet names pass only where the tailnet listener passes them, and only on our port", () => {
    const hosts = ["100.101.102.103", "box.tail1234.ts.net", "box"];
    const ts = { host: "box.tail1234.ts.net:4479", origin: "http://box.tail1234.ts.net:4479", "x-agentbox": "1" };
    expect(checkRequest(req("POST", ts), PORT, { hosts }).ok).toBe(true);
    expect(checkRequest(req("GET", { host: "box:4479", origin: "http://box:4479" }), PORT, { upgrade: true, hosts }).ok).toBe(true);
    expect(checkRequest(req("POST", ts), PORT).ok).toBe(false);
    expect(checkRequest(req("POST", { ...ts, origin: "https://box.tail1234.ts.net:4479" }), PORT, { hosts }).ok).toBe(true);
    expect(checkRequest(req("POST", { host: "127.0.0.1:4479", origin: "https://127.0.0.1:4479", "x-agentbox": "1" }), PORT).ok).toBe(false);
    expect(checkRequest(req("GET", { host: "box.tail1234.ts.net:5173" }), PORT, { hosts }).ok).toBe(false);
    expect(checkRequest(req("POST", { ...ts, origin: "https://evil.example" }), PORT, { hosts }).ok).toBe(false);
  });
});
