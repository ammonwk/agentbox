import { useSyncExternalStore, type Ref } from "react";
import { describeAt, describeRule, isRecurring, nextRun, parseWhen, until } from "../../../../src/core/schedule";
import { clockNow, subscribeToClock } from "../../api";
import "./when.css";

const CHIPS = ["in 1 hour", "tonight", "tomorrow at 9am", "every weekday at 9am"];

/**
 * When a scheduled session starts, in plain words, read back as you type — the
 * same parser the server saves with (src/core/schedule.ts), so what this says
 * is what happens.
 */
export function WhenField({ value, onChange, inputRef }: { value: string; onChange: (v: string) => void; inputRef?: Ref<HTMLInputElement> }) {
  const now = useSyncExternalStore(subscribeToClock, clockNow);
  const parsed = value.trim() ? parseWhen(value, now) : null;
  let read: string;
  if (!parsed) read = "Once at a time, or repeating if it says “every”.";
  else if ("error" in parsed) read = parsed.error;
  else if (parsed.rule.kind === "merge")
    read = `${describeRule(parsed.rule, now)}${parsed.rule.repo ? "" : " (of the repo it runs in)"}. Checked every minute; it waits in your sessions until then.`;
  else if (parsed.rule.kind === "once") read = `${describeRule(parsed.rule, now)}, ${until(parsed.rule.at, now)}. It waits in your sessions until then.`;
  else {
    const first = nextRun(parsed.rule, now);
    read = `${describeRule(parsed.rule, now)}${first ? `, first ${lower(describeAt(first, now))}` : ""}. A new session each time; manage it in Settings.`;
  }
  return (
    <div className="field ns-when">
      <label className="field-head" htmlFor="ns-when">
        <span className="field-label">When</span>
      </label>
      <input
        id="ns-when"
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="in 4 hours · tomorrow at 9am · every weekday at 8:30"
        spellCheck={false}
        autoComplete="off"
      />
      <div className="ns-when-chips">
        {CHIPS.map((c) => (
          <button key={c} type="button" className="ns-chip" aria-pressed={value === c} onClick={() => onChange(c)}>
            {c}
          </button>
        ))}
      </div>
      <p className="ns-when-read" data-state={!parsed ? "empty" : "error" in parsed ? "error" : isRecurring(parsed.rule) ? "repeat" : "once"} aria-live="polite">
        {read}
      </p>
    </div>
  );
}

/** "Today at…" mid-sentence is "today at…"; a date keeps its capitals. */
const lower = (s: string) => (/^(Today|Tomorrow)/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
