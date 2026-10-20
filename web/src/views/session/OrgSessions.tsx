/** The other members' live org sessions (docs/org.md): read-only rows, each
 *  one's id a click away for `agentbox send`. */

import type { OrgStatus } from "../../../../src/core/types";
import { copyText, ProviderBadge } from "../../bits";

export function OrgSessions({ org, query }: { org: OrgStatus; query: string }) {
  const q = query.trim().toLowerCase();
  const rows = org.sessions.filter((s) => !q || `${s.title} ${s.person} ${s.repo ?? ""} ${s.branch ?? ""}`.toLowerCase().includes(q));
  if (!rows.length) return null;
  return (
    <div className="rail-sec" data-kind="org">
      <div className="rail-label" title={`${org.name}'s org sessions on other members' machines`}>
        {org.name} <span>{rows.length}</span>
      </div>
      {rows.map((s) => (
        <button
          key={s.id}
          type="button"
          className="rail-row rail-org"
          data-away={s.away || undefined}
          title={[
            s.title,
            `${s.person} on ${s.machine}${s.away ? ", not heard from lately" : ""}`,
            [s.repo, s.branch].filter(Boolean).join(" @ "),
            s.account ? `on ${s.account}` : "",
            s.prs.length ? `holds ${s.prs.join(", ")}` : "",
            `${s.status} · ${s.id}: click to copy its id, for agentbox send`,
          ]
            .filter(Boolean)
            .join("\n")}
          onClick={() => void copyText(s.id)}
        >
          <ProviderBadge provider={s.provider} short />
          <span className="rail-text">
            <span className="rail-title">{s.title}</span>
          </span>
          <span className="rail-when">{s.away ? "away" : s.person}</span>
        </button>
      ))}
    </div>
  );
}
