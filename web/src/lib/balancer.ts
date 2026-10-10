/** The balancer knobs, in words. Shared by Settings and Calibration. */

import type { BalancerSettings } from "../../../src/core/types";

/** What each balancer knob means, in one line.  */
export const BALANCER_HELP: Record<keyof BalancerSettings, { label: string; unit: string; help: string }> = {
  claimNormal: { label: "Default claim", unit: "pts", help: "Weekly points a session is assumed to use before it has spent anything, when no session of its model has run here and the model is not a listed one. Otherwise a session claims what sessions of its model have gone on to use, or failing that its model's listed claim (Fable 3, Opus 1.2, Sonnet 0.8, the small ones 0.4), or what its provider's sessions use." },
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
  shortLoadPct: {
    label: "Load a 5-hour window to",
    unit: "%",
    help: "New sessions go to the account whose weekly resets soonest until its 5-hour window is forecast this full, then to the next to reset. The rest is the margin for sessions that turn out bigger than forecast. An account that could not use up its weekly at this rate is loaded further, up to 90%.",
  },
};
