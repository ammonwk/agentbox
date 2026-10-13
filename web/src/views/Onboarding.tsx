/** The first-run checklist, in the inbox (Inbox.tsx): who agentbox derived
 *  you to be, and what is still unsetup — the same items `agentbox onboard`
 *  and `doctor` render (core/onboarding.ts), so no two views of "what is
 *  missing" can disagree. Sessions already running in your own terminals get
 *  their own line: adopting one stops its process and resumes it inside
 *  agentbox's tmux, so it is offered, never done on its own.
 */

import { useState, type ReactNode } from "react";
import { api } from "../api";
import { Button, Icon } from "../components";
import { onboardingItems } from "../../../src/core/onboarding";
import type { Onboarding, Session } from "../../../src/core/types";

const DISMISS_KEY = "agentbox.onboardingDismissed";

/** The checklist's rows for the inbox, and how many there are. A hook, so
 *  the bell can count them and an adopt goes on while the inbox is shut. */
export function useOnboardingInbox(ob: Onboarding | null, sessions: readonly Session[]): { count: number; node: ReactNode } {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const items = ob ? onboardingItems(ob).filter((it) => !it.done && !it.notApplicable) : [];
  const external = sessions.filter((s) => s.host === "external");
  if (!ob || dismissed || (items.length === 0 && external.length === 0)) return { count: 0, node: null };

  /** Installing covers both service items: it writes the unit, enables it,
   *  and turns lingering on — idempotent, so either gap is fixed by it. */
  async function installService() {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.installService();
      setNote(r.lingering ? "Service installed; it starts at boot." : "Service installed, but start-at-boot is off — run `loginctl enable-linger`.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** One at a time, and the endpoint refuses anything it should not touch;
   *  each outcome is reported, so a refusal is information, not a dead end. */
  async function adoptAll() {
    setBusy(true);
    setNote(null);
    const done: string[] = [];
    const failed: string[] = [];
    for (const s of external) {
      try {
        await api.adopt(s.id);
        done.push(s.id);
      } catch (e) {
        failed.push(`${s.id} — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBusy(false);
    setNote(
      failed.length === 0
        ? `Adopted ${done.length} session${done.length === 1 ? "" : "s"}.`
        : `Adopted ${done.length}, could not adopt ${failed.length}: ${failed.join("; ")}`,
    );
  }

  /** The one action per item; items without one are advice for the terminal. */
  const actionFor = (id: string): { cta: string; run: () => void } | undefined =>
    id === "accounts"
      ? { cta: "Accounts", run: () => (location.hash = "#/accounts") }
      : id === "voice"
        ? { cta: "Voice", run: () => (location.hash = "#/voice") }
        : id === "service" || id === "linger"
          ? { cta: busy ? "Working…" : id === "linger" ? "Enable" : "Install", run: () => void installService() }
          : undefined;

  const node = (
    <section className="inbox-group" aria-label="Setup">
      <div className="inbox-group-head">
        <span>Setup</span>
        <button
          type="button"
          className="inbox-dismiss"
          aria-label="Dismiss setup"
          title="Dismiss — remembered per browser"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, "1");
            setDismissed(true);
          }}
        >
          <Icon.x size={12} />
        </button>
      </div>
      <p className="inbox-sub">
        agentbox derived you as <strong>{ob.identity.name}</strong>
        {ob.identity.github ? ` (${ob.identity.github})` : ""} from this machine's git and gh config. Here is what is left:
      </p>
      {items.map((it) => {
        const action = actionFor(it.id);
        return (
          <div className="inbox-row" key={it.id}>
            <Icon.bolt size={14} className="inbox-icon" />
            <span className="inbox-text">{it.label}</span>
            {action ? (
              <Button size="sm" variant="primary" onClick={action.run}>
                {action.cta}
              </Button>
            ) : null}
          </div>
        );
      })}
      {external.length > 0 ? (
        <div className="inbox-row">
          <Icon.link size={14} className="inbox-icon" />
          <span className="inbox-text">
            {external.length} session{external.length === 1 ? " is" : "s are"} running in your own terminals. Adopting stops the process and
            resumes it here, so you can drive it from the board.
          </span>
          <Button size="sm" onClick={adoptAll}>
            {busy ? "Adopting…" : `Adopt all ${external.length}`}
          </Button>
        </div>
      ) : null}
      {note ? <p className="inbox-note">{note}</p> : null}
    </section>
  );
  return { count: items.length + (external.length > 0 ? 1 : 0), node };
}
