import { describe, expect, test } from "bun:test";
import { claudeBlockedOn } from "../providers/claude";
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
