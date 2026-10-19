import { Modal } from "../components";
import { isInstalledApp } from "../lib/phone";

/** Every key the board answers to, in one place: `?` opens it. Keep it in
 *  step with the handlers it names. */
function groups(): [string, [string, string][]][] {
  const app = isInstalledApp();
  return [
    ["Anywhere", [
      ["n", "New session"],
      ...(app ? [["Ctrl+T", "New session, from the terminal too"] as [string, string]] : []),
      ["/", "Search the list"],
      ["?", "These shortcuts"],
      ["↑ ↓ ← →", "Move through the sidebar, the list and the open pane"],
      ["F6", "Next pane, from a field or the terminal too"],
    ]],
    ["Sessions", [
      ["j  k", "Next and previous session"],
      ["Alt+J  Alt+K", "The same, from the composer or the terminal"],
      ["h  l", "Fold and unfold a session's children; h goes up to its parent"],
      ["1  2  3", "Timeline, Terminal, Load"],
      ["Alt+1  Alt+2  Alt+3", "The same, from the composer or the terminal"],
      ["Shift+Tab", "Previous tab, in the terminal"],
      [app ? "Ctrl+W / Alt+W" : "Alt+W", "Close the open session"],
      [app ? "Ctrl+Shift+T / Alt+Shift+T" : "Alt+Shift+T", "Reopen the last closed session"],
      ...(app ? [["Ctrl+Tab  Ctrl+Shift+Tab", "Step through the sessions"] as [string, string]] : []),
      ["Esc", "Stop the running turn (outside a field)"],
    ]],
    ["Composer", [
      ["Enter", "Send"],
      ["Shift+Enter", "New line"],
      ["↑  ↓", "In an empty box: what you said before"],
      ["/", "Skills"],
      ["Esc", "Stop a running turn; at rest, leave the box"],
    ]],
    ["New session", [
      ["Alt+1 … Alt+6", "Pick the agent"],
      ["Ctrl+Enter", "Start"],
    ]],
    ["Review", [
      ["→", "Answer the card"],
      ["↓", "Approve it"],
      ["←", "Later"],
      ["↑", "Read it whole"],
      ["u", "Undo"],
    ]],
  ];
}

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} wide>
      <div className="shortcuts">
        {groups().map(([title, keys]) => (
          <section key={title}>
            <h3>{title}</h3>
            <dl>
              {keys.map(([k, what]) => (
                <div key={k}>
                  <dt>{k.split(/\s{2,}| \/ /).map((one, i) => <kbd key={i}>{one}</kbd>)}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
