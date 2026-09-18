import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { splitPRRefs } from "./format";

/**
 * Split a code or text value into mdast nodes, rewriting `#1234` references
 * into links. `plain` is the node type for the runs that stay as-is — `text`
 * for prose, `inlineCode` for backticked spans so their monospace styling
 * survives.
 */
function refsToNodes(value: string, prBase: string, plain: "text" | "inlineCode"): any[] {
  const out: any[] = [];
  for (const seg of splitPRRefs(value)) {
    if (seg.pr == null) {
      if (seg.text) out.push({ type: plain, value: seg.text });
    } else {
      out.push({
        type: "link",
        url: `${prBase}${seg.pr}`,
        children: [{ type: "text", value: seg.text }],
      });
    }
  }
  return out;
}

/**
 * Rewrite `#1234` references into links to the PR, as a remark plugin so the
 * decision is made on the markdown AST. Fenced code blocks carry their content
 * as `value`, not `children`, so a shell snippet containing `#1234` stays
 * verbatim; inline code does link, because a backticked `#1234` is an agent
 * citing the PR, not a comment.
 *
 * Registered as a tuple — `[remarkPRLinks, prBase]` — not by calling it:
 * unified treats whatever `.use()` receives as an *attacher* and calls it
 * itself. Hand it an already-built transformer and it gets invoked once with
 * no tree at freeze time, registers nothing, and silently links nothing.
 */
function remarkPRLinks(prBase: string) {
  const walk = (node: any, inLink: boolean) => {
    if (!node || typeof node !== "object") return;
    const childInLink = inLink || node.type === "link";
    for (const child of node.children ?? []) walk(child, childInLink);
    // Never rewrite inside an existing link, and only splice children that
    // carry their content as text or inline code.
    if (inLink || node.type === "link" || !Array.isArray(node.children)) return;

    node.children = node.children.flatMap((child: any) => {
      if (child.type === "inlineCode" && typeof child.value === "string" && /#\d{2,7}/.test(child.value)) {
        return refsToNodes(child.value, prBase, "inlineCode");
      }
      if (child.type !== "text" || typeof child.value !== "string" || !/#\d{2,7}/.test(child.value)) {
        return [child];
      }
      return refsToNodes(child.value, prBase, "text");
    });
  };
  return (tree: unknown) => walk(tree, false);
}

export function Markdown({ text, prBase }: { text: string; prBase?: string | null }) {
  const prPlugins: PluggableList = prBase ? [[remarkPRLinks, prBase]] : [];
  return (
    <div className="sx-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, ...prPlugins]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
