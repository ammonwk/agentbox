/** A superagent's picture, set on the Agents page: its identity, not a
 *  session's, so it outlives every conversation. Kept under the agentbox
 *  home (0600), never in its directory or a checkout, and never pruned. */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { agentboxHome } from "../paths";
import { FleetError } from "../fleet";
import { imageExtension, imageMime } from "../uploads";

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const NAME = /^[0-9a-f]{24}\.(png|jpg|gif|webp)$/;
const root = () => join(agentboxHome(), "agents", "avatars");

/** The format the bytes are, whatever the request said. */
function sniff(b: Uint8Array): string | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

/** Save a picture; the name to record on the agent. */
export function saveAvatar(bytes: Uint8Array, mime: string): string {
  const ext = imageExtension(mime);
  if (!ext) throw new FleetError(400, "Choose a PNG, JPEG, GIF or WebP image");
  if (bytes.byteLength === 0) throw new FleetError(400, "The image is empty");
  if (bytes.byteLength > AVATAR_MAX_BYTES) throw new FleetError(413, `Choose an image of at most ${AVATAR_MAX_BYTES / 1024 / 1024} MB`);
  if (sniff(bytes) !== ext) throw new FleetError(400, "The file is not the image type it claims to be");
  mkdirSync(root(), { recursive: true, mode: 0o700 });
  const name = `${randomBytes(12).toString("hex")}.${ext}`;
  writeFileSync(join(root(), name), bytes, { mode: 0o600 });
  return name;
}

export function avatarFile(name: string): { path: string; mime: string } | null {
  if (!NAME.test(name)) return null;
  const path = join(root(), name);
  return existsSync(path) ? { path, mime: imageMime(name.split(".").pop()!)! } : null;
}

export function removeAvatar(name: string | undefined | null) {
  const f = name ? avatarFile(name) : null;
  if (f) rmSync(f.path, { force: true });
}
