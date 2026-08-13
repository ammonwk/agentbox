import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  frameSupervisorMessage,
  readJudgePrompt,
  writeSessionPrompt,
  writeWatchdog,
} from "../prompts";
import { useTempHome } from "./tmp-home";
import type { AgentSettings, Repo, Session } from "../types";

/**
 * The home pin is taken in `beforeAll`, not at module scope.
 *
 * paths.ts resolves `AGENTBOX_HOME` on every call, so a `beforeAll` binds no
 * matter which file bun loaded first — and it is strictly safer than a
 * module-scope assignment here, because a sibling suite's `afterAll` restore
 * runs *between* the two and would otherwise unset a pin taken at load time.
 * Without this, `writeSessionPrompt` writes into the developer's live
 * ~/.local/share/agentbox and the suite still passes, which is the failure
 * nothing tells you about.
 */
let home: string;
let restoreHome: () => void;

let worktree: string;

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: "sess1",
    title: "Add a --json flag",
    prompt: "Add a --json flag to the CLI",
    status: "spawning",
    repo: "/repo",
    branch: "agentbox/json-flag",
    worktree,
    model: "deepseek-v4-flash",
    followUps: 0,
    lastMessage: null,
    toolCalls: 0,
    exitCode: null,
    pid: null,
    prNumber: null,
    repoFullName: null,
    costUsd: null,
    tokens: null,
    blocked: false,
    flagReason: null,
    ompSessionId: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    archivedAt: null,
    ...over,
  };
}

function makeRepo(over: Partial<Repo> = {}): Repo {
  return {
    id: "r1",
    ref: worktree,
    kind: "local",
    displayName: "demo",
    fullName: null,
    defaultBranch: "main",
    addedAt: 0,
    ...over,
  };
}

function makeSettings(over: Partial<AgentSettings> = {}): AgentSettings {
  return {
    theme: "system",
    model: "deepseek-v4-flash",
    autoApprove: false,
    maxMinutes: 30,
    systemPrompt: "",
    supervisor: { enabled: true, everyToolCalls: 25, model: "deepseek-v4-flash" },
    advisor: { enabled: false, model: "deepseek-v4-flash" },
    ...over,
  };
}

let repoRoot: string;
let mainCheckout: string;

