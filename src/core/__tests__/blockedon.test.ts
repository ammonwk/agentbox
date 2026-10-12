import { describe, expect, test } from "bun:test";
import { claudeBlockedOn } from "../providers/claude";
import { LIMIT_DIALOG } from "../providers/types";
import { codexBlockedOn } from "../providers/codex";
import { ompAdapter } from "../providers/omp";
import { claudeTurnErrorKind } from "../providers/claude-transcript";

const rule = "─".repeat(80);

const input = `${rule}
❯ 
${rule}
  375.0K tokens, ~/.local/share/agentbox/worktrees/g3gfg3tk
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents

  ● main
  ◯ rings-e        You are the next owner of three PRs                idle
`;

const grant = "Please run /login · API Error: 403 Access to this model requires an access grant your request does not have.";
const unauthorized = 'Please run /login · API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}';

const screen = (...messages: string[]) => `${messages.map((m) => `● ${m}\n`).join("\n")}\n${input}`;

describe("claudeBlockedOn: login", () => {
  test("a 401 as the last message needs a login", () => {
    expect(claudeBlockedOn(screen("Working on it.", unauthorized))).toBe("login required");
    expect(claudeBlockedOn(screen("Not logged in · Please run /login"))).toBe("login required");
  });

  test("an access grant refusal is not a login", () => {
    expect(claudeBlockedOn(screen("Teammate @rings-e finished", grant))).toBeNull();
  });

  test("a login error the session has moved past is history", () => {
    expect(claudeBlockedOn(screen(unauthorized, "Picking up where I left off."))).toBeNull();
  });

  test("a teammate's login failure is not this session's", () => {
    expect(claudeBlockedOn(screen(`Teammate @rings-e failed: ${unauthorized}`))).toBeNull();
  });

  test("the login dialog", () => {
    expect(claudeBlockedOn(" Select login method:\n\n ❯ 1. Claude account with subscription\n")).toBe("login required");
  });
});

describe("claudeTurnErrorKind: 403s", () => {
  test("an access grant is retried; a 401 is not", () => {
    expect(claudeTurnErrorKind(grant)).toBe("transient");
    expect(claudeTurnErrorKind(unauthorized)).toBe("fatal");
  });
});

/** Claude 2.1's Bash dialog: it stands where the input box was. */
const bashDialog = `● Clearing the probe directory

${rule}
 Bash command

   rm -rf ./*
   Clear the probe directory

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend
`;

describe("claudeBlockedOn: a dialog is where the input box was", () => {
  test("a live dialog", () => {
    expect(claudeBlockedOn(bashDialog)).toBe("permission: bash command");
    expect(claudeBlockedOn(" Quick safety check: Is this a project you trust?\n\n ❯ 1. Yes, I trust this folder\n   2. No, exit\n")).toBe("folder trust");
    expect(claudeBlockedOn(`${rule}\n Here is Claude's plan:\n Would you like to proceed?\n ❯ 1. Yes, and bypass permissions\n   2. No, keep planning\n`)).toBe("plan approval");
    expect(claudeBlockedOn(`${rule}\n Which rule?\n   1. One\n   2. Two\n${rule}\n❯ 3. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`)).toBe("asking a question");
  });

  test("a dialog's words in the conversation are not a dialog", () => {
    // A turn that ends on the question, a diff of the file that looks for
    // these, an earlier prompt still in view.
    expect(claudeBlockedOn(screen("The migration is ready. Do you want to proceed?"))).toBeNull();
    expect(claudeBlockedOn(screen("Here is the plan. Would you like to proceed?"))).toBeNull();
    expect(claudeBlockedOn(screen('if (/Yes, I trust this folder/.test(s) && /No, exit/.test(s)) return "folder trust";'))).toBeNull();
    expect(claudeBlockedOn(screen("It printed: Select login method"))).toBeNull();
    expect(claudeBlockedOn(`${bashDialog}\n● Done.\n\n${input}`)).toBeNull();
  });

  test("an input box left higher up the screen does not hide the dialog under it", () => {
    expect(claudeBlockedOn(`${input}\n${bashDialog}`)).toBe("permission: bash command");
  });
});

