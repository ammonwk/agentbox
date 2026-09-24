import { describe, expect, test } from "bun:test";
import { hrefOf, navOf, parseHash, type Route } from "./route";
import { healthRows } from "./api";
import { composerMode } from "./views/session/Composer";
import { accountHue } from "./bits";

describe("routing", () => {
  test("reads every page and a session deep link", () => {
    expect(parseHash("#/sessions")).toEqual({ page: "sessions" });
    expect(parseHash("#/s/abc1")).toEqual({ page: "session", id: "abc1", tab: "terminal" });
    expect(parseHash("#/s/abc1/timeline")).toEqual({ page: "session", id: "abc1", tab: "timeline" });
    expect(parseHash("#/accounts")).toEqual({ page: "accounts", sub: "accounts" });
    expect(parseHash("#/accounts/calibration")).toEqual({ page: "accounts", sub: "calibration" });
    expect(parseHash("#/skills")).toEqual({ page: "skills" });
    expect(parseHash("#/settings")).toEqual({ page: "settings" });
  });

  test("anything unrecognised lands on the board", () => {
    for (const h of ["", "#", "#/", "#/nope", "#/s", "#/inbox"]) expect(parseHash(h).page).toBe("sessions");
  });

  test("an unknown tab falls back to the terminal", () => {
    expect(parseHash("#/s/x/bogus")).toEqual({ page: "session", id: "x", tab: "terminal" });
  });

  test("round-trips, including ids needing escaping", () => {
    const routes: Route[] = [
      { page: "sessions" },
      { page: "session", id: "a b/c", tab: "diff" },
      { page: "session", id: "x", tab: "terminal" },
      { page: "accounts", sub: "calibration" },
      { page: "settings" },
    ];
    for (const r of routes) expect(parseHash(hrefOf(r))).toEqual(r);
  });

  test("a malformed escape does not throw", () => {
    expect(parseHash("#/s/%E0%A4%A")).toEqual({ page: "session", id: "%E0%A4%A", tab: "terminal" });
  });

  test("a session lights up the Sessions rail entry", () => {
    expect(navOf({ page: "session", id: "x", tab: "load" })).toBe("sessions");
  });
});

describe("composer", () => {
  test("only a session in our tmux can be typed into; stopped resumes; external adopts", () => {
    expect(composerMode({ host: "tmux", status: "blocked" }).kind).toBe("send");
    expect(composerMode({ host: "none", status: "stopped" }).kind).toBe("resume");
    expect(composerMode({ host: "none", status: "archived" }).kind).toBe("resume");
    expect(composerMode({ host: "external", status: "running" }).kind).toBe("adopt");
  });
});

describe("health", () => {
  test("reads every dependency-shaped key, including nested providers, and ignores the rest", () => {
    const rows = healthRows({
      git: { state: "ok", detail: "2.51" },
      gh: { state: "unusable", detail: "logged out" },
      providers: { claude: { state: "missing", detail: null } },
      at: 123,
      version: "2.0.0",
    });
    expect(rows).toEqual([
      { name: "git", state: "ok", detail: "2.51" },
      { name: "gh", state: "unusable", detail: "logged out" },
      { name: "claude", state: "missing", detail: null },
    ]);
  });
});

describe("account colours", () => {
  test("slots follow age, so a new account never recolours the old ones", () => {
    const a = [
      { id: "new", createdAt: 30 },
      { id: "old", createdAt: 10 },
    ];
    expect(accountHue("old", a)).toBe(0);
    expect(accountHue("new", a)).toBe(1);
    expect(accountHue("old", [...a, { id: "newer", createdAt: 40 }])).toBe(0);
    expect(accountHue(null, a)).toBe(-1);
    const h = accountHue("ghost", a);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(8);
  });
});
