/** Moving a file or directory into another credential home. */

import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/**
 * `rename`, or copy-then-delete across filesystems. Refuses to overwrite: a
 * session already at the destination means something is wrong, and merging
 * two copies of a conversation is not ours to decide.
 */
export function moveInto(from: string, to: string): void {
  if (existsSync(to)) throw new Error(`${to} already exists`);
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, preserveTimestamps: true, errorOnExist: true });
    rmSync(from, { recursive: true, force: true });
  }
}
