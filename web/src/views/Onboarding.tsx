/** The first-run card: who agentbox derived you to be, and the few things it
 *  could not set up by itself — an account, the voice keys, the service.
 *  Everything here was detected, not asked for; dismissing is remembered and
 *  a complete list never shows.
 */

import { useState } from "react";
import { api } from "../api";
import { Button, Icon } from "../components";
import type { Onboarding } from "../../../src/core/types";

const DISMISS_KEY = "agentbox.onboardingDismissed";

export function OnboardingCard({ ob }: { ob: Onboarding }) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (dismissed) return null;

  const items: { label: string; action: () => void; cta: string }[] = [];
  if (!ob.hasAccount) {
    items.push({ label: "Add an account, so there is somewhere to place sessions", cta: "Accounts", action: () => (location.hash = "#/accounts") });
  }
  if (!ob.voiceReady) {
    items.push({
      label: "Hands-free mode needs a Deepgram and an Anthropic key in voice.env",
      cta: "Voice",
      action: () => (location.hash = "#/voice"),
    });
  }
  if (ob.serviceInstalled === false) {
    items.push({
      label: "Install the systemd user service, so the board starts at boot and survives this terminal",
      cta: busy ? "Installing…" : "Install",
      action: () => {
        setBusy(true);
        setError(null);
        api.installService().then(
          () => undefined,
          (e: Error) => setError(e.message),
        )
          .finally(() => setBusy(false));
      },
    });
  }
  if (!items.length) return null;

  return (
    <div className="banner banner-warn ob" role="status">
      <Icon.bolt size={15} />
      <div className="ob-body">
        <div className="ob-title">
          agentbox derived you as <strong>{ob.identity.name}</strong>
          {ob.identity.github ? ` (${ob.identity.github})` : ""} — from this machine's git and gh config, in{" "}
          {ob.identity.timezone}. Nothing was asked that the machine already knew.
        </div>
        <ul className="ob-items">
          {items.map((it, i) => (
            <li key={i}>
              <span>{it.label}</span>
              <Button size="sm" variant={i === 0 ? "primary" : "default"} onClick={it.action}>
                {it.cta}
              </Button>
            </li>
          ))}
        </ul>
        {error ? <div className="ob-error">{error}</div> : null}
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
