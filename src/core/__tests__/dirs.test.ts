import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { completeDir, resolveDirs } from "../dirs";
import { recentFolders, tidyFolderChoices } from "../../../web/src/lib/newsession";

const home = mkdtempSync(`${tmpdir()}/ab-dirs-`);
for (const d of ["Documents", "Downloads", "code", ".config", "Documents/agentbox", "Documents/plaibook"]) mkdirSync(`${home}/${d}`);
writeFileSync(`${home}/Docs.txt`, "");
symlinkSync(`${home}/Documents/agentbox`, `${home}/ab`);
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("a typed path lists the folders it could go on to, prefix before contains, any case", () => {
  expect(completeDir("~/do", 40, home)).toEqual({ exact: null, entries: [`${home}/Documents`, `${home}/Downloads`] });
  expect(completeDir("~/o", 40, home).entries).toEqual([`${home}/code`, `${home}/Documents`, `${home}/Downloads`]);
  // Files are not somewhere to run; a link to a folder is.
  expect(completeDir("~/", 40, home).entries).toEqual([`${home}/ab`, `${home}/code`, `${home}/Documents`, `${home}/Downloads`]);
  expect(completeDir("~/.c", 40, home).entries).toEqual([`${home}/.config`]);
});

test("the typed path itself is named when it is a folder, and a bare name completes in home", () => {
  expect(completeDir("~/Documents/", 40, home)).toEqual({
    exact: `${home}/Documents`,
    entries: [`${home}/Documents/agentbox`, `${home}/Documents/plaibook`],
  });
  expect(completeDir(`${home}/Documents`, 40, home).exact).toBe(`${home}/Documents`);
  expect(completeDir("docu", 40, home).entries).toEqual([`${home}/Documents`]);
  expect(completeDir("~/nope/", 40, home)).toEqual({ exact: null, entries: [] });
});

test("remembered folders resolve to one absolute path each, and a guess that is not a folder goes", () => {
  const r = resolveDirs(["~/Documents", `${home}/Documents/`, "/documents-nowhere", "~/Docs.txt"], home);
  expect(r).toEqual({
    "~/Documents": `${home}/Documents`,
    [`${home}/Documents/`]: `${home}/Documents`,
    "/documents-nowhere": null,
    "~/Docs.txt": null,
  });
  expect(tidyFolderChoices({ "~/Documents": 5, [`${home}/Documents/`]: 9, "/documents-nowhere": 7 }, r)).toEqual({
    [`${home}/Documents`]: 9,
  });
});

test("a forgotten folder stays out of the menu until the dialog starts a session there again", () => {
  const sessions = [{ cwd: "/w/a", lastActivityAt: 50, worktree: null }];
  expect(recentFolders(sessions, { "/w/b": 10 }, [], 12, { "/w/a": 20, "/w/b": 20 })).toEqual([]);
  expect(recentFolders(sessions, { "/w/b": 30 }, [], 12, { "/w/a": 20, "/w/b": 20 })).toEqual(["/w/b"]);
  expect(recentFolders(sessions, {}, [], 12, {})).toEqual(["/w/a"]);
});
