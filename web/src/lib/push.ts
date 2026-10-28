/** This device's side of notifications (src/core/push.ts): turning them on
 *  hands the server a push subscription, and a tapped notification opens its
 *  session in the app that is already running. */

import { api } from "../api";
import { go, parseHash } from "../route";

export type PushState =
  /** No push here: an iPhone has it only in the app on the Home Screen. */
  | "unsupported"
  /** Turned off for this site in the browser or the system's settings. */
  | "denied"
  | "off"
  | "on";

function supported(): boolean {
  // Electron has PushManager but no push service to subscribe to.
  if (/\bElectron\//.test(navigator.userAgent)) return false;
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
}

async function subscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && (await subscription()) ? "on" : "off";
}

function sameKey(sub: PushSubscription, key: string): boolean {
  const theirs = sub.options.applicationServerKey;
  if (!theirs) return false;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(theirs)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === key;
}

/** Ask, subscribe and tell the server. Must run in a tap: iOS only asks from one. */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return "unsupported";
  // First, before anything awaited, or the tap no longer counts.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const { publicKey } = await api.push();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // One made for another server key (a new database) can never be sent to.
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
  await api.pushSubscribe(sub.toJSON());
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const sub = await subscription();
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint);
    await sub.unsubscribe();
  }
  return pushState();
}

/**
 * At startup: give the server this device's subscription again, since a
 * browser may replace it and a server may have lost it, and go where a tapped
 * notification says (the service worker posts it rather than reload the app).
 */
export function startPush(): void {
  if (!supported()) return;
  navigator.serviceWorker.addEventListener("message", (e) => {
    const msg = e.data as { type?: string; url?: string } | null;
    if (msg?.type === "open" && msg.url) go(parseHash(new URL(msg.url, location.href).hash));
  });
  if (Notification.permission !== "granted") return;
  void subscription()
    .then((sub) => (sub ? api.pushSubscribe(sub.toJSON()) : undefined))
    .catch(() => undefined);
}
