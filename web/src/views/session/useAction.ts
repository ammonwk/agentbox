import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Run one API call at a time and keep its failure visible.
 *
 * Every mutation on this screen goes through here so that "every failure is
 * legible" is structural rather than something each callsite remembers: the
 * error string is state, not a swallowed catch, and `busy` is always cleared.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const clear = useCallback(() => setError(null), []);

  return { run, busy, error, clear };
}
