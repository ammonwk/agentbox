import { describe, expect, test } from "bun:test";
import { RECOMMENDED_MODELS, fetchGoModelIds, goOptions, modelCatalog } from "../models";
import { DEFAULT_MODEL } from "../paths";

/** Go's /models as it answered on 2026-09-10, trimmed to the cases that matter. */
const GO_IDS = [
  "minimax-m3",
  "deepseek-v4-flash",
  "deepseek-flash",
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
  "glm-5.3-flash",
];
const goBody = { object: "list", data: GO_IDS.map((id) => ({ id, object: "model", owned_by: "opencode" })) };

const answering = (body: unknown, status = 200) => async () =>
  new Response(JSON.stringify(body), { status });

describe("goOptions", () => {
  test("offers Go's ids as opencode-go selectors, sorted", () => {
    expect(goOptions(["minimax-m3", "glm-5.3-flash", "glm-5.3-flash"])).toEqual([
      { id: "opencode-go/glm-5.3-flash" },
      { id: "opencode-go/minimax-m3" },
    ]);
  });

  test("a recommended model is not listed a second time", () => {
    const ids = goOptions(GO_IDS).map((m) => m.id);
    expect(ids).not.toContain("opencode-go/deepseek-flash");
    expect(ids).toContain("opencode-go/deepseek-v4-flash");
  });

  // Picked from the list, `opencode-go/muse-spark-*` would start a session that
  // never answers: Go returns a 500 on chat/completions and omp retries it forever.
  test("Muse Spark is left out, since it only runs through its Responses provider", () => {
    expect(goOptions(GO_IDS).some((m) => m.id.includes("muse-spark"))).toBe(false);
  });
});

describe("the recommended list", () => {
  test("includes the default, so the dropdown opens on a named entry", () => {
    expect(RECOMMENDED_MODELS.map((m) => m.id)).toContain(DEFAULT_MODEL);
  });
});

describe("fetchGoModelIds", () => {
  test("reads the ids out of an OpenAI-style list", async () => {
    expect(await fetchGoModelIds(answering(goBody))).toEqual(GO_IDS);
  });

  test("a non-2xx is an error, not an empty list", async () => {
    await expect(fetchGoModelIds(answering({ error: "nope" }, 503))).rejects.toThrow("503");
  });

  test("a body without a list is an error", async () => {
    await expect(fetchGoModelIds(answering({ object: "list" }))).rejects.toThrow("no model list");
  });
});

describe("modelCatalog", () => {
  test("a failed fetch still returns the recommended models, and says why", async () => {
    const catalog = await modelCatalog(async () => {
      throw new Error("fetch failed");
    });
    expect(catalog.recommended).toEqual([...RECOMMENDED_MODELS]);
    expect(catalog.go).toEqual([]);
    expect(catalog.goError).toBe("fetch failed");
  });
});
