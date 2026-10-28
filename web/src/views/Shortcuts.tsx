import { Modal } from "../components";
import { ACTIONS, FIXED, isAppOnly, keysOf, showCombo, useKeybindings } from "../lib/keybinds";
import { isInstalledApp } from "../lib/phone";
import { go } from "../route";

const ORDER = ["Anywhere", "Sessions", "Composer", "New session", "Review"];

/** Every key the board answers to: `?` opens it. It reads the keybinds
 *  (lib/keybinds.ts), so a key changed in Settings shows here; one only the
 *  installed app gets is left out in a browser tab. */
function groups(): [string, [string[], string][]][] {
  const app = isInstalledApp();
  return ORDER.map((group) => {
    const rows: [string[], string][] = [
      ...ACTIONS.filter((a) => a.group === group).map((a): [string[], string] => [keysOf(a.id).filter((k) => app || !isAppOnly(k)), a.label]),
      ...FIXED.filter((f) => f.group === group).map((f): [string[], string] => [f.keys, f.label]),
    ];
    return [group, rows.filter(([keys]) => keys.length > 0)];
  });
}

export function Shortcuts({ onClose }: { onClose: () => void }) {
  useKeybindings();
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} wide>
      <div className="shortcuts">
        {groups().map(([title, rows]) => (
          <section key={title}>
            <h3>{title}</h3>
            <dl>
              {rows.map(([keys, what]) => (
                <div key={what}>
                  <dt>{keys.map((k) => <kbd key={k}>{showCombo(k)}</kbd>)}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="hint shortcuts-more">
        Change them in{" "}
        <a
          href="#/settings"
          onClick={(e) => {
            e.preventDefault();
            onClose();
            go({ page: "settings" });
            setTimeout(() => document.getElementById("keybinds")?.scrollIntoView({ block: "start" }), 100);
          }}
        >
          Settings → Keybinds
        </a>
        .
      </p>
    </Modal>
  );
}
