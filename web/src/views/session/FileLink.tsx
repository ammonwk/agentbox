import { useContext } from "react";
import { api } from "../../api";
import { Icon } from "../../components";
import { localFileLink } from "../../../../src/core/filelinks";
import { SessionLinks } from "./sessionlinks";
import { useAction } from "./useAction";

/** Opening is a desktop action, not navigation out of the attached session. */
export function FileLink({ path, children }: { path: string; children?: React.ReactNode }) {
  const { self } = useContext(SessionLinks);
  const { busy, error, run } = useAction();
  const html = localFileLink(path, true)?.html;
  if (!self) return <>{children ?? path}</>;
  return <>
    <a
      href="#"
      className={html ? "sx-desktoplink" : "sx-filelink"}
      title={`${path} · ${html ? "open in desktop browser" : "show in file explorer"}`}
      aria-disabled={busy}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) void run(() => api.openFile(self, path));
      }}
    >
      {!html && <Icon.folder size={12} />}{children ?? path}
    </a>
    {error && <span className="sx-filelink-error" role="alert"> {error}</span>}
  </>;
}
