import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { isPhone } from "./lib/phone";
import { reloadForMissingChunk } from "./lib/update";

// On a phone the app is lifted by the on-screen keyboard's height, so the
// keyboard shrinks it rather than covering it (iOS never resizes the layout
// viewport; Android does, for `interactive-widget=resizes-content`, and then
// nothing is covered and nothing is lifted). The keyboard is what the visual
// viewport leaves uncovered at the bottom of the layout one, less that gap
// with no keyboard up: installed to the Home Screen, iOS reports the visual
// viewport a status bar short. The smallest gap seen is the one with no
// keyboard, so the baseline only ever gets more exact, whatever has focus and
// whenever the events come. `data-kb` says the keyboard is up, and the
// stylesheets put away everything but the conversation and the box; a
// hardware keyboard covers nothing, so it keeps them.
const vv = window.visualViewport;
/** The smallest gap seen, per width: rotating changes it. */
const floors = new Map<number, number>();
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
  const gap = window.innerHeight - vv.height - vv.offsetTop;
  const floor = Math.min(gap, floors.get(window.innerWidth) ?? Infinity);
  floors.set(window.innerWidth, floor);
  const kb = Math.max(0, Math.round(gap - floor));
  root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
  root.style.setProperty("--kbh", `${kb}px`);
  // Not every sliver: iOS's shortcut bar over a hardware keyboard is ~55px.
  if (kb > 80) root.dataset.kb = "";
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
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
