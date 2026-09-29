/** The first-run card: who agentbox derived you to be, and the one checklist
 *  of what is still unsetup — the same items `agentbox onboard` and `doctor`
 *  render (core/onboarding.ts), so no two views of "what is missing" can
 *  disagree. Sessions already running in your own terminals get their own
 *  line: adopting one stops its process and resumes it inside agentbox's
 *  tmux, so it is offered, never done on its own.
 */

import { useState } from "react";
import { api } from "../api";
import { Button, Icon } from "../components";
import { onboardingItems } from "../../../src/core/onboarding";
import type { Onboarding, Session } from "../../../src/core/types";

const DISMISS_KEY = "agentbox.onboardingDismissed";

export function OnboardingCard({ ob, sessions }: { ob: Onboarding; sessions: Session[] }) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const items = onboardingItems(ob).filter((it) => !it.done && !it.notApplicable);
  const external = sessions.filter((s) => s.host === "external");
  if (dismissed || (items.length === 0 && external.length === 0)) return null;

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

  return (
    <div className="banner banner-warn ob" role="status">
      <Icon.bolt size={15} />
      <div className="ob-body">
        <div className="ob-title">
          agentbox derived you as <strong>{ob.identity.name}</strong>
          {ob.identity.github ? ` (${ob.identity.github})` : ""} — from this machine's git and gh config. Here is what is left:
        </div>
        <ul className="ob-items">
          {items.map((it) => {
            const action = actionFor(it.id);
            return (
              <li key={it.id}>
                <span>{it.label}</span>
                {action ? (
                  <Button size="sm" variant="primary" onClick={action.run}>
                    {action.cta}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {external.length > 0 ? (
          <div className="ob-items">
            <div className="ob-external">
              <span>
                {external.length} session{external.length === 1 ? " is" : "s are"} running in your own terminals — adopting stops the process and
                resumes it here, so you can drive it from the board.
              </span>
              <Button size="sm" onClick={adoptAll}>
                {busy ? "Adopting…" : `Adopt all ${external.length}`}
              </Button>
            </div>
          </div>
        ) : null}
        {note ? <div className="ob-note">{note}</div> : null}
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon={Icon.x}
        aria-label="Dismiss onboarding"
        title="Dismiss — remembered per browser"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, "1");
          setDismissed(true);
        }}
      />
    </div>
  );
}
