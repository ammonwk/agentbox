import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSkills,
  parseFrontmatterForTest as parseFrontmatter,
  skillRoots,
  type SkillRoot,
} from "../skills";

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
 * Root resolution against a real filesystem: which copy of a duplicated skill
 * wins, and whether a symlinked skill directory is seen at all. Both were wrong
 * in ways that produced a confident, plausible, incorrect list.
 *
 * Roots are passed explicitly rather than redirected through the environment.
 * `skillRoots()` reads `homedir()`, and Bun caches that — it does not follow a
 * changed `$HOME`, which I verified rather than assumed. Ambient state you
 * cannot redirect is state you cannot test against, so it becomes an argument.
 */
describe("listSkills roots", () => {
  let tmp: string;
  let project: string;
  let global: string;
  let agents: string;
  let roots: SkillRoot[];

  /** Write a skill into a root, so the fixtures read as the real thing does. */
  function skill(root: string, name: string, description: string) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(
      join(root, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`
    );
  }

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "agentbox-skills-"));
    project = join(tmp, "project", ".claude", "skills");
    global = join(tmp, "home", ".claude", "skills");
    agents = join(tmp, "home", ".agents", "skills");
    for (const d of [project, global, agents]) mkdirSync(d, { recursive: true });
    // Same precedence order the real skillRoots() returns.
    roots = [
      { source: "project", dir: project },
      { source: "global", dir: global },
      { source: "agents", dir: agents },
    ];
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test("a name in several roots yields one entry, and it is the one omp loads", () => {
    // Not hypothetical: `go-for-it` and `vibed` genuinely differ between the two
    // user roots on this machine, so the loser's description is wrong rather
    // than merely redundant. omp consults `.claude` (priority 80) before
    // `.agents` (70), so `global` must beat `agents`.
    skill(global, "twinned", "the claude copy");
    skill(agents, "twinned", "the agents copy");

    const found = listSkills(roots).skills.filter((s) => s.name === "twinned");
    expect(found).toHaveLength(1);
    expect(found[0].description).toBe("the claude copy");
    expect(found[0].source).toBe("global");
    expect(found[0].path).toBe(join(global, "twinned"));
  });

  test("a repo-local skill outranks a user-level one of the same name", () => {
    skill(global, "layered", "the user copy");
    skill(project, "layered", "the project copy");

    const found = listSkills(roots).skills.filter((s) => s.name === "layered");
    expect(found).toHaveLength(1);
    expect(found[0].description).toBe("the project copy");
    expect(found[0].source).toBe("project");
  });

  test("a symlinked skill directory is found", () => {
    // `readdirSync(withFileTypes).isDirectory()` is false for a symlink, so
    // sharing a skill between roots by symlinking it made it invisible —
    // `~/.claude/skills/agent-browser` on this machine is exactly that.
    skill(agents, "shared", "lives in agents, linked into claude");
    symlinkSync(join(agents, "shared"), join(global, "shared"), "dir");

    const found = listSkills(roots).skills.filter((s) => s.name === "shared");
    expect(found).toHaveLength(1);
    // Reached through the higher-precedence root, which is where omp finds it.
    expect(found[0].source).toBe("global");
  });

  test("a dangling symlink is skipped, with no warning and no phantom entry", () => {
    // This machine has one: ~/.claude/skills/remotion-best-practices.
    symlinkSync(join(agents, "does-not-exist"), join(global, "broken"), "dir");

    const scan = listSkills(roots);
    expect(scan.skills.map((s) => s.name)).not.toContain("broken");
    expect(scan.warnings).toEqual([]);
  });

  test("a loose file among the skill directories is ignored", () => {
    writeFileSync(join(global, "README.md"), "not a skill");
    expect(listSkills(roots).skills.map((s) => s.name)).not.toContain("README.md");
  });

  test("a missing root is not an error", () => {
    const scan = listSkills([{ source: "project", dir: join(tmp, "nope") }]);
    expect(scan).toEqual({ skills: [], warnings: [] });
  });
});

/**
 * The precedence *order itself*, which the tests above cannot reach — they pass
 * roots explicitly, so they prove the dedupe honours the order it is handed,
 * not that the real one is right. Reordering `skillRoots()` left them all green.
 *
 * This is the claim that decides which of two genuinely different skills a user
 * is shown, so it needs its own assertion.
 */
describe("skillRoots precedence", () => {
  test("matches omp's provider order: project, then .claude, then .agents", () => {
    // omp registers `.claude` at priority 80 and `.agent`/`.agents` at 70, and
    // sorts providers descending, so `.claude` is consulted first. Project-level
    // beats user-level within a provider. Read out of omp's bundle, not chosen.
    expect(skillRoots().map((r) => r.source)).toEqual(["project", "global", "agents"]);
  });

  test("a redirected $HOME is honoured, because Bun's homedir() is not", () => {
    // Bun resolves homedir() once and ignores a later process.env.HOME —
    // measured, not assumed. Every other tool on the box follows $HOME, so
    // agentbox has to as well or it reads a different home than the agent does.
    const real = process.env.HOME;
    try {
      process.env.HOME = "/tmp/agentbox-not-a-real-home";
      const dirs = Object.fromEntries(skillRoots().map((r) => [r.source, r.dir]));
      expect(dirs.global).toBe(join("/tmp/agentbox-not-a-real-home", ".claude", "skills"));
      expect(dirs.agents).toBe(join("/tmp/agentbox-not-a-real-home", ".agents", "skills"));
    } finally {
      if (real === undefined) delete process.env.HOME;
      else process.env.HOME = real;
    }
  });

  test("an unset $HOME falls back to homedir() rather than resolving to nothing", () => {
    const real = process.env.HOME;
    try {
      delete process.env.HOME;
      for (const root of skillRoots()) expect(root.dir.startsWith("/")).toBe(true);
    } finally {
      if (real !== undefined) process.env.HOME = real;
    }
  });

  test("the roots are the directories omp actually reads", () => {
    const dirs = Object.fromEntries(skillRoots().map((r) => [r.source, r.dir]));
    expect(dirs.project.endsWith(join(".claude", "skills"))).toBe(true);
    expect(dirs.global.endsWith(join(".claude", "skills"))).toBe(true);
    expect(dirs.agents.endsWith(join(".agents", "skills"))).toBe(true);
    // The project root tracks the working directory rather than being frozen at
    // import — that freezing is what pinned it to the server's launch dir.
    expect(dirs.project.startsWith(process.cwd())).toBe(true);
  });
});
