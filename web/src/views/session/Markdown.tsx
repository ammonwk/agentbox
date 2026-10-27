import { memo, useContext, useMemo, useState, type ComponentPropsWithoutRef, type ReactElement } from "react";
import renderMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Parent, PhrasingContent, Root, RootContent } from "mdast";
import { prRefs, prUrl } from "../../lib/prlinks";
import { sessionCandidates, sessionRefs, type SessionIndex } from "../../lib/sessionrefs";
import { resolveSessions } from "../../lib/sessionresolve";
import { PrBase } from "./prbase";
import { SessionLinks, type SessionLinksValue } from "./sessionlinks";
import { hrefOf, parseHash } from "../../route";
import { isLinkableName, useBoardSessions, useLocalAgents } from "./boardsessions";
import { useFamily } from "./family";
import { StatusDot, WaitGlyph } from "../../bits";
import { shownStatus, statusWaitingOn, titleOf } from "../../lib/board";
import { Icon } from "../../components";
import { Lightbox } from "../../attachments";
import { shownImageUrl } from "../../api";
import { ImagePath, imagePathRefs, isImagePath } from "./imagepaths";
import { localFileLink } from "../../../../src/core/filelinks";
import { FileLink } from "./FileLink";
import { FileBase, inBase } from "./viewerstore";
import { WaitRef } from "./WaitRef";
import { turnStatus, type TurnStatus } from "../../../../src/core/turnstatus";

/** Agent prose. External links open in a new tab: this page is a live
 *  terminal, and navigating away from it drops the attach. A link to another
 *  session stays here — it is the same page. */
/** One line of it, inside something you click (a row's summary): no blocks,
 *  and a click on a link inside is the link's, not the row's. */
const BLOCKS = ["h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "hr", "table", "thead", "tbody", "tr", "th", "td"];
const Inline = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

export const Markdown = memo(function Markdown({ text, inline }: { text: string; inline?: boolean }) {
  const base = useContext(PrBase);
  const links = useContext(SessionLinks);
  const { byName } = useFamily();
  const local = useLocalAgents();
  // Names, not ids: the teammates around this session, and the agents it
  // started inside itself. A session's own id is linked by the pass before.
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const [n, id] of local.names) if (isLinkableName(n)) m.set(n, `#ev:${id}`);
    for (const [n, s] of byName) if (isLinkableName(n) && s.id !== links.self) m.set(n, hrefOf({ page: "session", id: s.id, tab: "timeline" }));
    return m;
  }, [local.names, byName, links.self]);
  const status = inline ? null : turnStatus(text);
  const body = status ? status.body : text;
  const md = rendered(body, `${envOf(base, links.self, names)} ${refsIn(body, links.index)} ${inline ? "i" : "b"}`, () =>
    renderMarkdown({
      children: body,
      remarkPlugins: [remarkGfm, remarkFileRefs(), remarkWaitRefs(), remarkImagePaths(), remarkLocalPaths(), ...(base ? [remarkPrLinks(base)] : []), remarkSessionLinks(links), remarkNameLinks(names)],
      disallowedElements: inline ? BLOCKS : undefined,
      unwrapDisallowed: inline,
      urlTransform: keepOurUrls,
      components: inline ? INLINE : BLOCK,
    }),
  );
  if (inline) {
    return (
      <span className="sx-md sx-md-inline" onClick={(e) => (e.target as HTMLElement).closest("a") && e.stopPropagation()}>
        {md}
      </span>
    );
  }
  return (
    <div className="sx-md">
      {md}
      {status && status.kind !== "done" ? <StatusLine status={status} /> : null}
    </div>
  );
});

/**
 * Parsed prose, kept across renders and across sessions. Parsing is most of
 * what drawing a timeline costs, and the board re-renders it on every hot
 * frame: a text drawn once under the same links is the same elements, which
 * React then skips. By text, then by what the link passes depend on.
 */
const RENDERED_MAX = 3000;
const renderedCache = new Map<string, Map<string, ReactElement>>();
function rendered(text: string, env: string, make: () => ReactElement): ReactElement {
  let byEnv = renderedCache.get(text);
  if (byEnv) {
    renderedCache.delete(text);
    renderedCache.set(text, byEnv);
  } else {
    renderedCache.set(text, (byEnv = new Map()));
    if (renderedCache.size > RENDERED_MAX) renderedCache.delete(renderedCache.keys().next().value!);
  }
  let out = byEnv.get(env);
  if (!out) {
    if (byEnv.size > 8) byEnv.clear();
    byEnv.set(env, (out = make()));
  }
  return out;
}

/** The sessions a text names, as the board's index stands. The index grows
 *  whenever a session starts or one named in prose is found, and a text that
 *  names none of the new ones need not be parsed again for it. */
