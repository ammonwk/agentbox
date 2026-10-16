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
 * The page's own handles (UI state, no network of its own):
 *   useTeamAccess()                                → TeamAccess       the cloud client, the person and the workspace;
 *                                                                     one per page, shared through `TeamAccessContext`
 *   teamMembers(human, workspace)                  → the workspace's members, for the maintainers list
 *
 * With `?mock=1` every call answers from web/src/mock.ts (`mockTeam`) and
 * nothing reaches the network.
 *
 * Pages cross the cloud end-to-end encrypted (ECDH P-256 + AES-GCM, with
 * WebCrypto), so reading and acting need a secure context: https, localhost
 * or 127.0.0.1. `relayUnavailable()` says why not, or null. A host that is
 * off answers nothing: a read fails after 45 seconds with a message that
 * says so. A teammate never gets a terminal or any other session.
 */

import { createContext, useContext, useEffect, useMemo } from "react";
import type { HumanCloud } from "../../../src/cloud/client";
import type { Member, Person } from "../../../src/cloud/protocol";
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
import { MOCK } from "../api";
import { humanCloud, useCloudStatus, useCloudUser, useLoad, type Loaded } from "./cloud";
import { useScope } from "./projects";

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

/** The mock's answers (`?mock=1`), loaded only then. */
const mock = () => import("../mock").then((m) => m.mockTeam);

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
  if (MOCK) return (await mock()).directory();
  const r = await asPerson<{ instances: TeamInstance[] }>(human, "GET", `/api/team/superagents?workspace=${encodeURIComponent(workspace)}`);
  return r.instances;
}

/** The directory, read again every 30 seconds: a host goes off and on, a teammate shares or unshares. */
export function useTeamDirectory(human: HumanCloud | null, workspace: string | null): Loaded<TeamInstance[]> {
  const dir = useLoad(() => (human && workspace ? teamDirectory(human, workspace) : Promise.resolve([])), [human, workspace]);
  useEffect(() => {
    if (!human || !workspace) return;
    const t = setInterval(() => void dir.reload(), 30_000);
    return () => clearInterval(t);
  }, [human, workspace, dir.reload]);
  return dir;
}

export async function readChat(human: HumanCloud, instance: string, cursor: Partial<ChatCursor> = {}, signal?: AbortSignal): Promise<TeamChatPage> {
  if (MOCK) return (await mock()).readChat(instance, cursor);
  return teamAgents(human).readChat(instance, cursor, signal);
}

export async function readView(human: HumanCloud, instance: string, tab: string | null = null, signal?: AbortSignal): Promise<TeamViewPage> {
  if (MOCK) return (await mock()).readView(instance, tab);
  return teamAgents(human).readView(instance, tab, signal);
}

export async function guide(human: HumanCloud, instance: string, text: string, sendId: string, expectedSession: string): Promise<CommandReceipt> {
  if (MOCK) return (await mock()).guide(instance, text, sendId, expectedSession);
  return teamAgents(human).guide(instance, text, sendId, expectedSession);
}

export async function act(
  human: HumanCloud,
  instance: string,
  action: string,
  values: Record<string, unknown> = {},
  tab: string | null = null,
): Promise<{ receipt: CommandReceipt; answer: TeamActionAnswer | null }> {
  if (MOCK) return (await mock()).act(instance, action, values, tab);
  return teamAgents(human).act(instance, action, values, { tab });
}

export async function receipt(human: HumanCloud, id: string): Promise<CommandReceipt> {
  if (MOCK) return (await mock()).receipt(id);
  return teamAgents(human).receipt(id);
}

/** Share a superagent this machine runs. Only its host owner: the cloud checks your session. */
export async function share(human: HumanCloud, name: string, opts: { visibility: "private" | "workspace"; maintainers?: string[]; workspace?: string }): Promise<SuperagentInfo> {
  if (MOCK) return (await mock()).share(name, opts);
  return asPerson<SuperagentInfo>(human, "POST", `/api/superagents/${encodeURIComponent(name)}/share`, opts);
}

export async function unshare(human: HumanCloud, name: string): Promise<SuperagentInfo> {
  if (MOCK) return (await mock()).unshare(name);
  return asPerson<SuperagentInfo>(human, "DELETE", `/api/superagents/${encodeURIComponent(name)}/share`);
}

/** Why this browser cannot read shared superagents (not a secure context), or null. */
export function useRelayUnavailable(): string | null {
  return useMemo(() => relayUnavailable(), []);
}

/** The members of a workspace, with their names. */
export async function teamMembers(human: HumanCloud, workspace: string): Promise<(Member & { person: Person })[]> {
  if (MOCK) return (await mock()).members();
  return human.members(workspace);
}

/** What a page needs to show shared superagents: the cloud is set up here,
 *  the person signed in to it, and the workspace (the URL's scope, else the
 *  one this machine is registered in). `human` is null until all of that holds. */
export interface TeamAccess {
  /** The cloud is set up on this machine (cloud.env). */
  configured: boolean;
  /** The sign-in check finished. */
  ready: boolean;
  human: HumanCloud | null;
  userId: string | null;
  /** The workspace whose instances the rail lists. */
  workspace: string | null;
  /** The workspace this machine is registered in: a superagent is shared there. */
  hostWorkspace: string | null;
}

const NO_ACCESS: TeamAccess = { configured: false, ready: true, human: null, userId: null, workspace: null, hostWorkspace: null };
/** In the mock: a stand-in client that no call reads, since every call answers from the mock first. */
const MOCK_ACCESS: TeamAccess = { configured: true, ready: true, human: {} as HumanCloud, userId: "u-mock-you", workspace: "w-mock", hostWorkspace: "w-mock" };

export function useTeamAccess(): TeamAccess {
  const { status } = useCloudStatus(30_000);
  const human = useMemo(() => (!MOCK && status?.configured ? humanCloud(status) : null), [status?.configured, status?.url, status?.publishableKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const user = useCloudUser(human);
  const scope = useScope();
  if (MOCK) return MOCK_ACCESS;
  if (!status?.configured) return NO_ACCESS;
  const hostWorkspace = status.installation?.workspaceId ?? null;
  return {
    configured: true,
    ready: !!human && user.ready,
    human: user.userId ? human : null,
    userId: user.userId,
    workspace: scope.workspace || hostWorkspace,
    hostWorkspace,
  };
}

/** The page's one `useTeamAccess`, for the panes below it. */
export const TeamAccessContext = createContext<TeamAccess>(NO_ACCESS);
export const useTeam = () => useContext(TeamAccessContext);
