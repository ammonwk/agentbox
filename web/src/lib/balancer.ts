/** The balancer knobs, in words. Shared by Settings and Calibration. */

import type { BalancerSettings } from "../../../src/core/types";

/** What each balancer knob means, in one line.  */
export const BALANCER_HELP: Record<keyof BalancerSettings, { label: string; unit: string; help: string }> = {
  claimNormal: { label: "Default claim", unit: "pts", help: "Weekly points a session on an unknown model is assumed to use until it has actually used them. Known models claim what their model says (Fable 6, Opus 2.4, Sonnet 1.6, the small ones 0.8)." },
  shortWindowInWeekly: {
    label: "5-hour window in weekly",
    unit: "pts",
    help: "How many weekly points one full 5-hour window is worth; converts claims into 5-hour room.",
  },
  claimIdleMin: {
    label: "Cache goes cold after",
    unit: "min idle",
    help: "For a provider that does not say how long its prompt cache lives (Claude's does: an hour, or five minutes), a session idle this long counts as cold: it stops holding its claim and its account, and wakes on whichever account has room.",
  },
  resetHorizonMin: {
    label: "Reset horizon",
    unit: "min",
    help: "A 5-hour window this close to resetting counts as partly fresh.",
  },
};
