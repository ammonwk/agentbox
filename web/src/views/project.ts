/** Opening the Project session from anywhere: straight there when it is
 *  running, else start (or resume) it first. Shared by the board's pinned row
 *  and the session rail's. */

import { useState } from "react";
import type { AppState } from "../../../src/core/types";
import { api } from "../api";

export function useOpenProject(state: AppState, onOpen: (id: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = state.sessions.find((x) => x.id === state.project.sessionId) ?? null;
  const running = !!session && session.host !== "none";

  async function open() {
    if (session && running) return onOpen(session.id);
    setBusy(true);
    setError(null);
    try {
      onOpen((await api.project()).id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return { session, running, busy, error, open };
}
