#!/usr/bin/env bun
/**
 * Turns copies of a generic agent into its instances (docs/superagents.md,
 * Overrides and gates). The move from local agents (migrate-local-agents.ts)
 * made one directory for each old instance — `vulcan`, `vulcan-agentbox`,
 * `vulcan-plaibook-dev` — and copies drift apart. After this, each is a row
 * of the one generic agent, and what made a copy different is a layer:
 *
 *   - the person's own copy (named as the generic agent) becomes the generic
 *     agent's row: the same name, its directory now the generic one, and what
 *     its manifest changed goes into the person's layer (~/.agents/overrides);
 *   - a project's copy (`<agent>-<project>`, its manifest naming that one
 *     project) becomes the instance in that project: the same name, so its
 *     main conversation, earlier mains, memory, store, loops, picture, claims
 *     and events stay its own; what is left of its difference, and its gate,
 *     go into its project's local layer, which git ignores.
 *
 * Agentbox's code names no agent, and neither does this script: the generic
 * agents are given on the command line.
 *   --generic <name>=<directory>     the generic agent's directory (registered if it is not)
 *   --make <name>=<copy>             make the generic agent's directory from that copy's,
 *                                    in --into (default ~/.agents/superagents), without its project
 *
 * Nothing is deleted: a copy's directory stays where it is, and a copy whose
 * MAIN.md or files are not the generic agent's own is left alone and listed.
 * Before it writes, it checks that each instance's manifest, from the generic
 * directory and its layers, is the copy's own. The rows move first, then the
 * layers are written, so a running server never makes a second instance. It
 * is safe to run again: a copy that moved is a row of its generic agent and
 * is not looked at again. `--dry-run` writes nothing.
 *
 *   bun scripts/migrate-instances.ts --dry-run \
 *     --generic vulcan=superagents/vulcan --generic jupiter=superagents/jupiter \
 *     --make terminus=terminus-plaibook-dev
 */
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getDb, getRepoById, MIGRATIONS } from "../src/core/db";
import { repoCheckoutPath } from "../src/core/git";
import { agentboxHome } from "../src/core/paths";
import { excludeLocalLayers, isObject, layerFromJson, layerPath, mergePatch, readLayer, resolveLayers, restrictedDigest, splitProjectPatch, stable } from "../src/core/superagent/layers";
import { patchState } from "../src/core/superagent/state";
import { asInstance, readManifest } from "../src/core/superagents";

type Row = { name: string; dir: string; enabled: number; base: string | null; project: string | null };

const args = process.argv.slice(2);
const flag = (k: string) => args.flatMap((a, i) => (a === k && args[i + 1] ? [args[i + 1]!] : a.startsWith(`${k}=`) ? [a.slice(k.length + 1)] : []));
const pairs = (k: string) => flag(k).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)] as const);
const dry = args.includes("--dry-run");
const tilde = (p: string) => resolve(p.replace(/^~(?=\/|$)/, homedir()));
const into = tilde(flag("--into")[0] ?? "~/.agents/superagents");
const generics = new Map(pairs("--generic").map(([k, v]) => [k, tilde(v)] as const));
const makes = new Map(pairs("--make"));
if (!generics.size && !makes.size) {
  console.error("give at least one --generic <name>=<directory> or --make <name>=<copy>");
  process.exit(2);
}

