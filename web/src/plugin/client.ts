/**
 * `agentbox/client`: what an extension's client may import (docs/extensions.md,
 * Its part in the app). It is the promise: what is here keeps working across
 * agentbox's updates, and what is not here is the app's own to change.
 * A build of the app ships it as its own entry, and the server points every
 * extension's `agentbox/client` (and `react`) at that file, so an extension
 * runs with this page's React and draws with its parts.
 *
 *   import { type Plugin, Icon, useAgentbox } from "agentbox/client";
 *   export default function (p: Plugin) {
 *     p.page({ id: "mine", label: "Mine", icon: Icon.extension, render: ({ state }) => <Mine state={state} /> });
 *   }
 */

import * as React from "react";
import * as JSX from "react/jsx-runtime";
import * as ReactDOM from "react-dom";
import { createElement, useMemo, type ReactNode } from "react";
import type { AppState } from "../../../src/core/types";
import { request } from "../api";
import { buildSessionIndex, withResolved } from "../lib/sessionrefs";
import { useResolvedSessions } from "../lib/sessionresolve";
import { prBaseFor } from "../lib/prlinks";
import { PrBase } from "../views/session/prbase";
import { SessionLinks } from "../views/session/sessionlinks";
import { useSeen } from "./registry";

/** The shared React, for the server's bundling of `react`, `react/jsx-runtime` and `react-dom`: not for an extension to import from here. */
export { React, JSX, ReactDOM };

export type { Plugin, PageDef, CommandDef, SettingsDef } from "./registry";
export type { AppState, Card, Session, Repo, Account, ExtensionInfo } from "../../../src/core/types";
export type { IconComponent } from "../components";
export { Button, Empty, ErrorBoundary, Icon, Modal, RelativeTime } from "../components";
export { Markdown } from "../views/session/Markdown";
export { describeAt } from "../../../src/core/schedule";
export { hrefOf as href, go, type Route } from "../route";

/** One call of agentbox's HTTP API (docs/v2.md, HTTP API): its `data`, or a throw with its `error`. */
export function call<T = unknown>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  return request<T>(method, path, body);
}

/** What the app is showing, live: all of it, the part the selected project filters to, and that project's id. */
export function useAgentbox(): { state: AppState; scoped: AppState; project: string | null } {
  return useSeen();
}

/**
 * Makes the `Markdown` inside it link what it names, as the app's own text
 * does: a session's id opens that session, and `#123` the pull request, in
 * the repo of `pr` (a pull request's URL), else of `session`'s.
 */
export function MarkdownLinks({ session, pr, children }: { session?: string | null; pr?: string | null; children: ReactNode }) {
  const { state } = useSeen();
  const resolved = useResolvedSessions();
  const links = useMemo(() => ({ index: withResolved(buildSessionIndex(state.sessions), resolved), self: null }), [state.sessions, resolved]);
  const base = useMemo(() => {
    const own = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/\d+/.exec(pr ?? "")?.[1];
    const asker = state.sessions.find((x) => x.id === session);
    return own ?? prBaseFor(asker ?? { repoRoot: null, prRepo: null }, state);
  }, [pr, session, state]);
  return createElement(PrBase.Provider, { value: base }, createElement(SessionLinks.Provider, { value: links }, children));
}
