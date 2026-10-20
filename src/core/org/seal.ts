/** Logins at rest in the store: AES-256-GCM under the org key, so the
 *  cluster's other users and its backups hold only ciphertext. */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const newOrgKey = (): string => randomBytes(32).toString("base64");

export function seal(key: string, value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function unseal<T = unknown>(key: string, sealed: string): T {
  const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !data) throw new Error("not a sealed login");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8")) as T;
}