const git = (args: string[], cwd: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

beforeAll(() => {
  ({ home, restore: restoreHome } = useTempHome());

  // A real *linked* worktree, not a plain `git init` — in a linked worktree
  // `.git` is a file, so `<worktree>/.git/info/exclude` does not exist and a
  // test against a normal checkout would prove nothing about the real case.
  repoRoot = mkdtempSync(join(tmpdir(), "agentbox-repo-"));
  mainCheckout = join(repoRoot, "main");
  mkdirSync(mainCheckout);
  git(["init", "-q"], mainCheckout);
  git(["config", "user.email", "t@t"], mainCheckout);
  git(["config", "user.name", "t"], mainCheckout);
  writeFileSync(join(mainCheckout, "README.md"), "hi\n", "utf8");
  git(["add", "README.md"], mainCheckout);
  git(["commit", "-qm", "init"], mainCheckout);
  worktree = join(repoRoot, "wt");
  git(["worktree", "add", "-q", worktree, "-b", "feat/x"], mainCheckout);
});

afterAll(() => {
  restoreHome();
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("writeSessionPrompt", () => {
  test("returns an absolute path to a file that exists, under AGENTBOX_HOME", () => {
    const path = writeSessionPrompt(makeSession(), makeRepo(), makeSettings());
    expect(isAbsolute(path)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(home)).toBe(true);
  });

  test("the path has no newline in it — omp reads a multi-line value as literal text", () => {
    const path = writeSessionPrompt(makeSession(), makeRepo(), makeSettings());
    expect(path).not.toContain("\n");
  });

  test("nothing is written into the worktree", () => {
    writeSessionPrompt(makeSession(), makeRepo(), makeSettings());
    const tracked = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktree,
      encoding: "utf8",
    });
    expect(tracked.trim()).toBe("");
  });

  test("carries the harness contract", () => {
    const body = readFileSync(
      writeSessionPrompt(makeSession(), makeRepo(), makeSettings()),
      "utf8",
    );
    expect(body).toContain("agentbox");
    expect(body).toContain("gh pr create");
    expect(body).toContain("[agentbox supervisor]");
  });

  test("includes the repo's own .omp/APPEND_SYSTEM.md", () => {
    mkdirSync(join(worktree, ".omp"), { recursive: true });
    writeFileSync(
      join(worktree, ".omp", "APPEND_SYSTEM.md"),
      "Never touch generated/ in this repo.",
      "utf8",
    );
    try {
      const body = readFileSync(
        writeSessionPrompt(makeSession(), makeRepo(), makeSettings()),
        "utf8",
      );
      expect(body).toContain("Never touch generated/ in this repo.");
    } finally {
      rmSync(join(worktree, ".omp"), { recursive: true, force: true });
    }
  });

  test("includes the settings overlay when it is set, and no empty section when it is not", () => {
    const withOverlay = readFileSync(
      writeSessionPrompt(
        makeSession(),
        makeRepo(),
        makeSettings({ systemPrompt: "Prefer bun over node." }),
      ),
      "utf8",
    );
    expect(withOverlay).toContain("Prefer bun over node.");

    const without = readFileSync(
      writeSessionPrompt(makeSession(), makeRepo(), makeSettings()),
      "utf8",
    );
    expect(without).not.toContain("From this agentbox install");
  });

  test("a fresh session and a resumed one read differently", () => {
    const fresh = readFileSync(
      writeSessionPrompt(makeSession(), makeRepo(), makeSettings()),
      "utf8",
    );
    expect(fresh).toContain("starting fresh");

    const resumed = readFileSync(
      writeSessionPrompt(
        makeSession({
          status: "flagged",
          flagReason: "ran `bun test` nine times without changing anything",
          toolCalls: 40,
        }),
        makeRepo(),
        makeSettings(),
      ),
      "utf8",
    );
    expect(resumed).toContain("you were stopped");
    expect(resumed).toContain("ran `bun test` nine times");
    expect(resumed).not.toContain("{{");
  });

  test("substitutes the branch and repo", () => {
    const body = readFileSync(
      writeSessionPrompt(makeSession(), makeRepo({ displayName: "acme/widgets" }), makeSettings()),
      "utf8",
    );
    expect(body).toContain("agentbox/json-flag");
    expect(body).toContain("acme/widgets");
    expect(body).not.toContain("{{");
  });
});

describe("writeWatchdog", () => {
  const on = () => makeSettings({ advisor: { enabled: true, model: "m" } });
  const watchdogPath = () => join(worktree, "WATCHDOG.yml");

  test("does nothing when the advisor is off", () => {
    writeWatchdog(makeSession(), makeSettings());
    expect(existsSync(watchdogPath())).toBe(false);
  });

  test("writes WATCHDOG.yml — omp discovers .yml/.yaml and nothing else", () => {
    writeWatchdog(makeSession(), on());
    expect(existsSync(watchdogPath())).toBe(true);
    expect(existsSync(join(worktree, "WATCHDOG.md"))).toBe(false);
  });

  test("emits a YAML mapping with instructions as a block scalar", () => {
    writeWatchdog(makeSession(), on());
    const body = readFileSync(watchdogPath(), "utf8");
    // omp validates against {instructions?: string, advisors?: array} and warns
    // "instructions must be a string" on anything else, so the first line and
    // the indentation of every following line are the contract.
    expect(body.startsWith("instructions: |-\n")).toBe(true);
    for (const line of body.split("\n").slice(1)) {
      if (line.length > 0) expect(line.startsWith("  ")).toBe(true);
    }
    expect(body).toContain("Every note you write costs the");
  });

  test("cannot reach the diff — not in the worktree, not in the main checkout", () => {
    writeWatchdog(makeSession(), on());
    expect(git(["status", "--porcelain"], worktree).trim()).toBe("");
    // info/exclude lives in the COMMON git dir, so the same entry is what hides
    // it here; if that ever changed, this is the assertion that would notice.
    expect(git(["status", "--porcelain"], mainCheckout).trim()).toBe("");
  });

  test("is idempotent — the exclude entry is not appended twice", () => {
    writeWatchdog(makeSession(), on());
    writeWatchdog(makeSession(), on());
    const excludePath = git(
      ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      worktree,
    ).trim();
    const lines = readFileSync(excludePath, "utf8")
      .split("\n")
      .filter((l) => l.trim() === "/WATCHDOG.yml");
    expect(lines).toHaveLength(1);
  });

  test("does nothing when the worktree is gone", () => {
    expect(() => writeWatchdog(makeSession({ worktree: null }), on())).not.toThrow();
  });

  test("refuses to write when git cannot be asked for the exclude path", () => {
    // A directory that is not a git worktree: writing here would leave an
    // un-excluded file, which is the exact thing the harness prompt forbids.
    const bare = mkdtempSync(join(tmpdir(), "agentbox-nogit-"));
    try {
      expect(() => writeWatchdog(makeSession({ worktree: bare }), on())).toThrow(/refused/);
      expect(existsSync(join(bare, "WATCHDOG.yml"))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("frameSupervisorMessage", () => {
  test("marks the message as automated and includes the nudge", () => {
    const framed = frameSupervisorMessage("You have run `bun test` four times unchanged.");
    expect(framed).toContain("[agentbox supervisor");
    expect(framed).toContain("You have run `bun test` four times unchanged.");
    expect(framed).not.toContain("{{");
  });
});

describe("readJudgePrompt", () => {
  test("keeps its placeholders for the supervisor to fill", () => {
    const tpl = readJudgePrompt();
    for (const key of ["{{task}}", "{{trigger}}", "{{evidence}}"]) {
      expect(tpl).toContain(key);
    }
  });
});
