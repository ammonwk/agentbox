import { api } from "../api";

/** Ctrl-, Cmd- or middle-clicking a web link opens it behind the window in
 * front, so several can be opened in a row. Chrome given a link by the
 * installed app brings its window forward whatever the modifier, so on the
 * server's own desktop the server opens it instead, through chromectl. Any
 * other device, or a desktop without chromectl, keeps the browser's own. */
export function openLinksBehind(root: HTMLElement): void {
  let here = false;
  void api.desktop().then((d) => (here = d.backgroundTabs), () => undefined);
  const behind = (e: MouseEvent) => {
    if (!here || e.defaultPrevented) return;
    if (e.type === "click" ? !(e.button === 0 && (e.ctrlKey || e.metaKey)) : e.button !== 1) return;
    const a = (e.target as Element | null)?.closest?.("a[href]");
    const url = a instanceof HTMLAnchorElement ? a.href : "";
    if (!/^https?:/i.test(url) || new URL(url).origin === location.origin) return;
    e.preventDefault();
    e.stopPropagation();
    // Still inside the click's activation if the server can't do it.
    api.openUrl(url).catch(() => window.open(url, "_blank", "noreferrer"));
  };
  root.addEventListener("click", behind);
  root.addEventListener("auxclick", behind);
}
