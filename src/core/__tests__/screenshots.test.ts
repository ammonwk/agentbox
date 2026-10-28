/** The picker must not expose arbitrary paths or a screenshot swapped for a symlink. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recentScreenshots, screenshotImage } from "../screenshots";

test("only listed raster screenshots are served, newest first; arbitrary IDs and swapped links fail", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-screenshots-"));
  const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  try {
    for (let i = 0; i < 4; i++) {
      const path = join(root, `Screenshot ${i}.png`);
      writeFileSync(path, png);
      utimesSync(path, 100 + i, 100 + i);
    }
    writeFileSync(join(root, "Screenshot secret.png"), "not an image");
    writeFileSync(join(root, "ordinary.png"), png);
    symlinkSync(join(root, "ordinary.png"), join(root, "Screenshot link.png"));
    const listed = recentScreenshots([{ path: root, screenshotsOnly: true }]);
    expect(listed.map((s) => s.name)).toEqual(["Screenshot 3.png", "Screenshot 2.png", "Screenshot 1.png"]);
    expect(() => screenshotImage(join(root, "ordinary.png"))).toThrow("expired");
    expect(screenshotImage(listed[0]!.id).mime).toBe("image/png");
    const latest = join(root, "Screenshot 3.png");
    rmSync(latest);
    symlinkSync(join(root, "ordinary.png"), latest);
    expect(() => screenshotImage(listed[0]!.id)).toThrow("changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
