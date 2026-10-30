/** Settings → Extensions: the extensions on agentbox (docs/extensions.md), and
 *  beside the list the open one: its program's page, framed from `/x/<name>/`,
 *  or what its client adds to the app. Each can be turned off here. */

import { useEffect, useState } from "react";
import { api } from "../api";
import type { ExtensionInfo } from "../../../src/core/types";
import { Button, Empty, Icon, RelativeTime } from "../components";
import { type Loaded, SAFE, usePlugins } from "../plugin/registry";
import { go, hrefOf } from "../route";
import { useIsNarrow } from "./session/useIsNarrow";
import "./extensions.css";

const REMEMBER = "agentbox.extension";
const LIST_MS = 4_000;

function useExtensions(): { list: ExtensionInfo[] | null; error: string | null } {
  const [list, setList] = useState<ExtensionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      api.extensions().then(
        (l) => live && (setList(l), setError(null)),
        (e: Error) => live && setError(e.message),
      );
    void load();
    const t = setInterval(load, LIST_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return { list, error };
}

const TONE: Record<ExtensionInfo["state"], string> = { running: "ok", starting: "busy", backoff: "bad", stopped: "idle", none: "ok" };

export function Extensions({ name }: { name: string | null }) {
  const { list, error } = useExtensions();
  const narrow = useIsNarrow();
  const selected = list?.find((x) => x.name === name) ?? null;

  // A computer opens straight onto the one last looked at; a phone shows the list first.
  useEffect(() => {
    if (name || narrow || !list?.length) return;
    const last = localStorage.getItem(REMEMBER);
    go({ page: "extensions", name: (list.find((x) => x.name === last) ?? list[0]!).name }, true);
  }, [name, narrow, list]);
  useEffect(() => {
    if (selected) localStorage.setItem(REMEMBER, selected.name);
  }, [selected?.name]);

  const showList = !narrow || !name;
  const showPane = !narrow || !!name;
  return (
    <div className="ext" data-detail={name ? "on" : "off"}>
      {showList ? (
        <aside className="ext-list" aria-label="Extensions" data-nav-region="list">
          {error && !list ? <p className="ext-note bad">Could not load the extensions: {error}</p> : null}
          <ul>
            {(list ?? []).map((x) => (
              <li key={x.name}>
                <a className={`ext-row${x.name === name ? " on" : ""}`} href={hrefOf({ page: "extensions", name: x.name })} title={x.description || undefined}>
                  <span className={`ext-dot ${x.error ? "bad" : !x.enabled ? "idle" : TONE[x.state]}`} aria-label={x.error ? "broken" : !x.enabled ? "off" : x.state} />
                  <span className="ext-title">{x.title}</span>
                </a>
              </li>
            ))}
          </ul>
          {list && !list.length ? (
            <div className="ext-note">
              <p>No extensions yet.</p>
              <p>
                An extension is a program of yours that runs on agentbox: link its directory in with <code>agentbox ext add &lt;dir&gt;</code>. The
                agentbox checkout's <code>docs/extensions.md</code> says how to write one.
              </p>
            </div>
          ) : null}
        </aside>
      ) : null}
      {showPane ? (
        <section className="ext-pane" data-nav-region="detail">
          {!list ? (
            <Empty title="Loading…" />
          ) : selected ? (
            <Pane key={selected.name} x={selected} back={narrow} />
          ) : name ? (
            <Empty title="No such extension" action={<a className="btn" href={hrefOf({ page: "extensions", name: null })}>All extensions</a>}>
              <p>
                Nothing in <code>extensions/</code> is called <code>{name}</code>.
              </p>
            </Empty>
          ) : (
            <Empty title="Pick an extension" />
          )}
        </section>
      ) : null}
    </div>
  );
}

function Pane({ x, back }: { x: ExtensionInfo; back: boolean }) {
  const [log, setLog] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [busy, setBusy] = useState(false);
  const { loaded } = usePlugins();
  const mine = loaded.find((l) => l.name === x.name) ?? null;
  // A frame loaded while the program was down shows its refusal: load it again once it runs.
  const [frame, setFrame] = useState(0);
  const running = x.state === "running";
  const program = x.run && x.enabled;
  useEffect(() => {
    if (running) setFrame((n) => n + 1);
  }, [running, x.pid]);
  useEffect(() => {
    if (!program || (!showLog && running)) return;
    let live = true;
    const load = () => api.extensionLog(x.name).then((r) => live && setLog(r.text), () => {});
    void load();
    const t = setInterval(load, LIST_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [x.name, showLog, running, program]);
  const toggle = async () => {
    setBusy(true);
    try {
      await api.extensionOn(x.name, !x.enabled);
      // What its client added is in this page until it loads again without it (or with it).
      if (x.client) location.reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ext-open">
      <header className="ext-head">
        {back ? (
          <a className="ext-back" href={hrefOf({ page: "extensions", name: null })} aria-label="All extensions">
            <Icon.chevronLeft size={18} />
          </a>
        ) : null}
        <div className="ext-head-text">
          <h2>{x.title}</h2>
          <p className="ext-desc">
            {x.error ??
              (!x.enabled ? (
                "off"
              ) : !x.run ? (
                mine?.state === "failed" ? "its part in the app did not load" : "in the app"
              ) : running ? (
                <>
                  running since <RelativeTime ts={x.since!} />
                  {x.restarts ? ` · ${x.restarts} restart${x.restarts === 1 ? "" : "s"}` : ""}
                </>
              ) : x.lastExit ? (
                <>
                  {x.state}: exited {x.lastExit.code === null ? "" : `with ${x.lastExit.code} `}
                  <RelativeTime ts={x.lastExit.at} />
                </>
              ) : (
                x.state
              ))}
          </p>
        </div>
        {program ? (
          <>
            <Button size="sm" variant={showLog ? "primary" : "default"} onClick={() => setShowLog(!showLog)}>
              Output
            </Button>
            <Button
              size="sm"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.extensionRestart(x.name);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Restart
            </Button>
          </>
        ) : null}
        <Button size="sm" variant={x.enabled ? "default" : "primary"} loading={busy} onClick={() => void toggle()} title={x.enabled ? "Stop its program and take its part out of the app, until you turn it on" : undefined}>
          {x.enabled ? "Turn off" : "Turn on"}
        </Button>
      </header>
      {program && (showLog || !running) ? (
        <div className="ext-about">
          <p className="ext-desc">
            {x.dir} · <code>agentbox ext log {x.name}</code>
          </p>
          <pre className="ext-log">{log || "(no output yet)"}</pre>
        </div>
      ) : null}
      {running ? <iframe key={frame} className="ext-frame" title={x.title} src={`/x/${x.name}/`} /> : !program ? <About x={x} mine={mine} /> : null}
    </div>
  );
}

/** An extension with no program to frame: what it is, and what it adds to the app. */
function About({ x, mine }: { x: ExtensionInfo; mine: Loaded | null }) {
  const adds = mine
    ? [
        ...mine.pages.map((p) => (
          <>
            the page <a href={hrefOf({ page: "ext", id: p.id, rest: "" })}>{p.label}</a> in the rail
          </>
        )),
        ...mine.commands.map((c) => (
          <>
            the key <kbd>{c.key}</kbd>: {c.label}
          </>
        )),
        ...(mine.status.length ? [<>{mine.status.length === 1 ? "an item" : `${mine.status.length} items`} in the system bar</>] : []),
        ...mine.settings.map((d) => <>the section {d.title} in Settings</>),
        ...(mine.sessionActions.length ? [<>buttons on an open session</>] : []),
      ]
    : [];
  return (
    <div className="ext-about">
      {x.description ? <p>{x.description}</p> : null}
      <p className="ext-desc">
        {x.builtIn ? "Comes with agentbox" : x.dir}
        {x.client ? " · its part in the app is its client, loaded into this page" : ""}
      </p>
      {!x.enabled ? (
        <p>It is off: turn it on to put it back in the app.</p>
      ) : SAFE ? (
        <p>This page was opened with <code>?safe=1</code>, so no extension's part in the app is loaded.</p>
      ) : mine?.state === "failed" ? (
        <p className="bad">Its part in the app did not load: {mine.error}</p>
      ) : adds.length ? (
        <>
          <p>It adds:</p>
          <ul>
            {adds.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