const refsCache = new WeakMap<SessionIndex, Map<string, string>>();
function refsIn(text: string, index: SessionIndex): string {
  let byText = refsCache.get(index);
  if (!byText || byText.size > RENDERED_MAX) refsCache.set(index, (byText = new Map()));
  let refs = byText.get(text);
  if (refs === undefined) byText.set(text, (refs = sessionRefs(text, index).map((r) => `${r.start}:${r.id}`).join()));
  return refs;
}

/** The rest of what the link passes depend on, by content, not by which
 *  objects hold it: the names are rebuilt with the board. */
function envOf(base: string | null, self: string | null, names: ReadonlyMap<string, string>): string {
  return `${base ?? ""} ${self ?? ""} ${namesId(names)}`;
}

const namesIds = new WeakMap<ReadonlyMap<string, string>, number>();
const idOfNames = new Map<string, number>();
let lastNamesId = 0;
function namesId(names: ReadonlyMap<string, string>): number {
  let id = namesIds.get(names);
  if (id !== undefined) return id;
  const content = [...names].join("\n");
  id = idOfNames.get(content);
  if (id === undefined) {
    // Never reused, so clearing cannot hand an old number to other names.
    if (idOfNames.size > 500) idOfNames.clear();
    idOfNames.set(content, (id = ++lastNamesId));
  }
  namesIds.set(names, id);
  return id;
}

/** The turn's closing `STATUS:` line, as a quiet footer rather than prose,
 *  under the icon the list gives what it waits on (`waitingOn`). A `done`
 *  one is only dropped: the list's check already says it. */
function StatusLine({ status: { kind, text } }: { status: TurnStatus }) {
  return (
    <div className="sx-status" data-kind={kind} title={`STATUS: ${text}`}>
      {kind === "done" ? (
        <Icon.check size={12} weight="bold" />
      ) : kind === "other" ? (
        <Icon.chevronRight size={12} weight="bold" />
      ) : (
        <WaitGlyph on={kind === "needs" ? "you" : statusWaitingOn(text)} size={12} weight="bold" />
      )}
      <Markdown inline text={text.charAt(0).toUpperCase() + text.slice(1)} />
    </div>
  );
}

/** A link in agent prose. Module-level, like ShownImage below: one made in
 *  render is a new component type each time, so everything under it — a
 *  live wait's open popover — would be remade on every hot frame. */
function MdLink({ node: _node, children, href, ...rest }: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  const board = useBoardSessions();
  const local = useLocalAgents();
  if (href?.startsWith("wait:")) return <WaitRef id={Number(href.slice(5))}>{children}</WaitRef>;
  if (href?.startsWith("imgpath:")) return <ImagePath path={href.slice("imgpath:".length)}>{children}</ImagePath>;
  if (href?.startsWith("fileref:")) {
    const file = href.slice("fileref:".length);
    if (isImagePath(file)) {
      return (
        <ImagePath path={file}>
          <code className="sx-fileref">{children}</code>
        </ImagePath>
      );
    }
    return <FileLink path={file}><code className="sx-fileref">{children}</code></FileLink>;
  }
  if (href?.startsWith("#ev:")) {
    const id = href.slice(4);
    return (
      <a
        {...rest}
        href={href}
        className="sx-agentlink"
        title="An agent this session started; go to where it was started"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          local.jump(id);
        }}
      >
        {children}
      </a>
    );
  }
  if (href?.startsWith("#/")) {
    // Another session: say what it is and what it is doing, not just its id.
    const r = parseHash(href);
    const s = r.page === "session" ? board.get(r.id) : undefined;
    if (s) {
      return (
        <a {...rest} href={href} className="sx-sesslink" title={`${titleOf(s)} (${s.id})`}>
          <StatusDot status={shownStatus(s)} />
          {children}
        </a>
      );
    }
    return <a {...rest} href={href}>{children}</a>;
  }
  const file = href && !/^\/(?:api|assets|ws)(?:\/|$)/.test(href) && localFileLink(href);
  if (file) {
    if (isImagePath(file.path)) return <ImagePath path={file.path}>{children}</ImagePath>;
    return <FileLink path={href!}>{children}</FileLink>;
  }
  return <a {...rest} href={href} target="_blank" rel="noreferrer">{children}</a>;
}

const BLOCK = { img: ShownImage, a: MdLink };
const INLINE = { p: Inline, img: ShownImageChip, a: MdLink };

/** react-markdown blanks any URL whose scheme it does not know, which would
 *  blank the links the passes here make (`fileref:`, `imgpath:`, `wait:`) and an image
 *  named by `file://`, one way an agent shows you one. */
function keepOurUrls(url: string, key: string): string {
  if (/^(?:fileref|imgpath|wait):/.test(url)) return url;
  return url.startsWith("file://") && (key === "src" || localFileLink(url)) ? url : defaultUrlTransform(url);
}

