import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkills, parseFrontmatterForTest as parseFrontmatter } from "../skills";
import { useTempHome } from "./tmp-home";

/**
 * The bug these pin: reading only the rest of the `description:` line captures
 * a block scalar's *indicator*, so a folded description rendered as a bare `>`
 * and its prose was discarded. Nine of eleven real skills on the author's
 * machine were affected, and nothing errored — the field was simply wrong.
 */
describe("parseFrontmatter", () => {
  const wrap = (body: string) => `---\n${body}\n---\nbody text here`;

  test("reads a plain inline scalar", () => {
    const fm = parseFrontmatter(wrap("name: thing\ndescription: A short one."));
    expect(fm.name).toBe("thing");
    expect(fm.description).toBe("A short one.");
  });

  test("strips surrounding quotes", () => {
    expect(parseFrontmatter(wrap(`description: "quoted"`)).description).toBe("quoted");
  });

  test("folds a `>` block into one paragraph", () => {
    const fm = parseFrontmatter(
      wrap("name: folded\ndescription: >\n  Remove signs of AI writing.\n  Use when editing text.")
    );
    expect(fm.description).toBe("Remove signs of AI writing. Use when editing text.");
  });

  test("keeps newlines in a `|` block", () => {
    const fm = parseFrontmatter(wrap("description: |\n  line one\n  line two"));
    expect(fm.description).toBe("line one\nline two");
  });

  test("handles chomping indicators", () => {
    for (const ind of ["|-", ">-", "|+", ">+"]) {
      const fm = parseFrontmatter(wrap(`description: ${ind}\n  some text`));
      expect(fm.description).toBe("some text");
    }
  });

  test("a blank line inside a folded block is a paragraph break", () => {
    const fm = parseFrontmatter(wrap("description: >\n  first para\n\n  second para"));
    expect(fm.description).toBe("first para\n\nsecond para");
  });

  test("the block ends at the next unindented key", () => {
    const fm = parseFrontmatter(wrap("description: |\n  the description\nname: after"));
    expect(fm.description).toBe("the description");
    expect(fm.name).toBe("after");
  });

  test("never yields a bare indicator — the original defect", () => {
    for (const ind of ["|", ">", "|-", ">-"]) {
      const fm = parseFrontmatter(wrap(`description: ${ind}\n  real prose`));
      expect(fm.description).not.toBe(ind);
      expect(fm.description).toBe("real prose");
    }
  });

  test("returns nothing when there is no frontmatter", () => {
    expect(parseFrontmatter("# Just a heading")).toEqual({});
  });

  describe("CRLF files", () => {
    // `search-chats/SKILL.md` on this machine is CRLF. `\r` is a line
    // terminator to a JS regex, so `.` never matches it: the key line failed to
    // match at all and the file parsed as having *no* frontmatter — the name
    // silently fell back to the directory name and the description to "". The
    // second failure was subtler: once the key matched, `\r` rode along inside
    // the block body and came back out in the middle of the description.
    const crlf = (body: string) => `---\r\n${body.replace(/\n/g, "\r\n")}\r\n---\r\nbody`;

    test("a CRLF file's frontmatter is read at all", () => {
      const fm = parseFrontmatter(crlf("name: search-chats\ndescription: A short one."));
      expect(fm.name).toBe("search-chats");
      expect(fm.description).toBe("A short one.");
    });

    test("no carriage return survives into a block scalar's value", () => {
      const fm = parseFrontmatter(crlf("description: |\n  line one\n  line two"));
      expect(fm.description).toBe("line one\nline two");
      expect(fm.description).not.toContain("\r");
    });

    test("a CRLF folded block folds on spaces, not on stray returns", () => {
      const fm = parseFrontmatter(crlf("description: >\n  first half\n  second half"));
      expect(fm.description).toBe("first half second half");
    });

    test("CR-only line endings parse the same", () => {
      const cr = "---\rname: old-mac\rdescription: Still readable.\r---\rbody";
      expect(parseFrontmatter(cr)).toEqual({ name: "old-mac", description: "Still readable." });
    });
  });
});

