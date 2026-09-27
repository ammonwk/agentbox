import { useState } from "react";
import type { AskAnswer, AskQuestion, TimelineEvent } from "../../../../src/core/types";
import { api, fmtClock } from "../../api";
import { Button, Icon, Spinner } from "../../components";
import { useAction } from "./useAction";

type Ask = NonNullable<Extract<TimelineEvent, { kind: "tool" }>["ask"]>;

interface Choice {
  labels: string[];
  other: string;
  /** Single-select: the text field is the pick, not an option. */
  otherOn: boolean;
}

const EMPTY: Choice = { labels: [], other: "", otherOn: false };

function answerOf(q: AskQuestion, p: Choice): AskAnswer | null {
  const other = p.other.replace(/\s+/g, " ").trim();
  const useOther = q.multiSelect ? !!other : p.otherOn && !!other;
  const labels = q.multiSelect || !p.otherOn ? p.labels : [];
  if (!labels.length && !useOther) return null;
  return useOther ? { labels, other } : { labels };
}

/**
 * The AskUserQuestion dialog the session is showing, answerable here: pick
 * the options (or type your own), then Answer. The server works the
 * terminal's dialog to match (claude-ask.ts), so the terminal and this stay
 * one dialog.
 */
export function QuestionCard({ sessionId, ask }: { sessionId: string; ask: Pick<Ask, "id" | "questions"> }) {
  const [picks, setPicks] = useState<Choice[]>(() => ask.questions.map(() => EMPTY));
  const { run, busy, error } = useAction();
  const [sent, setSent] = useState(false);
  const answers = ask.questions.map((q, i) => answerOf(q, picks[i]!));
  const ready = answers.every((a) => a !== null);

  const set = (i: number, f: (p: Choice) => Choice) => setPicks((ps) => ps.map((p, j) => (j === i ? f(p) : p)));

  async function submit() {
    if (!ready || busy) return;
    const ok = await run(() => api.answer(sessionId, ask.id, answers as AskAnswer[]));
    if (ok) setSent(true);
  }

  return (
    <section className="ask" aria-label="The agent is asking">
      {ask.questions.map((q, i) => {
        const p = picks[i]!;
        const kind = q.multiSelect ? "checkbox" : "radio";
        return (
          <fieldset className="ask-q" key={i} disabled={busy || sent}>
            <legend className="ask-legend">
              {q.header ? <span className="ask-chip">{q.header}</span> : null}
              <span className="ask-text">{q.question}</span>
              {q.multiSelect ? <span className="faint"> · pick any</span> : null}
            </legend>
            <div className="ask-opts" role={q.multiSelect ? "group" : "radiogroup"}>
              {q.options.map((o) => {
                const on = p.labels.includes(o.label) && (q.multiSelect || !p.otherOn);
                return (
                  <button
                    key={o.label}
                    type="button"
                    role={kind}
                    aria-checked={on}
                    className="ask-opt"
                    onClick={() =>
                      set(i, (x) =>
                        q.multiSelect
                          ? { ...x, labels: on ? x.labels.filter((l) => l !== o.label) : [...x.labels, o.label] }
                          : { ...x, labels: [o.label], otherOn: false },
                      )
                    }
                  >
                    <span className={`ask-mark ${kind}`} aria-hidden="true">
                      {on ? <Icon.check size={12} /> : null}
                    </span>
                    <span className="ask-body">
                      <span className="ask-label">{o.label}</span>
                      {o.description ? <span className="ask-desc">{o.description}</span> : null}
                    </span>
                  </button>
                );
              })}
              <label className="ask-opt ask-other" aria-checked={q.multiSelect ? !!p.other.trim() : p.otherOn}>
                <span className={`ask-mark ${kind}`} aria-hidden="true">
                  {(q.multiSelect ? !!p.other.trim() : p.otherOn && !!p.other.trim()) ? <Icon.check size={12} /> : null}
                </span>
                <input
                  type="text"
                  className="ask-input"
                  value={p.other}
                  placeholder="Something else…"
                  aria-label={`Your own answer to: ${q.question}`}
                  enterKeyHint="done"
                  onFocus={() => !q.multiSelect && set(i, (x) => ({ ...x, otherOn: true }))}
                  onChange={(e) => {
                    const v = e.target.value;
                    set(i, (x) => ({ ...x, other: v, otherOn: true }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
              </label>
            </div>
          </fieldset>
        );
      })}
      <div className="ask-foot">
        {error ? (
          <span className="ask-error" role="alert">
            <Icon.alert size={13} /> {error}
          </span>
        ) : sent ? (
          <span className="faint">
            <Spinner size={11} /> Answered — waiting for the agent to take it…
          </span>
        ) : (
          <span className="faint">{ask.questions.length > 1 ? "Answer each, then send." : ""}</span>
        )}
        <Button variant="primary" size="sm" icon={Icon.send} loading={busy} disabled={!ready || sent} onClick={() => void submit()}>
          Answer
        </Button>
      </div>
    </section>
  );
}

/** An AskUserQuestion call in the timeline: what was asked and what came back. */
export function AskRow({ ev, live }: { ev: Extract<TimelineEvent, { kind: "tool" }> & { ask: Ask }; live: boolean }) {
  const { ask } = ev;
  return (
    <div className={`ask ask-past ${ev.status}`} title={fmtClock(ev.at)}>
      {ask.questions.map((q, i) => {
        const a = ask.answers?.[q.question];
        return (
          <div className="ask-q" key={i}>
            <div className="ask-legend">
              {q.header ? <span className="ask-chip">{q.header}</span> : null}
              <span className="ask-text">{q.question}</span>
            </div>
            {a !== undefined ? (
              <div className="ask-answer">
                <Icon.check size={12} /> {a}
              </div>
            ) : null}
          </div>
        );
      })}
      {ev.status === "running" ? (
        <div className="ask-status">
          {live ? (
            <>
              <Icon.arrowDown size={12} /> Waiting for your answer, below
            </>
          ) : (
            <>
              <Spinner size={11} /> Waiting for an answer
            </>
          )}
        </div>
      ) : ev.status === "error" || !ask.answers ? (
        <div className="ask-status faint">Not answered{ev.output ? ` — ${ev.output.split("\n")[0]!.slice(0, 160)}` : ""}</div>
      ) : null}
    </div>
  );
}