// The server must have brought the database up to date (and moved the old gates to layers): this script never migrates it.
const boxFile = join(agentboxHome(), "box.db");
{
  const box = new Database(boxFile, { readonly: true });
  const version = (box.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  box.close();
  if (version < MIGRATIONS.length) {
    console.error(`${boxFile} is at version ${version}, and this needs ${MIGRATIONS.length}: integrate this branch and restart the server first, then run this.`);
    process.exit(1);
  }
}
const db = getDb();
const rows = () => db.query("SELECT name, dir, enabled, base, project FROM superagents ORDER BY created_at").all() as Row[];
const rowOf = (name: string) => rows().find((r) => r.name === name) ?? null;
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const say = (line: string) => console.log(line);

/** A layer file's JSON, or {} when there is none. One that is not a JSON object stops its copy. */
function bodyOf(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not JSON (${(e as Error).message})`);
  }
  if (!isObject(raw)) throw new Error(`${file} is not a JSON object`);
  return raw;
}

/** `b` merged into a layer file's `a`, keeping b's nulls: they are the patch's own removals. */
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

/** A merge patch that makes `a` into `b`. */
function diff(a: unknown, b: unknown): unknown {
  if (!isObject(a) || !isObject(b)) return same(a, b) ? undefined : b;
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in b)) out[k] = null;
    else if (!(k in a)) out[k] = b[k];
    else {
      const d = diff(a[k], b[k]);
      if (d !== undefined) out[k] = d;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** The repo a project's copy is of: its manifest's one project, else its main's repoId. */
function repoOfCopy(m: Record<string, unknown>): string | null {
  const projects = Array.isArray(m.projects) ? m.projects : [];
  const start = isObject(m.main) && isObject(m.main.start) ? m.main.start : {};
  const ids = new Set([...projects, ...(typeof start.repoId === "string" ? [start.repoId] : [])].filter((x): x is string => typeof x === "string"));
  return ids.size === 1 ? [...ids][0]! : null;
}

/** A copy's manifest as the generic directory would say it: its program named from there. */
function normalized(copy: Record<string, unknown>, dir: string): Record<string, unknown> {
  const m = structuredClone(copy);
  if (Array.isArray(m.run)) m.run = m.run.map((a) => (typeof a === "string" && isAbsolute(a) && a.startsWith(`${dir}/`) ? a.slice(dir.length + 1) : a));
  return m;
}

/** What only a project's instance has: agentbox gives it (asInstance), so a layer never says it. */
function withoutInstanceKeys(patch: unknown): Record<string, unknown> {
  const p = isObject(patch) ? structuredClone(patch) : {};
  delete p.name;
  delete p.projects;
  if (isObject(p.main) && isObject(p.main.start)) {
    delete p.main.start.repoId;
    delete p.main.start.cwd;
    if (p.main.start.worktree === true) delete p.main.start.worktree;
    if (!Object.keys(p.main.start).length) delete p.main.start;
    if (!Object.keys(p.main).length) delete p.main;
  }
  return p;
}

/** The files a copy has that the generic agent's directory does not hold the same. */
function strayFiles(copyDir: string, dir: string): string[] {
  const ignore = new Set(["superagent.json", "SOUL.md", ".migrated-from-local-agent.json", "MAIN.before.md", ".jupiter"]);
  return readdirSync(copyDir).filter((f) => {
    if (ignore.has(f)) return false;
    const a = join(copyDir, f), b = join(dir, f);
    if (!statSync(a).isFile()) return true;
    return !existsSync(b) || !readFileSync(a).equals(readFileSync(b));
  });
}

type Plan = {
  generic: string;
  dir: string;
  register: boolean;
  user: Record<string, unknown>;
  userEnabled: boolean | null;
  person: Row | null;
  /** The person's layer as it will be. */
  userBody: Record<string, unknown>;
  instances: { row: Row; repo: string; checkout: string; local: Record<string, unknown>; body: Record<string, unknown>; enabled: boolean; soul: string | null; approve: string | null }[];
  skipped: string[];
};

// ---- the generic agents' directories
for (const [name, copyName] of makes) {
  const copy = rowOf(copyName);
  const target = join(into, name);
  if (generics.has(name)) throw new Error(`--make ${name} and --generic ${name}: give one`);
  generics.set(name, target);
  if (existsSync(join(target, "superagent.json"))) {
    if (readManifest(target).name !== name) throw new Error(`${target} holds another agent: give --into another directory`);
    say(`${name}: ${target} is there already`);
    continue;
  }
  if (!copy) throw new Error(`--make ${name}=${copyName}: no superagent ${copyName}`);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} is not empty and has no superagent.json: move it first`);
  const base = { ...withoutInstanceKeys(readJson(join(copy.dir, "superagent.json"))), name };
  say(`${name}: make ${target} from ${copy.dir}, without its project`);
  if (dry) continue;
  cpSync(copy.dir, target, { recursive: true, filter: (src) => !src.endsWith("/.migrated-from-local-agent.json") });
  writeFileSync(join(target, "superagent.json"), `${JSON.stringify(base, null, 2)}\n`);
  writeFileSync(join(target, ".made-from.json"), `${JSON.stringify({ copy: copy.name, from: copy.dir, at: Date.now() }, null, 2)}\n`);
}

