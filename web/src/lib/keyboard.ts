import { useEffect } from "react";
import { go, hrefOf, navOf, parseHash } from "../route";

const REGION = "[data-nav-region]";
const ITEM = "[data-nav-item]";
const CONTROL = 'a[href], button, input, textarea, select, summary, [tabindex="0"]';

function visible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && !el.closest('[hidden], [inert], [aria-hidden="true"]') && !el.matches(':disabled, [aria-disabled="true"]');
}

function all(root: ParentNode, selector: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(visible);
}

function regionOf(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>(REGION);
}

function items(region: HTMLElement): HTMLElement[] {
  const own = (selector: string) => all(region, selector).filter((el) => regionOf(el) === region);
  const marked = own(ITEM);
  return marked.length ? marked : own(CONTROL);
}

function selected(els: HTMLElement[]): HTMLElement | undefined {
  return els.find((el) => el.matches('[aria-current="page"], [aria-current="true"], [aria-selected="true"]')) ?? els[0];
}

function focus(el: HTMLElement | null | undefined): boolean {
  if (!el || !visible(el)) return false;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  return document.activeElement === el;
}

function selectorFor(el: HTMLElement): string | null {
  if (el.dataset.navId) return `[data-nav-id="${CSS.escape(el.dataset.navId)}"]`;
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el instanceof HTMLAnchorElement) return `a[href="${CSS.escape(el.getAttribute("href") ?? "")}"]`;
  return null;
}

/** Arrows move through navigation and into/out of panes. They never click
 * actions: only marked drill-in controls and internal page links open on →.
 * F6 moves between panes even from an editor or terminal. */
