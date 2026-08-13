import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contentTypeFor, notBuiltPage, resolveStatic, safeStaticPath } from "../static";

const tmp = mkdtempSync(join(tmpdir(), "agentbox-static-"));
const dist = join(tmp, "web", "dist");
mkdirSync(join(dist, "assets"), { recursive: true });
writeFileSync(join(dist, "index.html"), "<html>app</html>");
writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
// The sibling that the old `startsWith(webDist)` guard let through.
writeFileSync(join(tmp, "web", "dist-secrets.txt"), "secret");

const empty = join(tmp, "empty-dist");
mkdirSync(empty, { recursive: true });

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("safeStaticPath", () => {
  test("resolves a normal path inside the root", () => {
    expect(safeStaticPath(dist, "/assets/app.js")).toBe(resolve(dist, "assets/app.js"));
  });

  test("rejects a traversal", () => {
    expect(safeStaticPath(dist, "/../dist-secrets.txt")).toBeNull();
    expect(safeStaticPath(dist, "/assets/../../../etc/passwd")).toBeNull();
  });

  // The old guard compared after join(), so a sibling directory sharing the
  // root's prefix passed startsWith().
  test("rejects a sibling whose name merely starts with the root", () => {
    expect(safeStaticPath(dist, "/../dist-secrets.txt")).toBeNull();
    expect(safeStaticPath(join(tmp, "web", "dist"), "/..%2Fdist-secrets.txt")).toBeNull();
  });

  test("rejects percent-encoded traversal", () => {
    expect(safeStaticPath(dist, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
    expect(safeStaticPath(dist, "/..%2f..%2fetc%2fpasswd")).toBeNull();
  });

  test("rejects malformed percent-encoding and null bytes", () => {
    expect(safeStaticPath(dist, "/%zz")).toBeNull();
    expect(safeStaticPath(dist, "/app%00.js")).toBeNull();
  });

  test("a trailing separator on the root does not change the answer", () => {
    expect(safeStaticPath(dist + "/", "/assets/app.js")).toBe(resolve(dist, "assets/app.js"));
    expect(safeStaticPath(dist + "/", "/../dist-secrets.txt")).toBeNull();
  });
});

describe("resolveStatic", () => {
  test("serves an existing asset", () => {
    expect(resolveStatic(dist, "/assets/app.js")).toEqual({
      kind: "file",
      path: resolve(dist, "assets/app.js"),
    });
  });

  test("serves index.html at the root", () => {
    expect(resolveStatic(dist, "/")).toEqual({ kind: "file", path: resolve(dist, "index.html") });
  });

  test("an extensionless path falls back to index.html for client-side routing", () => {
    expect(resolveStatic(dist, "/sessions/abc")).toEqual({
      kind: "file",
      path: resolve(dist, "index.html"),
    });
  });

  // Returning index.html for a missing bundle turns a build error into a
  // baffling MIME-type error in the browser console.
  test("a missing asset 404s rather than returning HTML", () => {
    expect(resolveStatic(dist, "/assets/missing.js")).toEqual({ kind: "notFound" });
  });

  test("a traversal 404s", () => {
    expect(resolveStatic(dist, "/../dist-secrets.txt")).toEqual({ kind: "notFound" });
  });

  test("an unbuilt UI is reported as such, not as a missing file", () => {
    expect(resolveStatic(empty, "/")).toEqual({ kind: "notBuilt" });
    expect(resolveStatic(join(tmp, "does-not-exist"), "/")).toEqual({ kind: "notBuilt" });
  });
});

describe("responses", () => {
  test("the not-built page is HTML with a non-200 status and the build command", async () => {
    const res = notBuiltPage();
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("bun run web:build");
  });

  test("content types cover the bundle's file kinds", () => {
    expect(contentTypeFor("/x/index.html")).toContain("text/html");
    expect(contentTypeFor("/x/app.js")).toContain("javascript");
    expect(contentTypeFor("/x/app.css")).toContain("text/css");
    expect(contentTypeFor("/x/logo.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("/x/unknown.bin")).toBe("application/octet-stream");
  });
});
