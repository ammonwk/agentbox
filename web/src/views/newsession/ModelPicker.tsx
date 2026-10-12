import { ago } from "../../lib/format";
import { filterModels, modelName, type ModelChoice } from "../../lib/newsession";
import { Dropdown, type MenuItem } from "./Dropdown";

/** The row that passes a typed model through as is. */
const TYPED = "typed:";

/**
 * What this account can run, recently used first then newest release first.
 * The menu's search still takes any string — a model the catalog has not
 * heard of is the CLI's business, not ours.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  defaultId,
  agent,
}: {
  models: ModelChoice[];
  value: string;
  onChange: (model: string) => void;
  /** What an empty value runs: the Settings default, else the CLI's own. */
  defaultId: string | null;
  agent: string;
}) {
  const nameOf = (id: string) => models.find((m) => m.id === id)?.label ?? modelName(id);
  const defaultName = defaultId ? nameOf(defaultId) : null;

  function items(query: string): MenuItem[] {
    const { rows, hidden } = filterModels(models, query);
    const out: MenuItem[] = [];
    if (!query)
      out.push({
        key: "",
        children: (
          <>
            <span className="ns-item-main">Default</span>
            <span className="ns-item-sub">{defaultName ?? `${agent}'s own`}</span>
          </>
        ),
      });
    for (const m of rows) {
      out.push({
        key: m.id,
        group: m.lastUsedAt != null ? "Recently used" : "Newest first",
        children: (
          <>
            <span className="ns-item-main">{m.label}</span>
            <span className="ns-item-sub">{m.lastUsedAt != null ? ago(m.lastUsedAt) : m.releasedAt ? fmtRelease(m.releasedAt) : (m.note ?? "")}</span>
          </>
        ),
      });
    }
    if (query && !models.some((m) => m.id === query))
      out.push({
        key: `${TYPED}${query}`,
        children: (
          <span className="ns-item-main">
            Use <span className="mono">{query}</span>
          </span>
        ),
      });
    if (hidden > 0) out.push({ key: "hidden", disabled: true, children: <span className="faint">{hidden} more — keep typing to filter.</span> });
    return out;
  }

  return (
    <Dropdown
      label="Model"
      title={value || undefined}
      width={320}
      search="Search models, or type one…"
      selected={value}
      onPick={(k) => onChange(k.startsWith(TYPED) ? k.slice(TYPED.length) : k)}
      trigger={
        value ? (
          <span className="ns-pill-text">{short(nameOf(value))}</span>
        ) : defaultName ? (
          <>
            <span className="ns-pill-text">{short(defaultName)}</span>
            <span className="ns-pill-tag">default</span>
          </>
        ) : (
          <span className="ns-pill-text faint">Model</span>
        )
      }
      items={items}
    />
  );
}

/** The pill has no room for the vendor: "Claude Opus 5.5" reads "Opus 5.5". */
const short = (name: string) => name.replace(/^Claude (?=\S)/, "");

/** "Sep 2026". */
function fmtRelease(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { month: "short", year: "numeric" }) : date;
}
