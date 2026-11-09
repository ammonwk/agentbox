/**
 * A multi-line message typed into a TUI that is still on its splash arrives
 * as one message. tmux brackets a paste only for a pane that has asked for
 * bracketed paste, and turns each line break of an unbracketed one into
 * Enter: omp draws its logo for seconds on a loaded machine before it asks,
 * and a start prompt pasted then went out as one message per line.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agentbox-paste-"));
const socket = `agentbox-paste-test-${process.pid}`;
process.env.AGENTBOX_TMUX_SOCKET = socket;
const { sendText, capture } = await import("../tmux");

afterAll(() => {
  Bun.spawnSync(["tmux", "-L", socket, "kill-server"]);
  rmSync(dir, { recursive: true, force: true });
});

// Splash first, then raw mode and bracketed paste on, like omp's start; Enter
// outside a paste sends the draft.
const TUI = `
const sent = [];
let draft = "", pasting = false, buf = "";
const draw = () => process.stdout.write("\\x1b[2J\\x1b[H" + sent.map((s) => "sent: " + s + "\\r\\n").join("") + "> " + draft.replace(/\\n/g, " "));
process.stdout.write("SPLASH");
await Bun.sleep(1500);
process.stdin.setRawMode(true);
process.stdout.write("\\x1b[?2004h");
draw();
process.stdin.on("data", (d) => {
  buf += d.toString();
  for (;;) {
    if (buf.startsWith("\\x1b[200~")) { pasting = true; buf = buf.slice(6); continue; }
    if (buf.startsWith("\\x1b[201~")) { pasting = false; buf = buf.slice(6); continue; }
    if (!buf || (buf[0] === "\\x1b" && buf.length < 6)) break;
    const c = buf[0]; buf = buf.slice(1);
    if (c === "\\r" || c === "\\n") {
      if (pasting) draft += "\\n";
      else { sent.push(draft.replace(/\\n/g, "|")); draft = ""; }
    } else draft += c;
  }
  draw();
});
`;

test.skipIf(!Bun.which("tmux"))("a message pasted while the TUI is on its splash goes out whole", async () => {
  const tui = join(dir, "tui.ts");
  writeFileSync(tui, TUI);
  const name = "ab-paste";
  const made = Bun.spawnSync(["tmux", "-L", socket, "new-session", "-d", "-s", name, "-x", "120", "-y", "20", `bun ${tui}`]);
  expect(made.exitCode).toBe(0);
  await sendText(name, "first line of the brief\nsecond line of the brief");
  const sentRows = () => (capture(name) ?? "").split("\n").filter((row) => row.startsWith("sent: "));
  for (let tries = 0; tries < 40 && sentRows().length === 0; tries++) await Bun.sleep(100);
  await Bun.sleep(500);
  const sent = sentRows();
  expect(sent).toEqual(["sent: first line of the brief|second line of the brief"]);
}, 20_000);
