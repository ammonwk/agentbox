import { describe, expect, test } from "bun:test";
import { parseFrontmatterForTest as parseFrontmatter } from "../skills";

/**
 * The bug these pin: reading only the rest of the `description:` line captures
 * a block scalar's *indicator*, so a folded description rendered as a bare `>`
 * and its prose was discarded. Nine of eleven real skills on the author's
 * machine were affected, and nothing errored — the field was simply wrong.
 */
describe("parseFrontmatter", () => {
  const wrap = (body: string) => `---\n${body}\n---\nbody text here`;

  test("reads a plain inline scalar", () => {
    const fm = parseFrontmatter(wrap("name: thing\ndescription: A short one."));
    expect(fm.name).toBe("thing");
    expect(fm.description).toBe("A short one.");
  });

  test("strips surrounding quotes", () => {
    expect(parseFrontmatter(wrap(`description: "quoted"`)).description).toBe("quoted");
  });

  test("folds a `>` block into one paragraph", () => {
    const fm = parseFrontmatter(
      wrap("name: folded\ndescription: >\n  Remove signs of AI writing.\n  Use when editing text.")
    );
    expect(fm.description).toBe("Remove signs of AI writing. Use when editing text.");
  });

  test("keeps newlines in a `|` block", () => {
    const fm = parseFrontmatter(wrap("description: |\n  line one\n  line two"));
    expect(fm.description).toBe("line one\nline two");
  });

  test("handles chomping indicators", () => {
    for (const ind of ["|-", ">-", "|+", ">+"]) {
      const fm = parseFrontmatter(wrap(`description: ${ind}\n  some text`));
      expect(fm.description).toBe("some text");
    }
  });

  test("a blank line inside a folded block is a paragraph break", () => {
    const fm = parseFrontmatter(wrap("description: >\n  first para\n\n  second para"));
    expect(fm.description).toBe("first para\n\nsecond para");
  });

  test("the block ends at the next unindented key", () => {
    const fm = parseFrontmatter(wrap("description: |\n  the description\nname: after"));
    expect(fm.description).toBe("the description");
    expect(fm.name).toBe("after");
  });

  test("never yields a bare indicator — the original defect", () => {
    for (const ind of ["|", ">", "|-", ">-"]) {
      const fm = parseFrontmatter(wrap(`description: ${ind}\n  real prose`));
      expect(fm.description).not.toBe(ind);
      expect(fm.description).toBe("real prose");
    }
  });

  test("returns nothing when there is no frontmatter", () => {
    expect(parseFrontmatter("# Just a heading")).toEqual({});
  });
});
