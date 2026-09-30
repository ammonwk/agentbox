import { describe, expect, test } from "bun:test";
import { landed, type Echo } from "../../../web/src/views/session/echo";

const at = 1_000_000;
const echo = (text: string): Echo => ({ sessionId: "s", text, at });

describe("landed", () => {
  test("a message recorded as it was typed", () => {
    expect(landed(echo("Why not merge 7330?"), [{ text: "Why not merge 7330?", at: at + 800 }])).toBe(true);
  });

  test("a message Claude recorded as a paste", () => {
    const text = "So the $805 Sentricon renewal figure is our extrapolation\nAnd the extrapolation is fine\n\nHow many were corrections?";
    const recorded = `\n\n<pasted_content id="6ebc">\n${text}\n</pasted_content id="6ebc">\n`;
    expect(landed(echo(text), [{ text: recorded, at: at + 800 }])).toBe(true);
  });

  test("not the same words said earlier, nor other words", () => {
    expect(landed(echo("Approved."), [{ text: "Approved.", at: at - 60_000 }])).toBe(false);
    expect(landed(echo("Approved."), [{ text: "Yes to both", at: at + 800 }])).toBe(false);
  });
});
