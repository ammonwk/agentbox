/** The onboarding checklist, in one place.
 *
 * The inventory of everything agentbox needs on a machine, each with the
 * probe that answers it — the board's first-run card, `agentbox onboard`,
 * `doctor` and the fresh-machine rehearsal all render this list, so they
 * cannot drift apart:
 *
 * | touchpoint            | probe                              |
 * |-----------------------|------------------------------------|
 * | tmux, git             | `dependencies()` — each is run, not stat'ed |
 * | gh + its auth         | `dependencies().gh` — unusable means logged out |
 * | credential homes      | accounts table + each account's auth state |
 * | identity              | `user.env` (core/user.ts), derived at boot |
 * | voice keys            | `voice.env` read (core/voice/config.ts)   |
 * | systemd unit          | `systemctl --user is-enabled` (core/service.ts) |
 * | linger                | `loginctl show-user --property=Linger`    |
 * | the board as an app   | Chrome's launcher entry (core/pwa.ts)     |
 *
 * Things that need no setup have no item: the tmux socket, the skills roots,
 * recovery. A feature that needs setting up adds an item here the same way it
 * adds a dependency check — or doctor says why not.
 */

import type { Onboarding } from "./types";

export interface OnboardingItem {
  id: string;
  label: string;
  done: boolean;
  /** The check cannot run on this machine (no systemd, no desktop): not the user's to fix. */
  notApplicable?: boolean;
}

/**
 * The checklist, in the order a new user meets it. An item whose probe cannot
 * run here is marked `notApplicable` rather than failed — it is not the user's
 * to fix. This file is deliberately import-free: the board's bundle renders
 * it, so anything it pulled in would ship to the browser.
 */
export function onboardingItems(o: Onboarding): OnboardingItem[] {
  return [
    { id: "deps", label: "tmux and git are installed", done: o.depsOk },
    { id: "gh", label: "gh is installed and authenticated", done: o.ghReady },
    { id: "accounts", label: "an account is logged in", done: o.accountsReady },
    { id: "voice", label: "voice.env has its Deepgram and Anthropic keys", done: o.voiceReady },
    { id: "service", label: "the systemd service is installed", done: o.serviceInstalled !== false, notApplicable: o.serviceInstalled === null },
    { id: "linger", label: "it starts at boot, not first login", done: o.lingering !== false, notApplicable: o.lingering === null },
    { id: "pwa", label: "the board is installed as an app", done: o.pwaInstalled !== false, notApplicable: o.pwaInstalled === null },
  ];
}
