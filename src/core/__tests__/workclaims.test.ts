import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../db";
import { superagentToken } from "../superagents";
import type { Session } from "../types";
import { canonicalSource, LEASE_MS, WorkClaims, type SessionControl } from "../workclaims";
import { claimCaller } from "../../server/claims";
import type { Superagents } from "../superagents";

const dir = mkdtempSync(join(tmpdir(), "agentbox-workclaims-"));
const old = process.env.AGENTBOX_HOME;
process.env.AGENTBOX_HOME = dir;
closeDb();
afterAll(() => {
  closeDb();
  if (old === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = old;
  rmSync(dir, { recursive: true, force: true });
});

/** The fleet as the takeover sees it: a stop ends a pane unless the session is stubborn. */
class FakeFleet implements SessionControl {
  list: Session[] = [];
  stubborn = new Set<string>();
  stops: string[] = [];
  add(id: string, host: Session["host"] = "tmux") {
    this.list.push({ id, host, pid: host === "none" ? null : 100, status: "running" } as Session);
  }
  sessions() {
    return this.list;
  }
  async stopSession(id: string) {
    this.stops.push(id);
    if (this.stubborn.has(id)) return;
    const s = this.list.find((x) => x.id === id)!;
    s.host = "none";
    s.pid = null;
  }
  async tick() {}
}

let fleet: FakeFleet;
let claims: WorkClaims;
const vulcan = { superagent: "vulcan", session: null };
const other = { superagent: "steward", session: null };
const person = { superagent: null, session: null };
const T = 1_000_000;

beforeEach(() => {
  getDb().run("DELETE FROM work_claims");
  getDb().run("DELETE FROM work_claim_events");
  fleet = new FakeFleet();
  for (const id of ["w1", "w2", "w3"]) fleet.add(id);
  claims = new WorkClaims(fleet);
});

test("a GitHub issue is one key whatever its host casing, fragment, query or issues/pull spelling", () => {
  const key = "github:acme/app#12";
  for (const s of ["https://github.com/acme/app/issues/12", "https://GitHub.com/Acme/App/pull/12/", "http://github.com/acme/APP/issues/12?x=1#issuecomment-9", "acme/app#12"])
    expect(canonicalSource(s).key).toBe(key);
  expect(canonicalSource("https://Example.com/t?b=2&a=1#x").key).toBe("https://example.com/t?a=1&b=2");
  expect(canonicalSource("env:Acme/App:Production").key).toBe("env:acme/app:production");
  expect(() => canonicalSource("https://user:pw@github.com/acme/app/issues/1")).toThrow("credentials");
});

test("one holder per key, and a claim of several sources takes all of them or none", async () => {
  const [a] = await claims.claim(vulcan, { sources: ["https://github.com/acme/app/issues/1"] }, T);
  expect(a).toMatchObject({ key: "github:acme/app#1", scope: "work", fence: 1, state: "active", holder: vulcan, leaseUntil: T + LEASE_MS });
  // The holder too: a second claim of a held key is refused, whoever asks.
  await expect(claims.claim(vulcan, { sources: ["acme/app#1"] }, T)).rejects.toMatchObject({ status: 409, detail: { key: "github:acme/app#1", holder: vulcan, state: "active" } });
  await expect(claims.claim(other, { sources: ["acme/app#2", "https://github.com/ACME/app/pull/1"] }, T)).rejects.toMatchObject({ status: 409 });
  // #2 came first in that claim and was not taken on the way to the refusal.
  expect(await claims.list({ key: "acme/app#2" }, T)).toEqual([]);
  // The same key in another scope is another lock.
  expect((await claims.claim(other, { sources: ["env:acme/app:prod"] }, T))[0]!.scope).toBe("env");
  await expect(claims.claim(vulcan, { sources: ["env:ACME/app:Prod"] }, T)).rejects.toMatchObject({ status: 409 });
});

test("every change after the claim must give the current fence, and only the holder frees a key", async () => {
  const [a] = await claims.claim(vulcan, { sources: ["acme/app#1"] }, T);
  const b = await claims.attach(vulcan, { key: "acme/app#1", fence: a!.fence, session: "w1" }, T);
  expect(b.fence).toBe(a!.fence + 1);
  expect(b.holder).toEqual({ superagent: "vulcan", session: "w1" });
  await expect(claims.release(vulcan, { key: "acme/app#1", fence: a!.fence }, T)).rejects.toMatchObject({ status: 409 });
  await expect(claims.attach(vulcan, { key: "acme/app#1", fence: a!.fence, session: "w2" }, T)).rejects.toMatchObject({ status: 409 });
  await expect(claims.release(other, { key: "acme/app#1", fence: b.fence }, T)).rejects.toMatchObject({ status: 403 });
  await expect(claims.release(person, { key: "acme/app#1", fence: b.fence }, T)).rejects.toMatchObject({ status: 403 });
  await expect(claims.release({ superagent: null, session: "w2" }, { key: "acme/app#1", fence: b.fence }, T)).rejects.toMatchObject({ status: 403 });
  // A running holder session is not replaced by an attach.
  await expect(claims.attach(vulcan, { key: "acme/app#1", fence: b.fence, session: "w2" }, T)).rejects.toMatchObject({ status: 409 });
  // Its own session releases it, with the fence it has.
  expect((await claims.release({ superagent: null, session: "w1" }, { key: "acme/app#1", fence: b.fence }, T)).state).toBe("released");
  const [c] = await claims.claim(other, { sources: ["acme/app#1"] }, T);
  expect(c!.fence).toBeGreaterThan(b.fence);
});

test("core renews the lease while the holder session runs; past its end the claim is uncertain and still excludes", async () => {
  const [a] = await claims.claim(vulcan, { sources: ["acme/app#1", "acme/app#2"] }, T);
  await claims.attach(vulcan, { key: "acme/app#1", fence: a!.fence, session: "w1" }, T);
  await claims.tick(T + 60_000);
  const later = T + LEASE_MS + 30_000;
  await claims.tick(later);
  const [one, two] = await claims.list({ superagent: "vulcan" }, later);
  expect(one).toMatchObject({ key: "github:acme/app#1", state: "active", leaseUntil: later + LEASE_MS });
  // #2 has no session to renew it.
  expect(two).toMatchObject({ key: "github:acme/app#2", state: "uncertain" });
  fleet.list.find((s) => s.id === "w1")!.host = "none";
  fleet.list.find((s) => s.id === "w1")!.pid = null;
  const much = later + 10 * LEASE_MS;
  await claims.tick(much);
  expect((await claims.list({ key: "acme/app#1" }, much))[0]!.state).toBe("uncertain");
  await expect(claims.claim(other, { sources: ["acme/app#1"] }, much)).rejects.toMatchObject({ status: 409, detail: { state: "uncertain" } });
  await expect(claims.claim(other, { sources: ["acme/app#2"] }, much)).rejects.toMatchObject({ status: 409 });
});

test("a takeover stops the holder and moves the key only once the stop is proven", async () => {
  const [a] = await claims.claim(vulcan, { sources: ["acme/app#1"] }, T);
  const b = await claims.attach(vulcan, { key: "acme/app#1", fence: a!.fence, session: "w1" }, T);
  // A session hands over instead, and another superagent cannot take it.
  await expect(claims.takeover({ superagent: null, session: "w2" }, { key: "acme/app#1", to: "w2" }, T)).rejects.toMatchObject({ status: 403 });
  await expect(claims.takeover(other, { key: "acme/app#1" }, T)).rejects.toMatchObject({ status: 403 });

  fleet.stubborn.add("w1");
  await expect(claims.takeover(person, { key: "acme/app#1", to: "w2" }, T)).rejects.toMatchObject({ status: 409, detail: { state: "takeover_requested" } });
  expect(fleet.stops).toEqual(["w1"]);
  const asked = (await claims.list({ key: "acme/app#1" }, T))[0]!;
  expect(asked).toMatchObject({ state: "takeover_requested", fence: b.fence, holder: { superagent: "vulcan", session: "w1" } });
  await expect(claims.claim(other, { sources: ["acme/app#1"] }, T)).rejects.toMatchObject({ status: 409 });

  fleet.stubborn.clear();
  const moved = await claims.takeover(vulcan, { key: "acme/app#1", to: "w2" }, T);
  expect(moved).toMatchObject({ state: "active", fence: b.fence + 1, holder: { superagent: "vulcan", session: "w2" } });
  expect(fleet.list.find((s) => s.id === "w1")!.host).toBe("none");
  // The old holder's fence is stale now.
  await expect(claims.release({ superagent: null, session: "w1" }, { key: "acme/app#1", fence: b.fence }, T)).rejects.toMatchObject({ status: 403 });
  await expect(claims.release(vulcan, { key: "acme/app#1", fence: b.fence }, T)).rejects.toMatchObject({ status: 409 });
});

test("a handover moves the session's claims to its successor with a new fence", async () => {
  const [a, e] = await claims.claim({ superagent: null, session: "w1" }, { sources: ["acme/app#1", "acme/app#5"] }, T);
  await claims.claim({ superagent: null, session: "w3" }, { sources: ["acme/app#3"] }, T);
  expect(await claims.handOver("w1", "w2", T)).toBe(2);
  const mine = await claims.list({ session: "w2" }, T);
  expect(mine.map((c) => [c.key, c.fence])).toEqual([[a!.key, a!.fence + 1], [e!.key, e!.fence + 1]]);
  expect(await claims.list({ session: "w1" }, T)).toEqual([]);
  expect((await claims.list({ session: "w3" }, T))).toHaveLength(1);
});

test("a program is its superagent only with its own token", () => {
  getDb().run("INSERT OR IGNORE INTO superagents (name, dir, created_at) VALUES ('vulcan', '/x', 1)");
  const hub = { has: (n: string) => n === "vulcan" } as unknown as Superagents;
  const req = (h: Record<string, string>) => new Request("http://127.0.0.1/api/claims", { headers: h });
  const token = superagentToken("vulcan");
  expect(claimCaller(req({ "x-agentbox-superagent": "vulcan", "x-agentbox-superagent-token": token }), hub)).toEqual({ superagent: "vulcan", session: null });
  expect(() => claimCaller(req({ "x-agentbox-superagent": "vulcan", "x-agentbox-superagent-token": "0".repeat(64) }), hub)).toThrow("does not prove vulcan");
  expect(() => claimCaller(req({ "x-agentbox-superagent": "vulcan" }), hub)).toThrow("does not prove vulcan");
  expect(() => claimCaller(req({ "x-agentbox-superagent": "steward", "x-agentbox-superagent-token": token }), hub)).toThrow("no superagent steward");
  expect(() => claimCaller(req({ "x-agentbox-superagent": "../vulcan", "x-agentbox-superagent-token": token }), hub)).toThrow("no superagent");
  expect(claimCaller(req({}), hub)).toEqual({ superagent: null, session: null });
});

test("an environment is held in one scope only, and a key held in one backend is refused in another", async () => {
  await expect(claims.claim(vulcan, { sources: ["env:acme/app:prod", "acme/app#1"] }, T)).rejects.toThrow("separate calls");
  await expect(claims.claim(vulcan, { sources: ["env:acme/app:prod"], scope: "work" }, T)).rejects.toThrow("scope env");
  expect((await claims.claim(vulcan, { sources: ["env:Acme/App:PROD"] }, T))[0]!.scope).toBe("env");
  // A second backend (a shared instance's, in the cloud) sees what box.db holds.
  const local = claims.local;
  const cloud = { ...local, get: async () => null, claim: async () => [] } as unknown as typeof local;
  claims.backends.push(cloud);
  claims.backendOf = (s) => (s === "steward" ? cloud : local);
  await expect(claims.claim(other, { sources: ["env:acme/app:prod"] }, T)).rejects.toThrow("is held");
});
