import type { AppState } from "../api";
import { ago } from "../api";
import { Icon, Empty } from "../components";

export function Prs({ state, onOpenSession }: { state: AppState; onOpenSession: (id: string) => void }) {
  const prs = state.prs;

  return (
    <div>
      {prs.length === 0 ? (
        <Empty title="No open pull requests">
          Open PRs across your registered GitHub repos will show up here.
        </Empty>
      ) : (
      <div className="card" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Pull request</th>
              <th>Repo</th>
              <th>Branch</th>
              <th>Author</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {prs.map((p) => (
              <tr key={`${p.repo}#${p.number}`}>
                <td>
                  <a href={p.url} target="_blank" rel="noreferrer">
                    {p.title}
                  </a>
                  {p.isDraft && (
                    <span className="pill waiting" style={{ marginLeft: 8 }}>Draft</span>
                  )}
                </td>
                <td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{p.repo}</td>
                <td>
                  <code style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--muted)" }}>
                    {p.headRef}
                  </code>
                </td>
                <td style={{ color: "var(--muted)" }}>{p.author}</td>
                <td style={{ color: "var(--muted)" }}>{ago(p.updatedAt)}</td>
                <td>
                  {p.sessionId ? (
                    <button className="btn btn-ghost" onClick={() => onOpenSession(p.sessionId!)}>
                      <Icon.git size={13} /> Open agent
                    </button>
                  ) : (
                    <button className="btn btn-ghost" onClick={() => window.open(p.url, "_blank")}>
                      <Icon.prs size={13} /> View
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