/**
 * Root resolution, against a real filesystem: which copy of a duplicated skill
 * wins, and whether a symlinked skill directory is seen at all. Both were wrong
 * in ways that produced a confident, plausible, incorrect list.
 */
describe("listSkills roots", () => {
  let home: ReturnType<typeof useTempHome>;
  let cwd: string;
  let project: string;

  /** Write a skill into a root, so the fixtures read as the real thing does. */
  function skill(root: string, name: string, description: string) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
  }

  beforeAll(() => {
    home = useTempHome();
    project = mkdtempSync(join(tmpdir(), "agentbox-project-"));
    cwd = process.cwd();
    // `SKILL_ROOTS` reads `process.cwd()` for the project root at module load,
    // so the chdir has to happen before the first call, not before the import.
    process.chdir(project);
  });

  afterAll(() => {
    process.chdir(cwd);
    rmSync(project, { recursive: true, force: true });
    home.restore();
  });

  test("a name present in several roots yields exactly one entry, and it is omp's", () => {
    // Not a hypothetical: `go-for-it` and `vibed` genuinely differ between the
    // two user roots on this machine, so the loser's description is wrong, not
    // merely redundant. omp consults `.claude` (priority 80) before `.agents`
    // (70), so `global` must win over `agents`.
    const globalRoot = join(home.home, ".claude", "skills");
    const agentsRoot = join(home.home, ".agents", "skills");
    skill(globalRoot, "twinned", "the claude copy");
    skill(agentsRoot, "twinned", "the agents copy");

    const found = listSkills().skills.filter((s) => s.name === "twinned");
    expect(found).toHaveLength(1);
    expect(found[0].description).toBe("the claude copy");
    expect(found[0].source).toBe("global");
    expect(found[0].path).toBe(join(globalRoot, "twinned"));
  });

  test("a repo-local skill outranks a user-level one of the same name", () => {
    skill(join(home.home, ".claude", "skills"), "layered", "the user copy");
    skill(join(project, ".claude", "skills"), "layered", "the project copy");

    const found = listSkills().skills.filter((s) => s.name === "layered");
    expect(found).toHaveLength(1);
    expect(found[0].description).toBe("the project copy");
    expect(found[0].source).toBe("project");
  });

  test("a symlinked skill directory is found", () => {
    // `readdirSync(withFileTypes).isDirectory()` is false for a symlink, so
    // sharing a skill between roots by symlinking it made it invisible.
    const agentsRoot = join(home.home, ".agents", "skills");
    const globalRoot = join(home.home, ".claude", "skills");
    skill(agentsRoot, "shared", "lives in agents, linked into claude");
    mkdirSync(globalRoot, { recursive: true });
    symlinkSync(join(agentsRoot, "shared"), join(globalRoot, "shared"), "dir");

    const found = listSkills().skills.filter((s) => s.name === "shared");
    expect(found).toHaveLength(1);
    // Reached through the higher-precedence root, which is where omp finds it.
    expect(found[0].source).toBe("global");
  });

  test("a dangling symlink is skipped without a warning or a phantom entry", () => {
    // This machine has one: ~/.claude/skills/remotion-best-practices.
    const globalRoot = join(home.home, ".claude", "skills");
    mkdirSync(globalRoot, { recursive: true });
    symlinkSync(join(home.home, ".agents", "skills", "nope"), join(globalRoot, "broken"), "dir");

    const scan = listSkills();
    expect(scan.skills.map((s) => s.name)).not.toContain("broken");
    expect(scan.warnings).toEqual([]);
  });

  test("a loose file among the skill directories is ignored", () => {
    writeFileSync(join(home.home, ".claude", "skills", "README.md"), "not a skill");
    expect(listSkills().skills.map((s) => s.name)).not.toContain("README.md");
  });
});
