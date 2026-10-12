import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { startAccent } from "./lib/accent";
import { isPhone } from "./lib/phone";
import { startPush } from "./lib/push";
import { reloadForMissingChunk } from "./lib/update";
import { followLinks, listUnderSession } from "./route";

// On a phone the app is lifted by the on-screen keyboard's height, so the
// keyboard shrinks it rather than covering it (iOS never resizes the layout
// viewport; Android does, for `interactive-widget=resizes-content`, and then
// nothing is covered and nothing is lifted). The keyboard is what the visual
// viewport leaves uncovered at the bottom of the layout one, less that gap
// with no keyboard up: installed to the Home Screen, iOS reports the visual
// viewport a status bar short. Any reading within a sliver of the baseline is
// one with no keyboard, so it becomes the baseline: a bad one is replaced by
// the next. Neither counts how far iOS has panned the page, since the pan is
// undone here: while the keyboard goes, iOS gives the height back before it
// pans back down, which read as hundreds of pixels below zero and lifted the
// app by them until a reload; while it comes, iOS pans the box into view, the
// keyboard less the pan read as nothing, and undoing the pan sends no event
// to measure again. `data-kb` says the keyboard is up, and the
// stylesheets put away everything but the conversation and the box; a
// hardware keyboard covers nothing, so it keeps them.
const vv = window.visualViewport;
/** The gap with no keyboard up, per width: rotating changes it. */
const floors = new Map<number, number>();
/** Less than any keyboard; more than iOS's shortcut bar over a hardware one. */
const SLIVER = 80;
const fit = () => {
  const root = document.documentElement;
  if (!isPhone() || !vv) {
    root.style.removeProperty("--vvh");
    root.style.removeProperty("--kbh");
    delete root.dataset.kb;
    return;
  }
  // Pinched in, the visual viewport is a window on the page, not a keyboard's
  // leftovers: leave the layout as it was.
  if (vv.scale > 1.01) return;
  const short = Math.max(0, window.innerHeight - vv.height);
  let floor = floors.get(window.innerWidth) ?? Infinity;
  if (short < floor + SLIVER) floors.set(window.innerWidth, (floor = short));
  const kb = Math.max(0, Math.round(short - floor));
  root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
  root.style.setProperty("--kbh", `${kb}px`);
  if (kb > SLIVER) root.dataset.kb = "";
  else delete root.dataset.kb;
  if (window.scrollY) window.scrollTo(0, 0);
};
vv?.addEventListener("resize", fit);
vv?.addEventListener("scroll", fit);
addEventListener("resize", fit);
fit();

// A lazy chunk that will not load is one a rebuild deleted (lib/update.ts).
addEventListener("vite:preloadError", () => void reloadForMissingChunk());

// Installable as an app (Add to Home Screen); service workers need HTTPS.
if ("serviceWorker" in navigator && window.isSecureContext && location.port !== "5173") {
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  startPush();
}

listUnderSession();
startAccent();
const root = document.getElementById("root")!;
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
followLinks(root);