type ImgProps = { src?: unknown; alt?: string };

/** An image in agent prose. A web address loads as it is; anything else is a
 *  file on this machine, which the server reads (`/api/sessions/:id/image`).
 *  Big ones are shown shrunk, and a click opens them full size. A file gone
 *  since — or a one-line summary, which has no room — is a chip naming it.
 *  Module-level, and the session read from context rather than closed over:
 *  a component made in render is a new type each time, and the timeline
 *  renders on every hot frame, so the image would be remade and blink. */
function ShownImage({ src: raw, alt = "" }: ImgProps) {
  const { self: session } = useContext(SessionLinks);
  const base = useContext(FileBase);
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const src = typeof raw === "string" ? raw : "";
  const web = /^https?:\/\//i.test(src);
  const path = web ? src : safeDecode(src);
  const url = web ? src : session && path ? shownImageUrl(session, inBase(base, path)) : null;
  const label = labelOf(alt, path);
  if (!url || broken) return <ImageChip label={label} title={broken ? `Could not load ${path}` : path} />;
  return (
    <span className="sx-img">
      <button type="button" className="sx-img-btn" title={`${path} · click for full size`} onClick={() => setOpen(true)}>
        <img src={url} alt={alt} loading="lazy" onError={() => setBroken(true)} />
      </button>
      {alt ? <span className="sx-img-cap">{alt}</span> : null}
      {open ? <Lightbox src={url} label={label} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

function ShownImageChip({ src, alt = "" }: ImgProps) {
  const path = typeof src === "string" ? safeDecode(src) : "";
  return <ImageChip label={labelOf(alt, path)} title={path} />;
}

function ImageChip({ label, title }: { label: string; title: string }) {
  return (
    <code className="sx-fileref sx-img-chip" title={title}>
      <Icon.image size={11} /> {label}
    </code>
  );
}

const labelOf = (alt: string, path: string) => alt || path.split("/").pop() || "image";

/** Markdown percent-encodes a path written in `<…>`; the file has the plain name. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `#6307` in prose becomes a link to the PR, and in inline code too, where
 *  agents put them as often as not (only with a `#` or `PR` there: a bare
 *  number in code is a port or a pid). Code blocks and existing links are
 *  left alone. */
function remarkPrLinks(base: string) {
  return () => (tree: Root) => {
    rewrite(tree, true, (text, code) =>
      splitRefs(text, code, (t) => prRefs(t, code).map((r) => ({ start: r.start, end: r.end, url: prUrl(base, r.number, r.repo) }))),
    );
  };
}

/** `agentbox wait 22849` (or `wait job 22849`) in prose or inline code
 *  becomes the wait itself, live (WaitRef.tsx). */
function remarkWaitRefs() {
  return () => (tree: Root) => {
    rewrite(tree, true, (text, code) =>
      splitRefs(text, code, (t) =>
        [...t.matchAll(/\bagentbox wait (?:job )?(\d{1,9})\b/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, url: `wait:${m[1]}` })),
      ),
    );
  };
}

/** A path to an image in prose — `/tmp/shot.png`, bare or in backticks —
 *  opens it. Runs before the session links: a worktree's path can hold one. */
function remarkImagePaths() {
  return () => (tree: Root) => {
    rewrite(tree, true, (text, code) =>
      splitRefs(text, code, (t) => imagePathRefs(t).map((r) => ({ start: r.start, end: r.end, url: `imgpath:${r.path}` }))),
    );
  };
}

/** File paths in prose and inline code get the same desktop action as an
 * explicit Markdown link. Bare filenames need code and a known extension so
 * ordinary domain names and version numbers stay prose. A folder is a rooted
 * path ending in a slash (`~/Pictures/shots/`); `pairs/` alone stays prose. */
function remarkLocalPaths() {
  const pattern = /(?<![\w/.~:@%+-])(?:(?:(?:~\/|\.{1,2}\/|\/)?(?:[\w.@%+~-]+\/)+)?[\w@%+~-]+(?:\.[\w@%+~-]+)*\.[a-z][a-z\d]*(?::\d+(?:-\d+)?){0,2}(?![\w/]|\.\w)|(?:~\/|\.{1,2}\/|\/)(?:[\w.@%+~-]+\/)+(?![\w/]))/gi;
  const known = /\.(?:[cm]?[jt]sx?|html?|css|scss|json|md|txt|py|rs|go|sh|yaml|yml|toml|sql|zip|pdf)(?::\d+(?:-\d+)?){0,2}$/i;
  return () => (tree: Root) => {
    rewrite(tree, true, (text, code) => splitRefs(text, code, (t) =>
      [...t.matchAll(pattern)]
        .filter((m) => m[0].includes("/") || (code && known.test(m[0])))
        .map((m) => ({ start: m.index!, end: m.index! + m[0].length, url: `fileref:${m[0]}` })),
    ));
  };
}

/** A session named in prose — by id, tmux name, provider id or worktree path
 *  — becomes a link to it, the same as a PR number is to GitHub. Inline code
 *  is searched too: agents backtick these names far more often than not. One
 *  shaped like an id but not on the board is asked about (sessionresolve):
 *  if it names an older session, the index grows and this draws again. */
function remarkSessionLinks({ index, self }: SessionLinksValue) {
  return () => (tree: Root) => {
    rewrite(tree, true, (text, code) =>
      splitRefs(text, code, (t) => {
        void resolveSessions(sessionCandidates(t, index, code));
        return sessionRefs(t, index)
          .filter((r) => r.id !== self)
          .map((r) => ({ start: r.start, end: r.end, url: hrefOf({ page: "session", id: r.id, tab: "timeline" }) }));
      }),
    );
  };
}

/** A teammate or in-session agent named in prose — `relexec`, bare or in
 *  backticks — becomes a link: to its session, or to where it was started. */
function remarkNameLinks(names: ReadonlyMap<string, string>) {
  if (names.size === 0) return () => () => {};
  const alt = [...names.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?<![\\w/.@#-])(?:${alt.join("|")})(?![\\w-]|\\.\\w)`, "g");
  return () => (tree: Root) => {
    rewrite(tree, true, (text, code) =>
      splitRefs(text, code, (t) => [...t.matchAll(re)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, url: names.get(m[0])! }))),
    );
  };
}

/** `<ref_file file="…" />` and `<ref_snippet file="…" lines="…" />` — the
 *  agent's file citations — become a quiet chip naming the file; the full
 *  path stays in the tooltip. Runs first, so the raw tag never reaches the
 *  session-link pass (a tag's path can name a worktree). */
const FILE_REF = /<ref_(?:file|snippet)\b[^>]*?\/>/g;

function remarkFileRefs() {
  return () => (tree: Root) => {
    const walk = (node: Parent) => {
      node.children = node.children.flatMap((child: RootContent): RootContent[] => {
        if (child.type === "text") return splitFileRefs(child.value, false);
        if (child.type === "inlineCode") return splitFileRefs(child.value, true);
        if ("children" in child) walk(child);
        return [child];
      }) as typeof node.children;
    };
    walk(tree);
  };
}

function splitFileRefs(text: string, code: boolean): PhrasingContent[] {
  const plain = (value: string): PhrasingContent => (code ? { type: "inlineCode", value } : { type: "text", value });
  if (!text.includes("<ref_")) return [plain(text)];
  const out: PhrasingContent[] = [];
  let at = 0;
  for (const m of text.matchAll(FILE_REF)) {
    const start = m.index!;
    if (start > at) out.push(plain(text.slice(at, start)));
    const file = /(?:file|path)="([^"]*)"/.exec(m[0])?.[1] ?? "";
    const lines = /lines="([^"]*)"/.exec(m[0])?.[1];
    const name = file.split("/").pop() || file;
    out.push({
      type: "link",
      url: `fileref:${file}`,
      children: [plain(lines ? `${name}:${lines}` : name)],
    });
    at = start + m[0].length;
  }
  if (at < text.length) out.push(plain(text.slice(at)));
  return out;
}