// ---- the plan: nothing is written until every copy checks
const plans: Plan[] = [];
for (const [name, dir] of generics) {
  const made = dry && makes.has(name) && !existsSync(join(dir, "superagent.json"));
  const baseRaw = made ? { ...withoutInstanceKeys(readManifest(rowOf(makes.get(name)!)!.dir)), name } : (readManifest(dir) as Record<string, unknown>);
  if (baseRaw.name !== name) throw new Error(`${dir}/superagent.json names ${String(baseRaw.name)}, not ${name}`);
  const own = rowOf(name);
  const plan: Plan = { generic: name, dir, register: !own, user: {}, userEnabled: null, person: null, userBody: {}, instances: [], skipped: [] };
  const mainOf = (d: string) => (existsSync(join(d, "MAIN.md")) ? readFileSync(join(d, "MAIN.md"), "utf8") : null);
  const genericMain = made ? mainOf(rowOf(makes.get(name)!)!.dir) : mainOf(dir);
  // Each copy: the person's own (its name), and each project's (`<name>-…`, naming one project).
  const copies = rows().filter((r) => !r.base && resolve(r.dir) !== resolve(dir) && (r.name === name || r.name.startsWith(`${name}-`)));
  const checked: { row: Row; m: Record<string, unknown>; repo: string | null }[] = [];
  for (const row of copies) {
    let m: Record<string, unknown>;
    try {
      m = normalized(readManifest(row.dir) as Record<string, unknown>, dir);
    } catch (e) {
      plan.skipped.push(`${row.name}: its manifest cannot be read (${(e as Error).message})`);
      continue;
    }
    const repo = row.name === name ? null : repoOfCopy(m);
    if (row.name !== name && !repo) {
      plan.skipped.push(`${row.name}: its manifest names no one project, so it is not a project's copy of ${name}`);
      continue;
    }
    if (repo && !getRepoById(repo)) {
      plan.skipped.push(`${row.name}: its project ${repo} is not registered`);
      continue;
    }
    if (mainOf(row.dir) !== genericMain) {
      plan.skipped.push(`${row.name}: its MAIN.md is not ${name}'s; put the difference in a layer's "instructions" by hand, then run this again`);
      continue;
    }
    const stray = existsSync(row.dir) ? strayFiles(row.dir, made ? rowOf(makes.get(name)!)!.dir : dir) : [];
    if (stray.length) {
      plan.skipped.push(`${row.name}: ${row.dir} has files ${name}'s directory does not: ${stray.join(", ")}`);
      continue;
    }
    checked.push({ row, m, repo });
  }
  // The person's own copy, when there is one: what it changed goes into the person's layer.
  const person = checked.find((c) => !c.repo) ?? null;
  if (own && resolve(own.dir) !== resolve(dir) && !person) {
    plan.skipped.push(`${name}: its own row runs from ${own.dir}, and that copy cannot move, so none of its copies move`);
    plan.instances = [];
    plans.push(plan);
    continue;
  }
  // The layers as they are now: each is merged into, never written over, and the check reads them.
  let userBody: Record<string, unknown>;
  try {
    userBody = bodyOf(layerPath("user", name, null)!);
  } catch (e) {
    plan.skipped.push(`${name}: ${(e as Error).message}; fix it, then run this again`);
    plan.instances = [];
    plans.push(plan);
    continue;
  }
  if (person) {
    const was = mergePatch(baseRaw, layerFromJson("user", "user", userBody).patch) as Record<string, unknown>;
    plan.user = withoutInstanceKeys(diff(was, person.m));
    // The person's own copy names the projects it shows in; an instance's are its own.
    if (!same(was.projects, person.m.projects)) plan.user.projects = "projects" in person.m ? person.m.projects : null;
    plan.person = person.row;
    // The gate as the person last set it: the new server moved the row's to this layer, and the page writes it there.
    const gate = layerFromJson("user", "user", userBody).enabled;
    plan.userEnabled = gate ?? person.row.enabled === 1;
  }
  plan.userBody = deepMerge(userBody, { ...plan.user, ...(plan.userEnabled === null ? {} : { enabled: plan.userEnabled }) });
  const userLayer = layerFromJson("user", layerPath("user", name, null)!, plan.userBody);
  if (userLayer.error) throw new Error(userLayer.error);
  // The person's own instance: its manifest must be its copy's.
  if (person) {
    const res = resolveLayers(baseRaw, [userLayer], {});
    asInstance(res.raw, name, null);
    if (!same(res.raw, person.m)) throw new Error(`${name}: its layer would not give its own copy's manifest:\n  would ${JSON.stringify(stable(res.raw))}\n  is    ${JSON.stringify(stable(person.m))}`);
  }
  for (const c of checked) {
    if (!c.repo) continue;
    const checkout = repoCheckoutPath(getRepoById(c.repo)!);
    if (!existsSync(checkout)) {
      plan.skipped.push(`${c.row.name}: its project's checkout ${checkout} is not on this machine`);
      continue;
    }
    const taken = rows().find((r) => r.base === name && r.project === c.repo);
    if (taken) {
      plan.skipped.push(`${c.row.name}: ${name} has an instance in that project already (${taken.name})`);
      continue;
    }
    const shared = readLayer("project", layerPath("project", name, checkout)!);
    let localBody: Record<string, unknown>;
    try {
      localBody = bodyOf(layerPath("local", name, checkout)!);
    } catch (e) {
      plan.skipped.push(`${c.row.name}: ${(e as Error).message}; fix it, then run this again`);
      continue;
    }
    const want = structuredClone(c.m);
    asInstance(want, c.row.name, c.repo);
    // What the generic directory and the layers give now, with what is already in its local layer.
    const now = resolveLayers(baseRaw, [userLayer, shared, layerFromJson("local", "local", localBody)], {});
    asInstance(now.raw, c.row.name, c.repo);
    const local = withoutInstanceKeys(diff(now.raw, want));
    const soulFile = join(c.row.dir, "SOUL.md");
    const soul = existsSync(soulFile) && (!existsSync(join(dir, "SOUL.md")) || readFileSync(soulFile, "utf8") !== readFileSync(join(dir, "SOUL.md"), "utf8")) ? readFileSync(soulFile, "utf8") : null;
    // A gate the new server moved to a layer named after the copy, before this ran, is the copy's.
    const moved = readLayer("user", layerPath("user", c.row.name, null)!);
    const enabled = moved.exists && moved.enabled !== null ? moved.enabled : c.row.enabled === 1;
    const body = deepMerge(localBody, { ...local, ...(soul ? { soul } : {}), enabled });
    const localLayer = layerFromJson("local", layerPath("local", name, checkout)!, body);
    if (localLayer.error) throw new Error(localLayer.error);
    // The person moved this copy, so what its local layer keeps from it is approved as it is now.
    const fields = (mergePatch(baseRaw, userLayer.patch) as Record<string, unknown>).projectFields;
    const declared = Array.isArray(fields) ? fields.filter((x): x is string => typeof x === "string") : [];
    const restricted = splitProjectPatch(localLayer.patch, declared).restricted;
    const approve = restricted.length ? restrictedDigest(restricted) : null;
    // The check: the generic directory and every layer, as they will be, give the copy's own manifest.
    const res = resolveLayers(baseRaw, [userLayer, shared, localLayer], approve ? { local: approve } : {});
    asInstance(res.raw, c.row.name, c.repo);
    if (!same(res.raw, want)) throw new Error(`${c.row.name}: its layers would not give its own manifest:\n  would ${JSON.stringify(stable(res.raw))}\n  is    ${JSON.stringify(stable(want))}`);
    plan.instances.push({ row: c.row, repo: c.repo, checkout, local, body, enabled, soul, approve });
  }
  plans.push(plan);
}

