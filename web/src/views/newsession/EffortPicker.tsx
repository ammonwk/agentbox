import { Dropdown } from "./Dropdown";

/**
 * How hard the model thinks: the CLI's own levels (`--effort`, codex's
 * `model_reasoning_effort`, omp's `--thinking`), lowest first, plus "default"
 * — whatever the CLI or its settings say. Closed, it is a small meter;
 * ←/→ step the level without opening the menu.
 */
export function EffortPicker({ levels, value, onChange }: { levels: readonly string[]; value: string; onChange: (v: string) => void }) {
  // Row 0 is "default"; the levels follow.
  const rows = ["", ...levels];
  const index = Math.max(0, rows.indexOf(value));
  return (
    <Dropdown
      label="Effort"
      title="Reasoning effort · ←/→ to step"
      width={220}
      selected={value || "default"}
      onPick={(k) => onChange(k === "default" ? "" : k)}
      onClosedKey={(e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return false;
        e.preventDefault();
        onChange(rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowRight" ? 1 : -1)))]!);
        return true;
      }}
      trigger={
        <>
          <Meter level={value ? levels.indexOf(value) + 1 : 0} of={levels.length} />
          <span className={`ns-pill-text${value ? "" : " faint"}`}>{value || "Effort"}</span>
        </>
      }
      items={rows.map((r, i) => ({
        key: r || "default",
        children: (
          <>
            <Meter level={i} of={levels.length} />
            <span className={r ? "" : "faint"}>{r || "Default"}</span>
          </>
        ),
      }))}
    />
  );
}

/** Bars rising left to right, `level` of `of` lit; zero lit reads "default". */
function Meter({ level, of }: { level: number; of: number }) {
  const bars = Math.min(of, 5);
  // Squeeze longer ladders (omp's seven) onto five bars.
  const lit = level === 0 ? 0 : Math.max(1, Math.round((level / of) * bars));
  return (
    <span className="ns-meter" aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <i key={i} data-on={i < lit || undefined} style={{ height: `${4 + i * 2}px` }} />
      ))}
    </span>
  );
}
