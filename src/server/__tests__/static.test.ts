import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtEntry } from "../static";

function dist(html: string | null, assets: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "ab-dist-"));
  mkdirSync(join(root, "assets"));
  if (html !== null) writeFileSync(join(root, "index.html"), html);
  for (const a of assets) writeFileSync(join(root, "assets", a), "");
  return root;
}

const PAGE = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-D3v4lAc3.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-CV03agMb.css">
</head><body><div id="root"></div></body></html>`;

describe("builtEntry", () => {
  test("names the entry script index.html loads", () => {
    expect(builtEntry(dist(PAGE, ["index-D3v4lAc3.js"]))).toBe("index-D3v4lAc3.js");
  });

  test("is null while the entry it names is not on disk yet", () => {
    expect(builtEntry(dist(PAGE, []))).toBeNull();
  });

  test("is null when there is no build", () => {
    expect(builtEntry(dist(null))).toBeNull();
  });
});
