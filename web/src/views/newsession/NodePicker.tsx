import type { HubNodeView } from "../../../../src/core/types";
import { Dropdown } from "./Dropdown";

/**
 * On a hub (docs/hub.md, Placement): which machine a session starts on. This
 * machine, a joined node, or Auto: the machine with the most room that may
 * take it. A node that is away or takes no starts is listed, greyed, saying
 * why. Only a start in a repo can go to a node, so the dialog shows this only
 * then.
 */
export function NodePicker({ nodes, value, onChange }: { nodes: HubNodeView[]; value: string; onChange: (v: string) => void }) {
  const approved = nodes.filter((n) => n.approvedAt !== null);
  const why = (n: HubNodeView): string | null =>
    !n.reachable ? "away" : !n.lend?.acceptStarts ? "takes no starts" : n.lend.maxSessions !== null && (n.placed ?? 0) >= n.lend.maxSessions ? "at its limit" : null;
  const label = value === "" ? "This machine" : value === "auto" ? "Auto" : value;
  return (
    <Dropdown
      label="Runs on"
      title="Which machine it runs on"
      width={260}
      selected={value || "here"}
      onPick={(k) => onChange(k === "here" ? "" : k)}
      trigger={<span className={`ns-pill-text${value ? "" : " faint"}`}>{label}</span>}
      items={[
        { key: "here", children: <span>This machine</span> },
        { key: "auto", children: <span>Auto: the most room</span> },
        ...approved.map((n) => {
          const no = why(n);
          return {
            key: n.name,
            group: "Nodes",
            disabled: !!no,
            children: (
              <>
                <span>{n.name}</span>
                {no ? <span className="faint"> · {no}</span> : null}
              </>
            ),
          };
        }),
      ]}
    />
  );
}
