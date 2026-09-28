import { describe, expect, test } from "bun:test";
import { claudeApprovePrompt } from "../providers/claude";

const rule = "─".repeat(80);

/** Claude 2.1's Bash dialog, which bypass mode still raises for this `rm`. */
const dangerousRm = `● Testing park and resume for devin and omp agents
  ⎿  $ mkdir -p /tmp/devin-probe/park && cd /tmp/devin-probe/park && rm -rf ./*

${rule}
 Bash command

   mkdir -p /tmp/devin-probe/park && cd /tmp/devin-probe/park && rm -rf ./* && echo "bravo" > b.txt
   Test park and resume for devin and omp agents

 Dangerous rm operation on statically-unresolvable target: /home/me/worktrees/vzmu5tfq/*

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend


`;

const input = `${rule}
❯
${rule}
  45.0K tokens, ~/Documents/agentbox
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

describe("claudeApprovePrompt", () => {
  test("allows a Bash prompt once", () => {
    expect(claudeApprovePrompt(dangerousRm)).toEqual(["Enter"]);
  });

  test("moves to Yes when the pointer is elsewhere", () => {
    expect(claudeApprovePrompt(dangerousRm.replace(" ❯ 1. Yes\n   2. No", "   1. Yes\n ❯ 2. No"))).toEqual(["Up", "Enter"]);
  });

  test("allows an edit once, not for the session", () => {
    const edit = `${rule}
 Edit file
 src/a.ts
 Do you want to make this edit to a.ts?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No, and tell Claude what to do differently (esc)

 Esc to cancel
`;
    expect(claudeApprovePrompt(edit)).toEqual(["Enter"]);
  });

  test("leaves a prompt quoted above the input box alone", () => {
    expect(claudeApprovePrompt(dangerousRm.trimEnd() + "\n\n● Done.\n\n" + input)).toBeNull();
  });

  test("leaves questions and plan approval alone", () => {
    const question = `${rule}
 Which rule should #7074 use?
 ❯ 1. Phone + caller rule (Recommended)
   2. Correct all 513
   3. Yes

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
    expect(claudeApprovePrompt(question)).toBeNull();
    const plan = `${rule}
 Here is Claude's plan: ...
 Would you like to proceed?
 ❯ 1. Yes, and bypass permissions
   2. Yes, manually approve edits
   3. No, keep planning
`;
    expect(claudeApprovePrompt(plan)).toBeNull();
  });
});
