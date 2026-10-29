import { useContext } from "react";
import { api } from "../../api";
import { Icon } from "../../components";
import { localFileLink } from "../../../../src/core/filelinks";
import { SessionLinks } from "./sessionlinks";
import { useAction } from "./useAction";
import { AgentDir, FileBase, inBase, openInViewer, useOnThisMachine } from "./viewerstore";

const HTML = /\.html?$/i;

/** A file opens in the app's viewer, wherever the board is read. A page opens
 *  in the desktop browser when the board is read on this machine, since it
 *  may need its scripts and neighbors; Ctrl- or middle-click hands any file
 *  to the desktop there (a page behind the window in front). */
export function FileLink({ path: ref, children }: { path: string; children?: React.ReactNode }) {
  const { self } = useContext(SessionLinks);
  const path = inBase(useContext(FileBase), ref);
  const dirs = useContext(AgentDir);
  const here = useOnThisMachine();
  const { busy, error, run } = useAction();
  if (!self) return <>{children ?? ref}</>;
  const page = HTML.test(localFileLink(path, true)?.path ?? "");
  const desktop = (background: boolean) => {
    if (!busy) void run(() => api.openFile(self, path, background, dirs));
  };
  const open = (modified: boolean) => {
    if (here && (page || modified)) desktop(modified && page);
    else openInViewer({ session: self, path, dirs });
  };
  const title = here
    ? page
      ? "open in desktop browser (Ctrl-click: in the background)"
      : "view (Ctrl-click: show in file explorer)"
    : "view";
  return <>
    <a
      href="#"
      className={page ? "sx-desktoplink" : "sx-filelink"}
      title={`${ref} · ${title}`}
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
      {!page && <Icon.file size={12} />}{children ?? ref}
    </a>
    {error && <span className="sx-filelink-error" role="alert"> {error}</span>}
  </>;
}
