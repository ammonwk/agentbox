import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { isPhone } from "./lib/phone";
import { reloadForMissingChunk } from "./lib/update";

// On a phone the app is lifted by the on-screen keyboard's height, so the
// keyboard shrinks it rather than panning the page (iOS never resizes the
// layout viewport). `data-kb` says you are typing: the keyboard is up, and the
// stylesheets put away everything but the conversation and the box. Focus is
// the signal rather than the viewport's height, which iOS reports late and
// which a hardware keyboard never changes.
const TYPING = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, [contenteditable="true"]';
const vv = window.visualViewport;
// What the layout viewport has below the visual one with no keyboard up.
// Installed to the Home Screen, iOS reports the visual viewport a status bar
// short; counted as keyboard, that lifted the app a status bar off the bottom
// of the screen. It is measured whenever nothing is being typed in, and
// neither lifts the app nor counts toward the keyboard.
let chrome = 0;
const fit = () => {
  const root = document.documentElement;
  if (!isPhone()) {
    root.style.removeProperty("--vvh");
    root.style.removeProperty("--kbh");
    delete root.dataset.kb;
    return;
  }
  const el = document.activeElement;
  const typing = el instanceof HTMLElement && el.matches(TYPING) && !el.closest(".xterm");
  if (vv) {
    root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    // What the keyboard covers of the layout viewport, which iOS never shrinks.
    const below = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    if (!typing) chrome = below;
    root.style.setProperty("--kbh", `${typing ? Math.max(0, below - chrome) : 0}px`);
  }
  if (typing) root.dataset.kb = "";
  else delete root.dataset.kb;
  if (window.scrollY) window.scrollTo(0, 0);
};
vv?.addEventListener("resize", fit);
vv?.addEventListener("scroll", fit);
addEventListener("resize", fit);
addEventListener("focusin", fit);
// Putting the page back the instant the box loses focus moves everything
// under the finger that tapped away, and the tap lands on whatever slid into
// its place. Hold the typing layout until the tap's click has gone through.
addEventListener("focusout", () => setTimeout(fit, 350));
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
