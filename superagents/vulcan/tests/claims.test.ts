import { afterEach, beforeEach, expect, test } from "bun:test";
import { action } from "../lib/actions";
import { enforceAuthority, revokeGrant } from "../lib/grants";
import { adoptLegacyClaims, startWork, stopWork } from "../lib/work";
import { family, MAIN, world, type World } from "./harness";

let w: World;
beforeEach(() => (w = world()));
afterEach(() => w.box.stop());

test("one writer per issue: a second family on a claimed issue is told to extend the first, and claims nothing", async () => {
  const a = await startWork(w.ctx, MAIN, family(w.grant.id, [1, 2]));
  expect(a.state).toBe("working");
  expect(a.session).toBe("s2");
  expect(w.box.starts).toHaveLength(1);
  expect(w.box.starts[0]).toMatchObject({ provider: "codex", branch: a.branch, parent: MAIN });
  expect(String(w.box.starts[0]!.prompt)).toContain("superagent call vulcan review");
  // Both issues are claimed in agentbox, in one call, and the writer holds them from its start.
  expect(w.box.workClaims.get("github:acme/app#1")).toMatchObject({ fence: 2, holder: { superagent: "vulcan", session: "s2" } });
  expect(a.claims).toEqual([{ key: "github:acme/app#1", fence: 2 }, { key: "github:acme/app#2", fence: 2 }]);

  const b = family(w.grant.id, [3, 2]);
  await expect(startWork(w.ctx, MAIN, b)).rejects.toThrow(`Issue already belongs to work family ${a.id}; extend that family`);
  // Every issue or none: #3 was not claimed on the way to the refusal, and no writer was started.
  expect(w.box.workClaims.has("github:acme/app#3")).toBe(false);
  expect(w.ctx.store.works()).toHaveLength(1);
  expect(w.box.starts).toHaveLength(1);

  const c = await startWork(w.ctx, MAIN, family(w.grant.id, [3]));
  expect(c.id).not.toBe(a.id);
  expect(w.box.starts).toHaveLength(2);
});

test("a stopped family frees its issues for another family", async () => {
  const a = await startWork(w.ctx, MAIN, family(w.grant.id, [1]));
  const caller = { session: null, via: "app" as const };
  await action(w.ctx, { action: "work-stop", values: { id: a.id }, tab: null, caller });
  expect(w.box.stops).toEqual(["s2"]);
  expect(w.box.workClaims.get("github:acme/app#1")!.state).toBe("released");
  expect(w.ctx.store.work(a.id).claims).toEqual([]);
  const b = await startWork(w.ctx, MAIN, family(w.grant.id, [1]));
  expect(w.box.workClaims.get("github:acme/app#1")).toMatchObject({ state: "active", holder: { session: b.session } });
});

test("a family is idempotent by id and its id is never reused for another input", async () => {
  const input = family(w.grant.id, [1]);
  const a = await startWork(w.ctx, MAIN, input);
  expect(await startWork(w.ctx, MAIN, input)).toEqual(a);
  expect(w.box.starts).toHaveLength(1);
  await expect(startWork(w.ctx, MAIN, { ...family(w.grant.id, [2]), id: input.id })).rejects.toThrow("Work ID already used");
});

test("only the grant's requester starts work, on real open issues of the project", async () => {
  await expect(startWork(w.ctx, "someone", family(w.grant.id, [1]))).rejects.toThrow("belongs to another coordinator");
  await expect(startWork(w.ctx, null, family(w.grant.id, [1]))).rejects.toThrow("belongs to another coordinator");
  w.gh.issues.set(1, { state: "closed" });
  await expect(startWork(w.ctx, MAIN, family(w.grant.id, [1]))).rejects.toThrow("real open issues");
  w.gh.issues.set(1, { state: "open", pull_request: {} });
  await expect(startWork(w.ctx, MAIN, family(w.grant.id, [1]))).rejects.toThrow("real open issues");
  const other = family(w.grant.id, [1]);
  other.issues[0]!.source = "https://github.com/other/repo/issues/1";
  await expect(startWork(w.ctx, MAIN, other)).rejects.toThrow("distinct canonical issue in this project");
  expect(w.box.starts).toHaveLength(0);
});

test("a start whose answer was lost is found again, never asked twice", async () => {
  const input = family(w.grant.id, [1]);
  // The first POST lands but its answer is lost.
  const url = process.env.AGENTBOX_URL;
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (req: string | URL | Request, init?: RequestInit) => {
    const res = await realFetch(req, init);
    if (String(req).endsWith("/api/sessions") && init?.method === "POST" && calls++ === 0) throw new Error("socket hang up");
    return res;
  }) as typeof fetch;
  try {
    await expect(startWork(w.ctx, MAIN, input)).rejects.toThrow("socket hang up");
  } finally {
    globalThis.fetch = realFetch;
    process.env.AGENTBOX_URL = url;
  }
  const after = w.ctx.store.work(input.id);
  expect(after.state).toBe("uncertain");
  expect(w.box.sessions.filter((s) => s.branch === after.branch)).toHaveLength(1);
  const { retryStart } = await import("../lib/work");
  const fixed = await retryStart(w.ctx, input.id, MAIN);
  expect(fixed.state).toBe("working");
  expect(fixed.session).toBe("s2");
  expect(w.box.starts).toHaveLength(1);
  // The writer it found holds the issue now.
  expect(w.box.workClaims.get("github:acme/app#1")!.holder.session).toBe("s2");
});

