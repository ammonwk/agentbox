import { expect, test } from "bun:test";
import { devinQueuedCount } from "../providers/devin";

test("devinQueuedCount reads the queued footer", () => {
  const busy = `⢠⡀ Running tools · 137m 31s (esc twice to interrupt)
── 2 queued ─────────────────────────────── ↑ edit · ↵ send now ──
○ [via agentbox send] Before going further
❭ Press Enter to send queued messages now`;
  expect(devinQueuedCount(busy)).toBe(2);
  expect(devinQueuedCount(busy.replace("2 queued", "1 queued"))).toBe(1);
  expect(devinQueuedCount("❭ Ask Devin to build features, fix bugs, or work on your code")).toBe(0);
});
