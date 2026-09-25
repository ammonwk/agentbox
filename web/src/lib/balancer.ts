/** The balancer knobs, in words. Shared by Settings and Calibration. */

import type { BalancerSettings } from "../../../src/core/types";

/** What each balancer knob means, in one line.  */
export const BALANCER_HELP: Record<keyof BalancerSettings, { label: string; unit: string; help: string }> = {
  claimNormal: { label: "Normal claim", unit: "pts", help: "Weekly points a new session is assumed to use until it has actually used them." },
  claimBig: { label: "Big claim", unit: "pts", help: "The same, for a session started as Big." },
  shortWindowInWeekly: {
    label: "5-hour window in weekly",
    unit: "pts",
    help: "How many weekly points one full 5-hour window is worth; converts claims into 5-hour room.",
  },
  claimIdleMin: {
    label: "Cache goes cold after",
    unit: "min idle",
    help: "A session idle this long stops holding its claim and its account: its prompt cache is cold, so it wakes on whichever account has room.",
  },
  resetHorizonMin: {
    label: "Reset horizon",
    unit: "min",
    help: "A 5-hour window this close to resetting counts as partly fresh.",
  },
  tieBand: { label: "Tie band", unit: "pts", help: "Accounts within this much 5-hour room of the best are tied; ties go to weekly left per hour." },
};
