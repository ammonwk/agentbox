import { expect, test } from "bun:test";
import { PostHog, sampleOf } from "../lib/source";

test("PostHog: one HogQL query per read, values passed as values, rows read into crashes", async () => {
  const asked: { url: string; auth: string | null; body: { query: { kind: string; query: string; values: Record<string, unknown> } } }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    asked.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    const list = JSON.stringify([{ type: "TypeError", value: "x is undefined", stacktrace: { frames: [{ filename: "src/a.ts", function: "go", lineno: 3, in_app: true }] } }]);
    return new Response(JSON.stringify({ results: asked.length === 1 ? [["issue-1", 7, "2026-10-15T01:00:00Z", "2026-10-15T02:00:00Z", list, "https://app.example/x?token=secret", "web"]] : [[0, "1970-01-01T00:00:00Z"]] }));
  }) as unknown as typeof fetch;
  const ph = new PostHog("https://us.posthog.com/", "42", "phx_test", fetcher);
  const [c] = await ph.recent(24, 50);
  expect(asked[0]!.url).toBe("https://us.posthog.com/api/projects/42/query/");
  expect(asked[0]!.auth).toBe("Bearer phx_test");
  expect(asked[0]!.body.query).toMatchObject({ kind: "HogQLQuery", values: { hours: 24, limit: 50 } });
  expect(c).toEqual({ key: "issue-1", count: 7, first: Date.parse("2026-10-15T01:00:00Z"), last: Date.parse("2026-10-15T02:00:00Z"), sample: { type: "TypeError", value: "x is undefined", frames: [{ file: "src/a.ts", fn: "go", line: 3, inApp: true }], url: "https://app.example/x", lib: "web" } });
  // A key goes in as a value, never spliced into the query.
  expect(await ph.count("it's", 1, 2)).toEqual({ count: 0, last: null });
  expect(asked[1]!.body.query.query).not.toContain("it's");
  expect(asked[1]!.body.query.values).toEqual({ key: "it's", since: 1, until: 2 });
  expect(ph.link("issue-1")).toBe("https://us.posthog.com/project/42/error_tracking/issue-1");
});

test("PostHog: a refusal is an error with PostHog's reason", async () => {
  const fetcher = (async () => new Response(JSON.stringify({ detail: "API key missing required scope 'query:read'" }), { status: 403 })) as unknown as typeof fetch;
  await expect(new PostHog("https://us.posthog.com", "42", "k", fetcher).recent(24, 10)).rejects.toThrow("PostHog answered 403: API key missing required scope 'query:read'");
});

test("sampleOf reads what it can and never throws", () => {
  expect(sampleOf("not json", null, null)).toBeNull();
  expect(sampleOf([], null, null)).toBeNull();
  expect(sampleOf([{ value: "v" }], 3, null)).toEqual({ type: "Error", value: "v", frames: [], url: null, lib: null });
});
