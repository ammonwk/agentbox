/** This machine's Salus settings, kept in its home and changed by a person on
 *  its page. The PostHog key is a file of its own, never shown and never sent
 *  anywhere but PostHog. */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const Settings = z
  .object({
    /** Off until a person turns it on: nothing is polled or started before. */
    enabled: z.boolean().default(false),
    posthogHost: z.url().default("https://us.posthog.com"),
    projectId: z.string().regex(/^\d*$/).default(""),
    /** The registered repo (agentbox's id) the crashes come from. */
    repo: z.string().default(""),
    /** Empty: the repository's default branch. */
    base: z.string().regex(/^[\w./-]{0,200}$/).default(""),
    /** The agent fixes are handed to. */
    fixer: z.string().regex(/^[a-z0-9-]+$/).default("vulcan"),
    windowHours: z.number().int().min(1).max(168).default(24),
    /** A crash is looked at once it happened this often in the window. */
    minCount: z.number().int().min(1).default(5),
    pollMinutes: z.number().int().min(1).max(1440).default(10),
    triagePerDay: z.number().int().min(0).max(200).default(12),
    triageAtOnce: z.number().int().min(1).max(10).default(2),
    /** Still happening this long after its fix reached production: not fixed. */
    deployLagHours: z.number().int().min(1).max(720).default(72),
    /** The branch production runs. Empty: the merge itself is the deploy. */
    prodBranch: z.string().regex(/^[\w./-]{0,200}$/).default("master"),
    /** The workflow file whose successful run on `prodBranch` is a deploy. */
    deployWorkflow: z.string().regex(/^[\w.-]{0,200}$/).default("cd.yml"),
    /** Count only events whose property `envProperty` is `envValue` (production's, not staging's). Both empty: every event. */
    envProperty: z.string().regex(/^(\$?[A-Za-z_][A-Za-z0-9_]*)?$/, "a property name: letters, digits and _, optionally starting with $").default(""),
    envValue: z.string().max(200).default(""),
  })
  .strict()
  .refine((s) => !s.envProperty === !s.envValue, { message: "set both the environment property and its value, or neither", path: ["envValue"] });
export type Settings = z.infer<typeof Settings>;

const file = (home: string) => join(home, "settings.json");
export const keyFile = (home: string) => join(home, "posthog.key");

export function readSettings(home: string): Settings {
  if (!existsSync(file(home))) return Settings.parse({});
  return Settings.parse(JSON.parse(readFileSync(file(home), "utf8")));
}

export function writeSettings(home: string, s: Settings): Settings {
  const out = Settings.parse(s);
  writeFileSync(file(home), JSON.stringify(out, null, 2) + "\n");
  return out;
}

/** The PostHog personal API key: `POSTHOG_PERSONAL_API_KEY`, else `<home>/posthog.key` (made 0600). */
export function readKey(home: string): string | null {
  const env = process.env.POSTHOG_PERSONAL_API_KEY?.trim();
  if (env) return env;
  const f = keyFile(home);
  if (!existsSync(f)) return null;
  chmodSync(f, 0o600);
  return readFileSync(f, "utf8").trim() || null;
}
