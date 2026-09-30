import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shownImage } from "../images";

const dir = mkdtempSync(join(tmpdir(), "agentbox-images-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
writeFileSync(join(dir, "shot.png"), PNG);
writeFileSync(join(dir, "a b.png"), PNG);
writeFileSync(join(dir, "fake.png"), "<html><script>alert(1)</script></html>");
writeFileSync(join(dir, "logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
writeFileSync(join(dir, "photo.webp"), Uint8Array.from([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBP"].map((c) => c.charCodeAt(0)))));
symlinkSync(join(dir, "shot.png"), join(dir, "link.png"));

describe("shownImage", () => {
  test("an absolute path, typed by its bytes", () => {
    expect(shownImage(join(dir, "shot.png"), null).mime).toBe("image/png");
    expect(shownImage(join(dir, "photo.webp"), null).mime).toBe("image/webp");
  });

  test("relative to the session's directory, or a file:// URL", () => {
    expect(shownImage("shot.png", dir).path).toBe(join(dir, "shot.png"));
    expect(shownImage("./a b.png", dir).path).toBe(join(dir, "a b.png"));
    expect(shownImage(`file://${dir}/shot.png`, null).path).toBe(join(dir, "shot.png"));
    expect(() => shownImage("shot.png", null)).toThrow(/relative/);
  });

  test("a symlink is served as what it points at", () => {
    expect(shownImage(join(dir, "link.png"), null).path).toBe(join(dir, "shot.png"));
  });

  test("never a page, a script or an SVG, whatever the name says", () => {
    expect(() => shownImage(join(dir, "fake.png"), null)).toThrow(/not a png/);
    expect(() => shownImage(join(dir, "logo.svg"), null)).toThrow(/not a png/);
    expect(() => shownImage(dir, null)).toThrow(/not a file/);
    expect(() => shownImage(join(dir, "gone.png"), null)).toThrow(/no such file/);
  });
});
