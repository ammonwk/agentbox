import type { Where } from "../lib/moveagents";

/** Local or Hosted: where a shared agent with a copy on this machine runs. */
export function WhereToggle({ where, hostOk, onChange }: { where: Where; hostOk?: boolean; onChange: (w: Where) => void }) {
  return (
    <div className="seg agent-where" role="group" aria-label="Where this agent runs">
      <button type="button" aria-pressed={where === "local"} title="Runs on this machine with your provider accounts" onClick={() => where !== "local" && onChange("local")}>
        Local
      </button>
      <button
        type="button"
        aria-pressed={where === "hosted"}
        title={hostOk === false ? "The workspace's execution host is not connected" : "Runs on the workspace's execution host"}
        onClick={() => where !== "hosted" && onChange("hosted")}
      >
        Hosted{hostOk === false ? " · offline" : ""}
      </button>
    </div>
  );
}