/** Claude 2.1 at its account's limit, as f9w4chcp showed it on 2026-10-11:
 *  the refused message, and a dialog where the input box was. */
const limitDialog = `❯ [agentbox: keeping this session's prompt cache warm while it waits; nothing has finished yet.]
  ⎿  You've hit your weekly limit · resets Oct 14, 11am (America/Denver)

✻ Churned for 0s · done 3:51 AM · 1 shell still running
${"▔".repeat(80)}
   What do you want to do?

   ❯ 1. Stop and wait for limit to reset
     2. Wait here, then continue automatically at Oct 14, 11am
     3. Add funds to continue with usage credits

   Enter to confirm · Esc to cancel
`;

describe("claudeBlockedOn: the usage limit dialog", () => {
  // Read as a prompt for you ("dialog open"), seven sessions sat at it for
  // hours while another account had half its week left: the fleet moves a
  // session that is stopped at its limit, and did not look at a blocked one.
  test("is the limit, not a prompt", () => {
    expect(claudeBlockedOn(limitDialog)).toBe(LIMIT_DIALOG);
    expect(claudeBlockedOn(`${input}\n${limitDialog}`)).toBe(LIMIT_DIALOG);
  });

  test("its words in the conversation, or once it is put away, are not", () => {
    expect(claudeBlockedOn(screen("It showed: 1. Stop and wait for limit to reset … Esc to cancel"))).toBeNull();
    expect(claudeBlockedOn(`${limitDialog}\n${input}`)).toBeNull();
  });
});

/** Codex 0.159's composer, under a message that quotes its prompts. */
const codexIdle = (said: string) => `• ${said}


› Ask Codex to do anything

  GPT-6-Luna xhigh · ~/Documents/agentbox · Main [default]
  ? for shortcuts
`;

/** Its folder-trust prompt, as it draws it for a folder it has not seen. */
const codexTrust = `  Folder access
  /tmp/abscan/work

  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings
  can run code automatically, even without a model request. Continue only if you trust these files. Your trust
  decision will be saved.

› 1. Trust and continue
  2. Back to Agent Command Center

  enter continue · esc back
`;

describe("codexBlockedOn: a prompt is where the composer was", () => {
  test("a live prompt, wherever its pointer is", () => {
    expect(codexBlockedOn(codexTrust)).toBe("folder trust");
    const approval = "  Would you like to run the following command?\n\n  $ rm -rf build\n\n  1. Yes, proceed (y)\n› 2. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel\n";
    expect(codexBlockedOn(approval)).toBe("approval: run command");
  });

  test("a prompt's words in the conversation are not a prompt", () => {
    expect(codexBlockedOn(codexIdle("It matches /Allow this request and continue/ and /Keep current model/."))).toBeNull();
    expect(codexBlockedOn(codexIdle("Trust this folder? is what it asks."))).toBeNull();
    expect(codexBlockedOn(`${codexTrust}\n${codexIdle("Trusted.")}`)).toBeNull();
  });
});

/** omp 17's editor: what is typed sits in the foot of its box. */
const ompEditor = `╭── π  > ⬢ Muse Spark 1.3 · ◕ xhigh > 🗑 agentbox > ◫ 1.7%/1M ⟲ ▶───────────╮
╰─                                                                          ─╯
`;

describe("omp blockedOn: a dialog is where the editor was", () => {
  const blockedOn = (s: string) => ompAdapter.blockedOn!(s);

  test("a live dialog", () => {
    expect(blockedOn(" Allow tool: bash\n rm -rf build\n\n ❯ Allow once\n   Deny\n")).toBe("permission: bash");
    expect(blockedOn(`${ompEditor}\n Allow tool: bash\n\n ❯ Allow once\n   Deny\n`)).toBe("permission: bash");
  });

  test("a dialog's words in the conversation are not a dialog", () => {
    expect(blockedOn(` It asked "Allow tool: bash" and I approved.\n\n${ompEditor}`)).toBeNull();
    expect(blockedOn(` Next: move session records to the new account.\n\n${ompEditor}`)).toBeNull();
  });

  test("no model to run on is said beside the editor", () => {
    expect(blockedOn(` No models available. Use /login or set an API key environment variable.\n\n${ompEditor}`)).toBe("login");
  });
});
