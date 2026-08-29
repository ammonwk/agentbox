import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  containedIn,
  describePlace,
  foreignRepoPaths,
  outsidePaths,
  renderPlace,
  shortPlace,
} from "../place";

const made: string[] = [];

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "agentbox-place-"));
  made.push(d);
  return d;
}

function repo(branch = "main"): string {
  const d = dir();
  Bun.spawnSync(["git", "init", "-q", "-b", branch, d]);
  return d;
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("describing a place", () => {
  test("names the work tree and the branch", () => {
    const r = repo("fix/denominators");
    const p = describePlace(r);
    expect(p.branch).toBe("fix/denominators");
    expect(p.toplevel).not.toBeNull();
    expect(renderPlace(p)).toContain("fix/denominators");
    expect(renderPlace(p)).toContain(r);
    expect(shortPlace(p)).toEndWith("@fix/denominators");
  });

  test("says so plainly when there is no repository, rather than guessing", () => {
    const p = describePlace(dir());
    expect(p.toplevel).toBeNull();
    expect(p.branch).toBeNull();
    expect(renderPlace(p)).toContain("not a git repository");
  });

  test("dirtiness is opt-in, because it is the expensive half", () => {
    const r = repo();
    expect(describePlace(r).dirty).toBeNull();
    writeFileSync(join(r, "a.ts"), "export {};\n");
    Bun.spawnSync(["git", "-C", r, "add", "a.ts"]);
    expect(describePlace(r, { dirty: true }).dirty).toBe(true);
  });
});

describe("finding paths that belong somewhere else", () => {
  test("a file in another work tree is foreign; one in this tree is not", () => {
    const here = repo();
    const there = repo();
    writeFileSync(join(here, "mine.ts"), "export {};\n");
    writeFileSync(join(there, "theirs.ts"), "export {};\n");
    const found = foreignRepoPaths(
      `Clean ${join(here, "mine.ts")} and ${join(there, "theirs.ts")}`,
      here,
    );
    expect(found.map((f) => f.path)).toEqual([join(there, "theirs.ts")]);
  });

  test("one example per foreign tree — thirty files from one checkout is one mistake", () => {
    const here = repo();
    const there = repo();
    for (const n of ["a", "b", "c"]) writeFileSync(join(there, `${n}.ts`), "export {};\n");
    const prompt = ["a", "b", "c"].map((n) => join(there, `${n}.ts`)).join(" and ");
    expect(foreignRepoPaths(prompt, here)).toHaveLength(1);
  });

  test("paths that are in no repository cannot trip it", () => {
    const here = repo();
    const loose = dir();
    writeFileSync(join(loose, "notes.md"), "hello\n");
    expect(foreignRepoPaths(`See ${join(loose, "notes.md")} and /usr/bin`, here)).toEqual([]);
  });

  test("a path that does not exist is not evidence of anything", () => {
    const here = repo();
    expect(foreignRepoPaths("Read /home/nobody/project/src/x.ts", here)).toEqual([]);
  });

  test("a URL is not a path", () => {
    const here = repo();
    expect(foreignRepoPaths("See https://example.com/repo/src/x.ts", here)).toEqual([]);
  });
});

describe("finding paths outside the working directory", () => {
  test("catches a write into somebody's home; ignores one into scratch", () => {
    const here = repo();
    const outside = dir();
    const stray = join(outside, "x.ts");
    writeFileSync(stray, "export {};\n");
    // `here` is under the temp dir too, so the scratch exclusion is off: the
    // agent lives in scratch and has no "elsewhere" to be excused for.
    expect(outsidePaths(`edited ${stray}`, here)).toEqual([stray]);
    expect(outsidePaths(`edited ${join(here, "x.ts")}`, here)).toEqual([]);
  });
});

describe("containment", () => {
  test("a sibling with a shared prefix is not inside", () => {
    expect(containedIn("/a/bcd", ["/a/bc"])).toBeNull();
  });

  test("a symlink pointing out of the root does not sneak in", () => {
    const root = dir();
    const outside = dir();
    const target = join(outside, "secret");
    writeFileSync(target, "s\n");
    const link = join(root, "link");
    symlinkSync(target, link);
    expect(containedIn(link, [root])).toBeNull();
  });

  test("a null byte is refused rather than truncated", () => {
    expect(containedIn("/a/b\0/c", ["/a"])).toBeNull();
  });
});