/** Apply `split` to every text node (and to inline code, when `intoCode`),
 *  leaving fenced code and existing links as they are. */
function rewrite(tree: Root, intoCode: boolean, split: (text: string, code: boolean) => PhrasingContent[]): void {
  const walk = (node: Parent) => {
    node.children = node.children.flatMap((child: RootContent): RootContent[] => {
      if (child.type === "text") return split(child.value, false);
      if (child.type === "inlineCode" && intoCode) return split(child.value, true);
      if (child.type === "link" || child.type === "linkReference" || child.type === "code" || child.type === "inlineCode") return [child];
      if ("children" in child) walk(child);
      return [child];
    }) as typeof node.children;
  };
  walk(tree);
}

function splitRefs(
  text: string,
  code: boolean,
  find: (t: string) => { start: number; end: number; url: string }[],
): PhrasingContent[] {
  // A reference taken out of inline code keeps its code look.
  const plain = (value: string): PhrasingContent => (code ? { type: "inlineCode", value } : { type: "text", value });
  const refs = find(text);
  if (refs.length === 0) return [plain(text)];
  const out: PhrasingContent[] = [];
  let at = 0;
  for (const r of refs) {
    if (r.start > at) out.push(plain(text.slice(at, r.start)));
    out.push({ type: "link", url: r.url, children: [plain(text.slice(r.start, r.end))] });
    at = r.end;
  }
  if (at < text.length) out.push(plain(text.slice(at)));
  return out;
}
