import { useContext, useMemo, useState } from "react";
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
import { titleOf } from "../../lib/board";
import { Icon } from "../../components";
import { Lightbox } from "../../attachments";
import { shownImageUrl } from "../../api";

/** Agent prose. External links open in a new tab: this page is a live
 *  terminal, and navigating away from it drops the attach. A link to another
 *  session stays here — it is the same page. */
/** One line of it, inside something you click (a row's summary): no blocks,
 *  and a click on a link inside is the link's, not the row's. */
const BLOCKS = ["h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "hr", "table", "thead", "tbody", "tr", "th", "td"];
const Inline = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

export function Markdown({ text, inline }: { text: string; inline?: boolean }) {
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
    () => [remarkGfm, remarkFileRefs(), ...(base ? [remarkPrLinks(base)] : []), remarkSessionLinks(links), remarkNameLinks(names)],
    [base, links, names],
  );
  const md = (
      <ReactMarkdown
        remarkPlugins={plugins}
        disallowedElements={inline ? BLOCKS : undefined}
        unwrapDisallowed={inline}
        urlTransform={keepFileImages}
        components={{
          ...(inline ? { p: Inline } : {}),
          img: ({ src, alt }) => <ShownImage src={typeof src === "string" ? src : ""} alt={alt ?? ""} session={links.self} inline={inline} />,
          a: ({ node: _node, children, href, ...rest }) => {
            if (href?.startsWith("fileref:")) {
              return (
                <code className="sx-fileref" title={href.slice("fileref:".length)}>
                  {children}
                </code>
              );
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
                    <StatusDot status={s.status} />
                    {children}
                  </a>
                );
              }
              return <a {...rest} href={href}>{children}</a>;
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

/** `file://` is not a scheme react-markdown lets through, but it is one way
 *  an agent names the image it is showing you. */
function keepFileImages(url: string, key: string): string {
  return key === "src" && url.startsWith("file://") ? url : defaultUrlTransform(url);
}

/** An image in agent prose. A web address loads as it is; anything else is a
 *  file on this machine, which the server reads (`/api/sessions/:id/image`).
 *  Big ones are shown shrunk, and a click opens them full size. A file gone
 *  since — or a one-line summary, which has no room — is a chip naming it. */
function ShownImage({ src, alt, session, inline }: { src: string; alt: string; session: string | null; inline?: boolean }) {
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const web = /^https?:\/\//i.test(src);
  const path = web ? src : safeDecode(src);
  const url = web ? src : session && path ? shownImageUrl(session, path) : null;
  const label = alt || path.split("/").pop() || "image";
  if (!url || broken || inline) {
    return (
      <code className="sx-fileref sx-img-chip" title={broken ? `Could not load ${path}` : path}>
        <Icon.image size={11} /> {label}
      </code>
    );
  }
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

/** Markdown percent-encodes a path written in `<…>`; the file has the plain name. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `#6307` in prose becomes a link to the PR. Code and existing links are
 *  left alone: a number inside a code block is the code's business. */
function remarkPrLinks(base: string) {
  return () => (tree: Root) => {
    rewrite(tree, false, (text, code) =>
      splitRefs(text, code, (t) => {
        const refs = prRefs(t);
        if (refs.length === 0) return [];
        return refs.map((r) => ({ start: r.start, end: r.end, url: prUrl(base, r.number) }));
      }),
    );
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
