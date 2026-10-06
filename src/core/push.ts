/** Notifications on your devices when a session is blocked on you (Web Push).
 *
 * A device that turned them on (Settings) hands over a push subscription: an
 * endpoint at its browser's push service (Apple's, Google's, Mozilla's) and
 * the keys to encrypt for it. When a session turns blocked the server posts
 * an encrypted message there and the service wakes the installed app's
 * service worker (`web/public/sw.js`), which shows it — with the app closed,
 * and with the phone off the tailnet. The push service sees who the message
 * is from (the VAPID key) and its size, never what it says.
 *
 * The encryption (RFC 8291, `aes128gcm`) and the VAPID signature (RFC 8292)
 * are WebCrypto's, so there is no dependency. The key pair and the
 * subscriptions are in the database's key-value rows.
 */

import { retrying } from "./attention";
import { getKv, setKv } from "./db";
import type { Session } from "./types";

export type PushSubscription = {
  endpoint: string;
  /** The device's P-256 public key and its auth secret, base64url. */
  keys: { p256dh: string; auth: string };
  /** What subscribed, for the Settings list. */
  userAgent: string | null;
  createdAt: number;
};

export type PushMessage = {
  title: string;
  body: string;
  /** Where a tap goes: a path with the app's hash route. */
  url: string;
  /** A later message with the same tag takes the earlier one's place. */
  tag: string;
};

type Vapid = { publicKey: string; privateJwk: JsonWebKey };

/** Who a push service may write to about this sender; it must be a URL or a mailto. */
const VAPID_SUBJECT = "https://github.com/ammonwk/agentbox";
/** How long a push service keeps a message for a device that is off. */
const TTL_S = 4 * 60 * 60;
const RECORD_SIZE = 4096;

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function unb64url(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** A message sealed for one subscription: the body of the POST to its endpoint. */
export async function encryptPush(sub: Pick<PushSubscription, "keys">, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = unb64url(sub.keys.p256dh);
  const authSecret = unb64url(sub.keys.auth);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const mine = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", mine.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, mine.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // One record: the text, then 0x02 to say it is the last.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, sealed);
}

async function vapid(): Promise<Vapid> {
  const have = getKv<Vapid>("push.vapid");
  if (have?.publicKey && have.privateJwk) return have;
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const made: Vapid = {
    publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
  setKv("push.vapid", made);
  return made;
}

/** The key a browser subscribes with (`applicationServerKey`), base64url. */
export async function pushPublicKey(): Promise<string> {
  return (await vapid()).publicKey;
}

/** The `Authorization` header that says a push is this server's, for one push service. */
async function vapidAuth(endpoint: string): Promise<string> {
  const v = await vapid();
  const part = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: VAPID_SUBJECT,
  })}`;
  const key = await crypto.subtle.importKey("jwk", v.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned)));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${v.publicKey}`;
}

// ---------------------------------------------------------- subscriptions

export function pushSubscriptions(): PushSubscription[] {
  return getKv<PushSubscription[]>("push.subscriptions") ?? [];
}

/** A subscription as a browser gives it (`PushSubscription.toJSON()`), checked. */
export function parseSubscription(body: Record<string, unknown>, userAgent: string | null): PushSubscription {
  const keys = body.keys as Record<string, unknown> | undefined;
  const endpoint = body.endpoint;
  if (typeof endpoint !== "string" || typeof keys?.p256dh !== "string" || typeof keys.auth !== "string") {
    throw new Error("a push subscription needs endpoint, keys.p256dh and keys.auth");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("the push endpoint is not a URL");
  }
  // The server posts to this address: only a push service's, never one of its own network's.
  if (url.protocol !== "https:") throw new Error("the push endpoint must be https");
  if (unb64url(keys.p256dh).length !== 65 || unb64url(keys.auth).length !== 16) throw new Error("the push subscription's keys are malformed");
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent, createdAt: Date.now() };
}

export function addSubscription(sub: PushSubscription): void {
  const rest = pushSubscriptions().filter((s) => s.endpoint !== sub.endpoint);
  setKv("push.subscriptions", [...rest, sub]);
}

export function removeSubscription(endpoint: string): void {
  setKv("push.subscriptions", pushSubscriptions().filter((s) => s.endpoint !== endpoint));
}

// ------------------------------------------------------------------ sending

/** Send to one device; "gone" means the device dropped the subscription. */
async function sendTo(sub: PushSubscription, msg: PushMessage): Promise<"sent" | "gone" | string> {
  const body = await encryptPush(sub, enc.encode(JSON.stringify(msg)));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuth(sub.endpoint),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(TTL_S),
      urgency: "high",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return "sent";
  if (res.status === 404 || res.status === 410) return "gone";
  return `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim();
}

/** Send to every subscribed device; what went wrong, per device, comes back. */
export async function pushToAll(msg: PushMessage): Promise<{ sent: number; failed: string[] }> {
  let sent = 0;
  const failed: string[] = [];
  await Promise.all(
    pushSubscriptions().map(async (sub) => {
      const host = new URL(sub.endpoint).host;
      try {
        const r = await sendTo(sub, msg);
        if (r === "sent") sent++;
        else if (r === "gone") removeSubscription(sub.endpoint);
        else failed.push(`${host}: ${r}`);
      } catch (e) {
        failed.push(`${host}: ${(e as Error).message}`);
      }
    }),
  );
  return { sent, failed };
}

// ---------------------------------------------------- when a session blocks

/** The sessions already told about, for as long as they stay blocked. */
const told = new Set<string>();
let seeded = false;

/**
 * Called with the board whenever it changes: a session that has turned
 * blocked is pushed once, and again only after it has been unblocked. What
 * was blocked when the server started is not news. A stop the fleet retries
 * by itself (an error or rate-limit screen, `retrying`) is not yours to
 * answer, so it waits until the retries are spent.
 */
export function notifyBlocked(sessions: readonly Session[], reasonOf: (id: string) => string | null): void {
  const blocked = sessions.filter((s) => s.status === "blocked");
  const ids = new Set(blocked.map((s) => s.id));
  for (const id of told) if (!ids.has(id)) told.delete(id);
  if (!seeded) {
    seeded = true;
    for (const id of ids) told.add(id);
    return;
  }
  for (const s of blocked) {
    if (told.has(s.id)) continue;
    if (retrying(s)) continue;
    const reason = reasonOf(s.id) ?? "waiting on a prompt";
    told.add(s.id);
    if (pushSubscriptions().length === 0) continue;
    const ask = s.question?.questions[0]?.question;
    void pushToAll({
      title: s.label ?? s.title,
      body: ask ? `Asks: ${ask}` : `Blocked: ${reason}`,
      url: `/#/s/${encodeURIComponent(s.id)}${s.question ? "" : "/terminal"}`,
      tag: s.id,
    }).then((r) => {
      for (const f of r.failed) console.error(`agentbox: push for ${s.id} failed — ${f}`);
    });
  }
}