// ---- what it does
for (const p of plans) {
  say(`\n${p.generic} (${p.dir})${p.register ? ": registered as a generic agent" : ""}`);
  if (p.person) say(`  ${p.person.name}: your own copy (${p.person.dir}) becomes ${p.generic}'s row; gate ${p.userEnabled ? "on" : "off"} in your layer`);
  say(`  your layer ${layerPath("user", p.generic, null)}: ${Object.keys(p.user).length ? JSON.stringify(p.user) : "nothing to change"}`);
  for (const i of p.instances)
    say(
      `  ${i.row.name}: instance in ${getRepoById(i.repo)!.displayName}; ${layerPath("local", p.generic, i.checkout)}: enabled ${i.enabled}${Object.keys(i.local).length ? `, ${JSON.stringify(i.local)}` : ""}${i.soul ? ", its SOUL.md" : ""}${i.approve ? " (approved for it)" : ""}; ${i.row.dir} stays`,
    );
  for (const s of p.skipped) say(`  left alone: ${s}`);
}
if (dry) {
  console.log("\ndry run: nothing changed");
  process.exit(0);
}

// ---- the layers to files beside their places first: a failure there changes nothing
const pending: { tmp: string; path: string }[] = [];
const stage = (path: string, body: Record<string, unknown>) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.migrate-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  pending.push({ tmp, path });
};
for (const p of plans) {
  // The person's layer only when it changes: an agent with nothing of the person's gets no empty file.
  const user = layerPath("user", p.generic, null)!;
  if (!same(bodyOf(user), p.userBody)) stage(user, p.userBody);
  for (const i of p.instances) stage(layerPath("local", p.generic, i.checkout)!, i.body);
}

