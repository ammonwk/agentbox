/**
 * Shared superagents, as a page uses them with the signed-in person's cloud
 * session (docs/cloud.md, "Shared superagents"). No UI here: the Agents page
 * consumes this API.
 *
 * Read (any instance you can see: you maintain it, or its visibility is
 * `workspace`):
 *   teamDirectory(human, workspace)            → TeamInstance[]   the instances you can see, `here` when this machine hosts it
 *   useTeamDirectory(human, workspace)         → Loaded<TeamInstance[]>
 *   readChat(human, instance, cursor?)         → TeamChatPage     a page of its chat; pass `page.before` back for older
 *                                                                 messages, and `page.session` to `guide`
 *   readView(human, instance, tab?)            → TeamViewPage     its page: `view` is the program's SuperagentView
 *
 * Write (the same people):
 *   guide(human, instance, text, sendId, expectedSession) → CommandReceipt
 *                                                    guidance to its main conversation, typed only into
 *                                                    `expectedSession`; reuse `sendId` (a UUID) for a retry
 *   act(human, instance, action, values, tab?)     → { receipt, answer }
 *                                                    a page action; `answer` is the program's reply (or null
 *                                                    when it was refused before it ran: read `receipt.result`)
 *   receipt(human, id)                             → CommandReceipt   how a guide or an action ended
 *
 * The host owner only (this machine's installation is theirs):
 *   share(human, name, {visibility, maintainers})  → SuperagentInfo   through this machine's server, which
 *   unshare(human, name)                           → SuperagentInfo   passes your session token to the cloud
 *
 * Pages cross the cloud end-to-end encrypted (ECDH P-256 + AES-GCM, with
 * WebCrypto), so reading and acting need a secure context: https, localhost
 * or 127.0.0.1. `relayUnavailable()` says why not, or null. A host that is
 * off answers nothing: a read fails after 45 seconds with a message that
 * says so. A teammate never gets a terminal or any other session.
 */

import { useMemo } from "react";
import type { HumanCloud } from "../../../src/cloud/client";
import {
  HumanSuperagents,
  relayUnavailable,
  type ChatCursor,
  type CommandReceipt,
  type SuperagentInstance,
  type TeamActionAnswer,
  type TeamChatEvent,
  type TeamChatPage,
  type TeamViewPage,
} from "../../../src/cloud/superagents";
import type { SuperagentInfo } from "../../../src/core/types";
import { useLoad, type Loaded } from "./cloud";

export { relayUnavailable };
export type { ChatCursor, CommandReceipt, SuperagentInstance, TeamActionAnswer, TeamChatEvent, TeamChatPage, TeamViewPage };

/** An instance as the directory shows it: `here` when this machine hosts it (its local name is `name`). */
export type TeamInstance = SuperagentInstance & { here: boolean };

const clients = new WeakMap<HumanCloud, HumanSuperagents>();
/** The person's shared-superagent client, one per signed-in cloud client. */
export function teamAgents(human: HumanCloud): HumanSuperagents {
  let c = clients.get(human);
  if (!c) clients.set(human, (c = new HumanSuperagents(human.sb)));
  return c;
}

async function token(human: HumanCloud): Promise<string> {
  const { data } = await human.sb.auth.getSession();
  const t = data.session?.access_token;
  if (!t) throw new Error("Sign in on the Team page first.");
  return t;
}

/** A call to this machine's server that acts as the signed-in person. */
async function asPerson<T>(human: HumanCloud, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${await token(human)}` };
  if (method !== "GET") headers["x-agentbox"] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let env: { ok?: boolean; data?: unknown; error?: string };
  try {
    env = JSON.parse(text) as typeof env;
  } catch {
    throw new Error(`${path}: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }
  if (!env.ok) throw new Error(env.error || `${path}: ${res.status} ${res.statusText}`);
  return env.data as T;
}

/** The instances of `workspace` you can see, from this machine's server (it marks what it hosts). */
export async function teamDirectory(human: HumanCloud, workspace: string): Promise<TeamInstance[]> {
  const r = await asPerson<{ instances: TeamInstance[] }>(human, "GET", `/api/team/superagents?workspace=${encodeURIComponent(workspace)}`);
  return r.instances;
}

export function useTeamDirectory(human: HumanCloud | null, workspace: string | null): Loaded<TeamInstance[]> {
  return useLoad(() => (human && workspace ? teamDirectory(human, workspace) : Promise.resolve([])), [human, workspace]);
}

export function readChat(human: HumanCloud, instance: string, cursor: Partial<ChatCursor> = {}, signal?: AbortSignal): Promise<TeamChatPage> {
  return teamAgents(human).readChat(instance, cursor, signal);
}

export function readView(human: HumanCloud, instance: string, tab: string | null = null, signal?: AbortSignal): Promise<TeamViewPage> {
  return teamAgents(human).readView(instance, tab, signal);
}

export function guide(human: HumanCloud, instance: string, text: string, sendId: string, expectedSession: string): Promise<CommandReceipt> {
  return teamAgents(human).guide(instance, text, sendId, expectedSession);
}

export function act(
  human: HumanCloud,
  instance: string,
  action: string,
  values: Record<string, unknown> = {},
  tab: string | null = null,
): Promise<{ receipt: CommandReceipt; answer: TeamActionAnswer | null }> {
  return teamAgents(human).act(instance, action, values, { tab });
}

export function receipt(human: HumanCloud, id: string): Promise<CommandReceipt> {
  return teamAgents(human).receipt(id);
}

/** Share a superagent this machine runs. Only its host owner: the cloud checks your session. */
export function share(human: HumanCloud, name: string, opts: { visibility: "private" | "workspace"; maintainers?: string[]; workspace?: string }): Promise<SuperagentInfo> {
  return asPerson<SuperagentInfo>(human, "POST", `/api/superagents/${encodeURIComponent(name)}/share`, opts);
}

export function unshare(human: HumanCloud, name: string): Promise<SuperagentInfo> {
  return asPerson<SuperagentInfo>(human, "DELETE", `/api/superagents/${encodeURIComponent(name)}/share`);
}

/** Why this browser cannot read shared superagents (not a secure context), or null. */
export function useRelayUnavailable(): string | null {
  return useMemo(() => relayUnavailable(), []);
}
