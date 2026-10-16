import { createContext, useContext, useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Parent, PhrasingContent, Root, RootContent } from "mdast";
import { prRefs, prUrl } from "../../lib/prlinks";
import { sessionRefs } from "../../lib/sessionrefs";
import { PrBase } from "./prbase";
import { SessionLinks, type SessionLinksValue } from "./sessionlinks";
import { hrefOf, parseHash } from "../../route";
import { isLinkableName, useBoardSessions, useLocalAgents } from "./boardsessions";
import { useFamily } from "./family";
import { StatusDot } from "../../bits";
import { shownStatus, titleOf } from "../../lib/board";
import { Icon } from "../../components";
import { Lightbox } from "../../attachments";
import { shownImageUrl } from "../../api";
import { ImagePath, imagePathRefs, isImagePath } from "./imagepaths";
import { localFileLink } from "../../../../src/core/filelinks";
import { FileLink } from "./FileLink";

/** Agent prose. External links open in a new tab: this page is a live
 *  terminal, and navigating away from it drops the attach. A link to another
 *  session stays here — it is the same page. */
/** One line of it, inside something you click (a row's summary): no blocks,
 *  and a click on a link inside is the link's, not the row's. */
const BLOCKS = ["h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "hr", "table", "thead", "tbody", "tr", "th", "td"];
const Inline = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

/** False for text that a program on another machine wrote (a teammate's
 *  shared agent). Its paths, files and sessions are on its host, so they show
 *  as text: no `fileref:`, `imgpath:`, `file://` or session link, and no
 *  image read from this machine. Only web links stay links. */
export const LocalLinks = createContext(true);

export function Markdown({ text, inline }: { text: string; inline?: boolean }) {
  const local = useContext(LocalLinks);
  return local ? <LocalMarkdown text={text} inline={inline} /> : <HostMarkdown text={text} inline={inline} />;
}

/** Markdown from another machine (LocalLinks false). */
function HostMarkdown({ text, inline }: { text: string; inline?: boolean }) {
  const base = useContext(PrBase);
  const plugins = useMemo(() => [remarkGfm, ...(base ? [remarkPrLinks(base)] : [])], [base]);
  const md = (
    <ReactMarkdown
      remarkPlugins={plugins}
      disallowedElements={inline ? BLOCKS : undefined}
      unwrapDisallowed={inline}
      // The default transform removes every scheme but the web's and mail's.
      urlTransform={defaultUrlTransform}
      components={{
        ...(inline ? { p: Inline } : {}),
        img: ({ src, alt = "" }) => {
          const url = typeof src === "string" ? src : "";
          return /^https?:\/\//i.test(url) && !inline ? <ShownImage src={url} alt={alt} /> : <ShownImageChip src={url} alt={alt} />;
        },
        a: ({ node: _node, children, href, ...rest }) =>
          href && /^(?:https?|mailto):/i.test(href) ? (
            <a {...rest} href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ) : (
            <span title="A place on its host. You cannot open it from here.">{children}</span>
          ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
  if (!inline) return <div className="sx-md">{md}</div>;
  return (
    <span className="sx-md sx-md-inline" onClick={(e) => (e.target as HTMLElement).closest("a") && e.stopPropagation()}>
      {md}
    </span>
  );
}

function LocalMarkdown({ text, inline }: { text: string; inline?: boolean }) {
  const base = useContext(PrBase);
  const links = useContext(SessionLinks);
  const board = useBoardSessions();
  const { byName, tab } = useFamily();
  const local = useLocalAgents();
  // Names, not ids: the teammates around this session, and the agents it
  // started inside itself. A session's own id is linked by the pass before.
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const [n, id] of local.names) if (isLinkableName(n)) m.set(n, `#ev:${id}`);
    for (const [n, s] of byName) if (isLinkableName(n) && s.id !== links.self) m.set(n, hrefOf({ page: "session", id: s.id, tab }));
    return m;
  }, [local.names, byName, tab, links.self]);
  const plugins = useMemo(
    () => [remarkGfm, remarkFileRefs(), remarkImagePaths(), remarkLocalPaths(), ...(base ? [remarkPrLinks(base)] : []), remarkSessionLinks(links), remarkNameLinks(names)],
    [base, links, names],
  );
  const md = (
      <ReactMarkdown
        remarkPlugins={plugins}
        disallowedElements={inline ? BLOCKS : undefined}
        unwrapDisallowed={inline}
        urlTransform={keepOurUrls}
        components={{
          ...(inline ? { p: Inline } : {}),
          img: inline ? ShownImageChip : ShownImage,
          a: ({ node: _node, children, href, ...rest }) => {
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
          },
        }}
      >
        {text}
      </ReactMarkdown>
  );
  if (inline) {
    return (
      <span className="sx-md sx-md-inline" onClick={(e) => (e.target as HTMLElement).closest("a") && e.stopPropagation()}>
        {md}
      </span>
    );
  }
  return <div className="sx-md">{md}</div>;
}

/** react-markdown blanks any URL whose scheme it does not know, which would
 *  blank the links the passes here make (`fileref:`, `imgpath:`) and an image
 *  named by `file://`, one way an agent shows you one. */
function keepOurUrls(url: string, key: string): string {
  if (/^(?:fileref|imgpath):/.test(url)) return url;
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
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const src = typeof raw === "string" ? raw : "";
  const web = /^https?:\/\//i.test(src);
  const path = web ? src : safeDecode(src);
  const url = web ? src : session && path ? shownImageUrl(session, path) : null;
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
 *  is searched too: agents backtick these names far more often than not. */
function remarkSessionLinks({ index, self }: SessionLinksValue) {
  return () => (tree: Root) => {
    rewrite(tree, true, (text, code) =>
      splitRefs(text, code, (t) =>
        sessionRefs(t, index)
          .filter((r) => r.id !== self)
          .map((r) => ({ start: r.start, end: r.end, url: hrefOf({ page: "session", id: r.id, tab: "terminal" }) })),
      ),
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
