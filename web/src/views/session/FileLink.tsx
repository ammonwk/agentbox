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
  const browser = localFileLink(path, true)?.browser;
  if (!self) return <>{children ?? path}</>;
  const open = (background: boolean) => { if (!busy) void run(() => api.openFile(self, path, background)); };
  return <>
    <a
      href="#"
      className={browser ? "sx-desktoplink" : "sx-filelink"}
      title={`${path} · ${browser ? "open in desktop browser (Ctrl-click: in the background)" : "show in file explorer"}`}
      aria-disabled={busy}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        open(e.ctrlKey || e.metaKey);
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        open(true);
      }}
    >
      {!browser && <Icon.folder size={12} />}{children ?? path}
    </a>
    {error && <span className="sx-filelink-error" role="alert"> {error}</span>}
  </>;
}
