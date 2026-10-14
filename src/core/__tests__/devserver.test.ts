import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { depDirs, devCommand, linkDeps, urlFromLog } from "../devserver";
import type { Repo } from "../types";

const repo = (dev = ""): Repo =>
  ({ id: "r", ref: "/x", kind: "local", displayName: "x", fullName: null, defaultBranch: "main", addedAt: 0, worktreeDefault: null, setup: { copy: [], run: "", dev } }) as Repo;

describe("dev server", () => {
  test("links each node_modules the branch has a package for, and leaves the rest", () => {
    const root = mkdtempSync(join(tmpdir(), "ab-dev-"));
    const src = join(root, "src");
    const wt = join(root, "wt");
    for (const d of ["node_modules/a", "node_modules/b/node_modules", "web/node_modules", "gone/node_modules", "kept/node_modules"]) mkdirSync(join(src, d), { recursive: true });
    for (const d of ["web", "kept/node_modules"]) mkdirSync(join(wt, d), { recursive: true });

    expect(depDirs(src)).toEqual(["gone/node_modules", "kept/node_modules", "node_modules", "web/node_modules"]);
    expect(linkDeps(src, wt)).toEqual([
      "not linked, not on this branch: gone/node_modules",
      "not linked, already there: kept/node_modules",
      "linked node_modules",
      "linked web/node_modules",
    ]);
    expect(readlinkSync(join(wt, "web/node_modules"))).toBe(join(src, "web/node_modules"));
  });

  test("runs the Settings command, else the dev script with the lockfile's package manager", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-dev-"));
    expect(devCommand(repo(), dir)).toBeNull();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    expect(devCommand(repo(), dir)).toBe("npm run dev");
    writeFileSync(join(dir, "bun.lock"), "");
    expect(devCommand(repo(), dir)).toBe("bun run dev");
    expect(devCommand(repo("make serve"), dir)).toBe("make serve");
  });

  test("reads the URL a server prints, through Vite's colour", () => {
    expect(urlFromLog("  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5174\x1b[22m/\x1b[39m\n")).toBe("http://localhost:5174/");
    expect(urlFromLog("ready - started server on 0.0.0.0:3000, url: http://0.0.0.0:3000")).toBe("http://localhost:3000");
    expect(urlFromLog("compiling…")).toBeNull();
  });
});