// ---- then the rows, in one step: from here a running server never makes a second instance
db.transaction(() => {
  for (const p of plans) {
    if (p.register) db.run("INSERT INTO superagents (name, dir, enabled, previous, created_at, gate_moved) VALUES (?, ?, 0, '[]', ?, 1)", [p.generic, p.dir, Date.now()]);
    else if (p.person) db.run("UPDATE superagents SET dir = ?, gate_moved = 1 WHERE name = ? AND base IS NULL", [p.dir, p.generic]);
    for (const i of p.instances) db.run("UPDATE superagents SET base = ?, project = ?, dir = ?, gate_moved = 1 WHERE name = ?", [p.generic, i.repo, p.dir, i.row.name]);
  }
})();
for (const p of plans) for (const i of p.instances) if (i.approve) patchState(i.row.name, (st) => void (st.approved = { ...st.approved, local: i.approve! }));

// ---- then the layers into their places
for (const { tmp, path } of pending) renameSync(tmp, path);
for (const p of plans)
  for (const i of p.instances) {
    excludeLocalLayers(i.checkout);
    // A layer named after the copy held only its gate, which is now in its project's layer.
    const moved = layerPath("user", i.row.name, null)!;
    if (existsSync(moved)) {
      const body = readJson(moved);
      if (Object.keys(body).every((k) => k === "enabled")) rmSync(moved);
      else say(`  ${moved} holds more than a gate: it is no longer read; move what you need into ${layerPath("user", p.generic, null)}`);
    }
  }
console.log("\ndone: the server reads the layers at its next look (agentbox superagent ls)");