export function useKeyboardNavigation() {
  useEffect(() => {
    const remembered = new Map<string, string>();
    let cancelPending: (() => void) | undefined;
    const pageKey = () => navOf(parseHash(location.hash));
    const remember = (el: HTMLElement) => {
      const target = el.closest<HTMLElement>(ITEM) ?? el;
      const selector = selectorFor(target);
      if (selector && !el.closest(".sidebar")) remembered.set(pageKey(), selector);
    };
    const pageEntry = (): HTMLElement | undefined => {
      const content = document.getElementById("content");
      if (!content) return;
      const saved = remembered.get(pageKey());
      if (saved) {
        const el = all(content, saved)[0];
        if (el) return el;
      }
      const list = all(content, '[data-nav-region="list"]')[0];
      if (list) return selected(items(list)) ?? list;
      return selected(all(content, ITEM)) ?? all(content, CONTROL)[0];
    };
    const sidebar = () => focus(document.querySelector<HTMLElement>('.sidebar .nav-item[aria-current="page"]') ?? document.querySelector<HTMLElement>(".sidebar .nav-item"));
    // A route may mount a lazy page. Observe its DOM once instead of focusing
    // the old page or leaving focus on a link that was just unmounted.
    const afterRender = (find: () => HTMLElement | null | undefined) => {
      cancelPending?.();
      const expectedRoute = hrefOf(parseHash(location.hash));
      const observer = new MutationObserver(tryFocus);
      let frame = 0;
      const timer = setTimeout(() => {
        cancel();
        focus(document.getElementById("content"));
      }, 2000);
      function cancel() {
        observer.disconnect();
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        cancelPending = undefined;
      }
      function tryFocus() {
        if (document.getElementById("content")?.dataset.navRoute !== expectedRoute) return;
        const el = find();
        if (el && focus(el)) cancel();
      }
      cancelPending = cancel;
      observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });
      frame = requestAnimationFrame(tryFocus);
    };
    const open = (el: HTMLElement, find: () => HTMLElement | null | undefined) => {
      remember(el);
      el.click();
      afterRender(find);
    };
    const detailEntry = () => {
      const pane = all(document, '[data-nav-region="detail"]')[0];
      return pane && (all(pane, 'textarea[id^="cmp-"]')[0] ?? all(pane, '.tl')[0] ?? pane);
    };
    const left = (target: HTMLElement, region: HTMLElement): boolean => {
      if (region.dataset.navRegion === "navigation") return true;
      if (region.dataset.navRegion === "detail") {
        const list = all(document, '[data-nav-region="list"]')[0];
        if (list) return focus(selected(items(list)) ?? list);
        const back = all(region, "[data-nav-back]")[0];
        if (back) { open(back, pageEntry); return true; }
        if (parseHash(location.hash).page === "session") {
          go({ page: "sessions" });
          afterRender(pageEntry);
          return true;
        }
      }
      const item = target.closest<HTMLElement>(ITEM);
      if (item && target !== item && !item.matches('a, button')) return focus(item);
      const route = parseHash(location.hash);
      if (route.page === "accounts" && route.sub !== "accounts") {
        go({ page: "accounts", sub: "accounts" });
        afterRender(pageEntry);
        return true;
      }
      remember(target);
      return sidebar();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('.modal-backdrop, [role="dialog"][aria-modal="true"]')) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!target) return;
      const region = regionOf(target) ?? document.getElementById("content");
      if (!region) return;
      if (e.key === "F6") {
        const zones = all(document, REGION).filter((el) => !all(el, REGION).length);
        const i = zones.indexOf(region);
        const next = zones[(i + (e.shiftKey ? -1 : 1) + zones.length) % zones.length];
        if (next && focus(selected(items(next)) ?? next)) { e.preventDefault(); e.stopPropagation(); }
        return;
      }
      if (e.shiftKey || target.closest('.xterm, [role="menu"], [role="listbox"], [role="slider"], [role="separator"]')) return;
      const field = target.matches("input, textarea, select") || target.isContentEditable;
      if (field) {
        // Keep normal caret movement. Only a search/composer at its left
        // boundary can step out, matching the existing chat shortcut.
        const text = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
        const atStart = text && text.matches('[data-search], textarea[id^="cmp-"]') && text.selectionStart === 0 && text.selectionEnd === 0;
        if (e.key === "ArrowLeft" && atStart && left(target, region)) {
          e.preventDefault(); e.stopPropagation();
        } else if (e.key === "ArrowDown" && target.matches("[data-search]") && focus(selected(items(region)))) {
          e.preventDefault(); e.stopPropagation();
        }
        return;
      }
      let handled = false;
      if (e.key === "ArrowLeft") handled = left(target, region);
      else if (e.key === "ArrowRight" || (e.key === "Enter" && (target.matches(ITEM) || region.dataset.navRegion === "navigation"))) {
        if (region.dataset.navRegion === "navigation" && target instanceof HTMLAnchorElement) {
          const to = parseHash(target.hash);
          open(target, () => document.querySelector(`.app[data-page="${to.page}"]`) ? pageEntry() : null);
          handled = true;
        } else if (region.dataset.navRegion === "list" && target.matches(ITEM)) {
          open(target, detailEntry);
          handled = true;
        } else if (target.matches(ITEM) && !target.matches("a, button")) {
          const entry = all(target, "[data-nav-enter]")[0];
          if (entry) open(entry, () => document.querySelector<HTMLElement>('[data-nav-region="detail"]'));
          else focus(all(target, CONTROL)[0]);
          handled = true;
        } else if (target instanceof HTMLAnchorElement && target.getAttribute("href")?.startsWith("#/")) {
          open(target, pageEntry);
          handled = true;
        } else if (target === region) handled = focus(items(region)[0]);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
        const item = target.closest<HTMLElement>(ITEM);
        // A focused scrollable transcript keeps ↑/↓ for reading.
        if (target.matches('.tl, .sk-body') || region.dataset.navRegion === "detail") return;
        const controls = item && target !== item ? all(item, CONTROL) : items(region);
        const i = controls.indexOf(target);
        const next = e.key === "Home" ? 0 : e.key === "End" ? controls.length - 1 : Math.max(0, Math.min(controls.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        handled = focus(controls[next]);
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    // Bubble after each widget's own handler, but before the session's window
    // shortcuts. Capture F6 alone so it can leave the terminal as well.
    const onF6 = (e: KeyboardEvent) => { if (e.key === "F6") onKey(e); };
    const onPointer = () => cancelPending?.();
    document.addEventListener("keydown", onKey);
    document.addEventListener("keydown", onF6, true);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      cancelPending?.();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", onF6, true);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, []);
}
