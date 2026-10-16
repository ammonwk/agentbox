/** The web app's handles on the agentbox cloud: this machine's status from
 *  the local server, and the signed-in human's client, which talks to the
 *  cloud directly with the publishable key. The human's session lives in
 *  this browser's storage, under a key per project; the machine never sees
 *  it. */

import { useCallback, useEffect, useRef, useState } from "react";
import { HumanCloud, supabaseFor } from "../../../src/cloud/client";
import type { CloudStatus } from "../../../src/core/cloud/bridge";
import type { PersonalDefaults } from "../../../src/cloud/protocol";
import { api } from "../api";
import { CLOUD_DEFAULTS_KEY } from "./newsession";

/** Keep the signed-in human's personal defaults for the new-session dialog
 *  (null: signed out, forget them). */
export function rememberDefaults(d: PersonalDefaults | null): void {
  try {
    if (d) localStorage.setItem(CLOUD_DEFAULTS_KEY, JSON.stringify(d));
    else localStorage.removeItem(CLOUD_DEFAULTS_KEY);
  } catch {
    // private mode: the dialog starts plain
  }
}

let cached: { key: string; human: HumanCloud } | null = null;

export function humanCloud(status: Pick<CloudStatus, "url" | "publishableKey">): HumanCloud | null {
  if (!status.url || !status.publishableKey) return null;
  const key = `${status.url} ${status.publishableKey}`;
  if (cached?.key !== key) {
    const sb = supabaseFor(
      { url: status.url, publishableKey: status.publishableKey },
      { persistSession: true, storage: localStorage, storageKey: `agentbox.cloud.auth.${new URL(status.url).host}`, detectSessionInUrl: true },
    );
    cached = { key, human: new HumanCloud(sb) };
  }
  return cached.human;
}

/** Where an emailed sign-in link brings this browser back: the app, which
 *  opens the Team page when it sees `?cloud`. */
export const signInRedirect = (): string => `${location.origin}/?cloud=1`;

/** The app was opened by a sign-in link. */
export const openedBySignIn = (): boolean => new URLSearchParams(location.search).has("cloud");

export function useCloudStatus(everyMs = 5_000): { status: CloudStatus | null; error: string | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await api.cloud());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), everyMs);
    return () => clearInterval(t);
  }, [refresh, everyMs]);
  return { status, error, refresh };
}

declare global {
  interface Window {
    /** The desktop app (desktop/preload.cjs). */
    agentboxDesktop?: { githubToken(): Promise<string | null> };
  }
}

const LINKED_KEY = (userId: string) => `agentbox.cloud.github-linked.${userId}`;
let desktopSignIn: Promise<void> | null = null;

/** In the desktop app, this machine's GitHub CLI login signs it in
 *  (supabase/functions/github-session): once a human has signed in with
 *  their email here, their GitHub user is linked to them, and from then on
 *  gh's login is enough on any machine. Nothing happens in a browser. */
async function githubSession(human: HumanCloud, action: "signin" | "link"): Promise<{ access_token: string; refresh_token: string } | null> {
  const githubToken = await window.agentboxDesktop?.githubToken().catch(() => null);
  if (!githubToken) return null;
  const { data, error } = await human.sb.functions.invoke("github-session", { body: { action, githubToken } });
  if (error) {
    console.warn(`agentbox: GitHub ${action}:`, (await (error as { context?: Response }).context?.json?.().catch(() => null))?.error ?? error.message);
    return null;
  }
  return data;
}

function signInWithGitHub(human: HumanCloud): Promise<void> {
  // Each page using the hook asks at once; one exchange serves them all.
  desktopSignIn ??= githubSession(human, "signin")
    .then(async (s) => {
      if (s) await human.sb.auth.setSession(s);
    })
    .finally(() => (desktopSignIn = null));
  return desktopSignIn;
}

function linkGitHub(human: HumanCloud, userId: string): void {
  if (!window.agentboxDesktop) return;
  try {
    if (localStorage.getItem(LINKED_KEY(userId))) return;
  } catch {
    // private mode: link again; it is idempotent
  }
  void githubSession(human, "link").then((r) => {
    if (!r) return;
    try {
      localStorage.setItem(LINKED_KEY(userId), "1");
    } catch {
      // as above
    }
  });
}

/** The signed-in human's id, following sign-in and sign-out; `ready` once
 *  a magic link in the URL, if any, has been exchanged, and in the desktop
 *  app once its GitHub login has been tried. */
export function useCloudUser(human: HumanCloud | null): { ready: boolean; userId: string | null; email: string | null } {
  const [s, setS] = useState<{ ready: boolean; userId: string | null; email: string | null }>({ ready: false, userId: null, email: null });
  useEffect(() => {
    if (!human) return;
    let live = true;
    void human.sb.auth.getSession().then(async ({ data }) => {
      if (!data.session && window.agentboxDesktop) await signInWithGitHub(human);
      const session = data.session ?? (await human.sb.auth.getSession()).data.session;
      if (!live) return;
      setS({ ready: true, userId: session?.user.id ?? null, email: session?.user.email ?? null });
      if (session) linkGitHub(human, session.user.id);
      if (openedBySignIn()) history.replaceState(null, "", `${location.pathname}${location.hash || "#/team"}`);
    });
    const { data } = human.sb.auth.onAuthStateChange((event, session) => {
      setS({ ready: true, userId: session?.user.id ?? null, email: session?.user.email ?? null });
      if (event === "SIGNED_IN" && session) linkGitHub(human, session.user.id);
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, [human]);
  return s;
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/** `fn`'s answer, loaded again when `deps` change or on `reload`. */
export function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ref = useRef(fn);
  ref.current = fn;
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const v = await ref.current();
      if (mine === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload };
}
