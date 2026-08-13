import type { AppState, ConductorItem } from "../api";
import { ago } from "../api";
import { Icon, Empty } from "../components";

const KIND_META: Record<ConductorItem["kind"], { icon: (p: { size?: number }) => React.ReactElement; label: string }> = {
  failed: { icon: Icon.alert, label: "Needs attention" },
  review: { icon: Icon.check, label: "Ready to review" },
  pr: { icon: Icon.prs, label: "Pull request" },
};

export function Conductor({
  state, onOpenSession,
}: { state: AppState; onOpenSession: (id: string) => void }) {
  const items = state.conductor;

  return (
    <div>
      {items.length === 0 && (
        <Empty title="All clear">
          Nothing is waiting on you right now. Failed sessions and open pull
          requests will show up here.
        </Empty>
      )}
      {items.map((item, i) => {
        const meta = KIND_META[item.kind];
        const IconCmp = meta.icon;
        return (
          <div className="conductor-item" key={`${item.kind}-${item.sessionId ?? item.title}-${i}`}>
            <div className={`icon ${item.kind}`}>
              <IconCmp size={17} />
            </div>
            <div className="body">
              <div className="title">{item.title}</div>
              <div className="detail">{item.detail}</div>
            </div>
            <div className="when">{ago(item.updatedAt)}</div>
            {item.sessionId && (
              <button className="btn btn-ghost" onClick={() => onOpenSession(item.sessionId!)}>
                <Icon.git size={13} /> Open
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
