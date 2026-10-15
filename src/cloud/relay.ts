/**
 * The live relay's crypto: what a host sends a teammate's browser (a
 * superagent's chat page, its view, an action's answer) crosses Realtime
 * Broadcast sealed with an ephemeral ECDH P-256 key pair per read and
 * AES-GCM, bound to the read's id. Nothing sealed here is written to a
 * cloud table (docs/cloud.md, Shared superagents).
 */
const encode = (b: ArrayBuffer | Uint8Array) =>
  btoa(
    String.fromCharCode(
      ...new Uint8Array(
        b instanceof Uint8Array
          ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
          : b,
      ),
    ),
  );
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function relayIdentity() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"],
  );
  return {
    pair,
    key: encode(await crypto.subtle.exportKey("raw", pair.publicKey)),
  };
}
async function relayKey(pair: CryptoKeyPair, peer: string) {
  const publicKey = await crypto.subtle.importKey(
    "raw",
    decode(peer),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: publicKey },
    pair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function sealPage(
  pair: CryptoKeyPair,
  peer: string,
  id: string,
  page: unknown,
) {
  const data = new TextEncoder().encode(JSON.stringify(page));
  if (data.byteLength > 750000) throw new Error("Relay page too large");
  const key = await relayKey(pair, peer),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
      key,
      data,
    ),
  );
  // Chunk before base64 to stay below Realtime's per-event bound.
  const chunks = [];
  for (let at = 0; at < encrypted.length; at += 30000)
    chunks.push(encode(encrypted.slice(at, at + 30000)));
  return { iv: encode(iv), chunks };
}
export async function openPage<T = unknown>(
  pair: CryptoKeyPair,
  peer: string,
  id: string,
  iv: string,
  chunks: string[],
): Promise<T> {
  if (chunks.length > 26) throw new Error("Relay response too large");
  const all = chunks.map(decode),
    out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of all) {
    out.set(b, at);
    at += b.length;
  }
  const data = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode(iv),
      additionalData: new TextEncoder().encode(id),
    },
    await relayKey(pair, peer),
    out,
  );
  return JSON.parse(new TextDecoder().decode(data));
}
