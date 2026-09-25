import { useContext, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Parent, PhrasingContent, Root, RootContent } from "mdast";
import { prRefs, prUrl } from "../../lib/prlinks";
import { PrBase } from "./prbase";

/** Agent prose. Links open in a new tab: this page is a live terminal, and
 *  navigating away from it drops the attach. */
export function Markdown({ text }: { text: string }) {
  const base = useContext(PrBase);
  const plugins = useMemo(() => (base ? [remarkGfm, remarkPrLinks(base)] : [remarkGfm]), [base]);
  return (
    <div className="sx-md">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
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
    const walk = (node: Parent) => {
      node.children = node.children.flatMap((child: RootContent): RootContent[] => {
        if (child.type === "text") return splitRefs(child.value, base);
        if (child.type === "link" || child.type === "linkReference" || child.type === "code" || child.type === "inlineCode") return [child];
        if ("children" in child) walk(child);
        return [child];
      }) as typeof node.children;
    };
    walk(tree);
  };
}

function splitRefs(text: string, base: string): PhrasingContent[] {
  const refs = prRefs(text);
  if (refs.length === 0) return [{ type: "text", value: text }];
  const out: PhrasingContent[] = [];
  let at = 0;
  for (const r of refs) {
    if (r.start > at) out.push({ type: "text", value: text.slice(at, r.start) });
    out.push({ type: "link", url: prUrl(base, r.number), children: [{ type: "text", value: text.slice(r.start, r.end) }] });
    at = r.end;
  }
  if (at < text.length) out.push({ type: "text", value: text.slice(at) });
  return out;
}