/** The next `times` calls of the claims routes land in agentbox, but their answers are lost. */
async function loseAnswer<T>(times: number, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  let lost = 0;
  globalThis.fetch = (async (req: string | URL | Request, init?: RequestInit) => {
    const res = await realFetch(req, init);
    if (lost < times && String(req).includes("/api/claims")) {
      lost++;
      throw new Error("socket hang up");
    }
    return res;
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a claim whose answer was lost is read back by its note at once: one claim, one writer", async () => {
  const a = await loseAnswer(1, () => startWork(w.ctx, MAIN, family(w.grant.id, [1])));
  expect(a.claiming).toBeUndefined();
  expect(a.claims).toEqual([{ key: "github:acme/app#1", fence: 2 }]);
  expect(w.box.starts).toHaveLength(1);
});

test("a claim whose answer and read-back were lost is adopted on the retry: one claim, one writer", async () => {
  const input = family(w.grant.id, [1]);
  // The claim lands; its answer and the read back of the claims are both lost.
  await expect(loseAnswer(2, () => startWork(w.ctx, MAIN, input))).rejects.toThrow("socket hang up");
  // The family was recorded before its claim, and agentbox holds the issue for it.
  expect(w.ctx.store.work(input.id)).toMatchObject({ claiming: true, state: "starting" });
  expect(w.box.workClaims.get("github:acme/app#1")).toMatchObject({ fence: 1, note: `Vulcan work ${input.id}`, holder: { superagent: "vulcan", session: null } });
  expect(w.box.starts).toHaveLength(0);

  // Another family on the issue is told which family has it.
  await expect(startWork(w.ctx, MAIN, family(w.grant.id, [1]))).rejects.toThrow(`Issue already belongs to work family ${input.id}`);
  expect(w.ctx.store.works()).toHaveLength(1);

  // The retry gets 409 held by Vulcan, adopts the claim, and starts the one writer.
  const a = await startWork(w.ctx, MAIN, input);
  expect(a.claiming).toBeUndefined();
  expect(a.session).toBe("s2");
  expect(w.box.starts).toHaveLength(1);
  expect(w.box.workClaims.get("github:acme/app#1")).toMatchObject({ fence: 2, holder: { superagent: "vulcan", session: "s2" } });
  expect(a.claims).toEqual([{ key: "github:acme/app#1", fence: 2 }]);
});

test("a family stopped while its claim answer is lost frees the claim it never saw", async () => {
  const input = family(w.grant.id, [1]);
  await expect(loseAnswer(2, () => startWork(w.ctx, MAIN, input))).rejects.toThrow("socket hang up");
  await action(w.ctx, { action: "work-stop", values: { id: input.id }, tab: null, caller: { session: null, via: "app" as const } });
  expect(w.box.workClaims.get("github:acme/app#1")!.state).toBe("released");
  expect(w.ctx.store.work(input.id).claims).toEqual([]);
  expect(w.ctx.store.work(input.id).claiming).toBeUndefined();
  // A retry of the stopped family starts nothing.
  await startWork(w.ctx, MAIN, input);
  expect(w.box.starts).toHaveLength(0);
});

test("a legacy claim whose answer was lost is adopted on the next start, never claimed twice", async () => {
  const a = await startWork(w.ctx, MAIN, family(w.grant.id, [1]));
  // As before agentbox kept claims: the family has none there, and the old table has its issue.
  w.box.workClaims.clear();
  w.ctx.store.saveWork({ ...w.ctx.store.work(a.id), claims: undefined });
  w.ctx.store.db.run("INSERT INTO issue_claims (source, work) VALUES (?, ?)", ["github:acme/app#1", a.id]);
  await loseAnswer(2, () => adoptLegacyClaims(w.ctx));
  expect(w.ctx.store.legacyClaims().size).toBe(1);
  expect(w.box.workClaims.get("github:acme/app#1")).toMatchObject({ fence: 1, holder: { session: "s2" } });

  await adoptLegacyClaims(w.ctx);
  expect(w.ctx.store.legacyClaims().size).toBe(0);
  expect(w.ctx.store.work(a.id).claims).toEqual([{ key: "github:acme/app#1", fence: 1 }]);
  expect(w.box.workClaims.get("github:acme/app#1")!.fence).toBe(1);
});

test("after a handover of the writer, Vulcan releases with the fence the claim has now", async () => {
  const a = await startWork(w.ctx, MAIN, family(w.grant.id, [1]));
  w.box.moveClaim("github:acme/app#1", { superagent: "vulcan", session: "s9" });
  await stopWork(w.ctx, a.id);
  expect(w.box.workClaims.get("github:acme/app#1")!.state).toBe("released");
  expect(w.ctx.store.work(a.id).claims).toEqual([]);
  expect(w.ctx.store.work(a.id).notes).toBeUndefined();
});

test("after a person's takeover, the claim is not Vulcan's to release: Vulcan forgets it and notes it", async () => {
  const a = await startWork(w.ctx, MAIN, family(w.grant.id, [1]));
  w.box.moveClaim("github:acme/app#1", { superagent: null, session: "p1" });
  revokeGrant(w.ctx, w.grant.id);
  await enforceAuthority(w.ctx);
  expect(w.box.workClaims.get("github:acme/app#1")).toMatchObject({ state: "active", holder: { superagent: null, session: "p1" } });
  const after = w.ctx.store.work(a.id);
  expect(after.claims).toEqual([]);
  expect(after.notes).toEqual(["Vulcan no longer holds github:acme/app#1: a person (session p1) holds it now, so Vulcan does not release it."]);
  // The next tick has nothing left to release.
  const saved = JSON.stringify(after);
  await enforceAuthority(w.ctx);
  expect(JSON.stringify(w.ctx.store.work(a.id))).toBe(saved);
});
