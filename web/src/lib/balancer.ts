/** The balancer knobs, in words. Shared by Settings and Calibration. */

import type { BalancerSettings } from "../../../src/core/types";

/** What each balancer knob means, in one line.  */
export const BALANCER_HELP: Record<keyof BalancerSettings, { label: string; unit: string; help: string }> = {
  claimNormal: { label: "Default claim", unit: "pts", help: "Weekly points a new session is assumed to use until its model has history here." },
  claimIdleMin: {
    label: "Cache goes cold after",
    unit: "min idle",
    help: "Idle this long, a session releases its claim and its account.",
  },
  resetHorizonMin: {
    label: "Reset horizon",
    unit: "min",
    help: "A 5-hour window this close to resetting counts as partly fresh.",
  },
  shortLoadPct: {
    label: "Load a 5-hour window to",
    unit: "%",
    help: "Fill the soonest-resetting account to this, then move to the next.",
  },
};
