import { useContext, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Parent, PhrasingContent, Root, RootContent } from "mdast";
import { prRefs, prUrl } from "../../lib/prlinks";
import { sessionRefs } from "../../lib/sessionrefs";
import { PrBase } from "./prbase";
import { SessionLinks, type SessionLinksValue } from "./sessionlinks";
import { hrefOf } from "../../route";

/** Agent prose. External links open in a new tab: this page is a live
 *  terminal, and navigating away from it drops the attach. A link to another
 *  session stays here — it is the same page. */
export function Markdown({ text }: { text: string }) {
  const base = useContext(PrBase);
  const links = useContext(SessionLinks);
  const plugins = useMemo(
    () => [remarkGfm, remarkFileRefs(), ...(base ? [remarkPrLinks(base)] : []), remarkSessionLinks(links)],
    [base, links],
  );
  return (
    <div className="sx-md">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={{
          a: ({ node: _node, children, href, ...rest }) => {
            if (href?.startsWith("fileref:")) {
              return (
                <code className="sx-fileref" title={href.slice("fileref:".length)}>
                  {children}
                </code>
              );
            }
            return <a {...rest} href={href} target={href?.startsWith("#/") ? undefined : "_blank"} rel="noreferrer">{children}</a>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
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
