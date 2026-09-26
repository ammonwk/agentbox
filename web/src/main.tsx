import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { isPhone } from "./lib/phone";

// On a phone the app is lifted by the on-screen keyboard's height, so the
// keyboard shrinks it rather than panning the page (iOS never resizes the
// layout viewport). `data-kb` says you are typing: the keyboard is up, and the
// stylesheets put away everything but the conversation and the box. Focus is
// the signal rather than the viewport's height, which iOS reports late and
// which a hardware keyboard never changes.
const TYPING = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, [contenteditable="true"]';
const vv = window.visualViewport;
const fit = () => {
  const root = document.documentElement;
  if (!isPhone()) {
    root.style.removeProperty("--vvh");
    root.style.removeProperty("--kbh");
    delete root.dataset.kb;
    return;
  }
  if (vv) {
    root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    // What the keyboard covers of the layout viewport, which iOS never shrinks.
    root.style.setProperty("--kbh", `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
  }
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.matches(TYPING) && !el.closest(".xterm")) root.dataset.kb = "";
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

// Installable as an app (Add to Home Screen); service workers need HTTPS.
if ("serviceWorker" in navigator && window.isSecureContext && location.port !== "5173") {
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
