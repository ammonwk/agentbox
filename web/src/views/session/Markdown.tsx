import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Agent prose. Links open in a new tab: this page is a live terminal, and
 *  navigating away from it drops the attach. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="sx-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
