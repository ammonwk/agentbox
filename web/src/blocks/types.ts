/** What a block page is made of: an extension's program answers `GET <src>/view?tab=`
 *  with a `View`, and `POST <src>/action` with an `ActionReply` (docs/extensions.md). */

/** A page: its tabs, its blocks, and how often to ask again. */
export interface View {
  title?: string;
  /** Its tabs; the page asks for one with `?tab=`. */
  tabs?: { id: string; title: string; badge?: number | string }[];
  blocks: Block[];
  /** Ask again after this many seconds (at least 2). */
  refresh?: number;
}

export interface Action {
  id: string;
  label: string;
  style?: "primary" | "danger";
  /** Asked before the action is sent. */
  confirm?: string;
  /** Sent with the action, beside the form's values. */
  values?: Record<string, unknown>;
}

export type Field =
  | { name: string; label: string; kind: "text" | "textarea"; value?: string; placeholder?: string; rows?: number }
  | { name: string; label: string; kind: "select"; value?: string; options: { value: string; label: string }[] }
  | { name: string; label: string; kind: "checkbox"; value?: boolean };

export type Status = "ok" | "warn" | "bad" | "busy" | "idle";

/** One entry of a `split` block's list, and what its pane shows when chosen. */
export interface Pane {
  id: string;
  title: string;
  subtitle?: string;
  /** Shown at the row's right: a count, a size. */
  badge?: string | number;
  status?: Status;
  blocks: Block[];
}

export type Block =
  | { type: "heading"; text: string }
  | { type: "markdown"; text: string }
  | { type: "fields"; items: { label: string; value: string }[] }
  | { type: "divider" }
  | { type: "actions"; actions: Action[] }
  | { type: "form"; id: string; fields: Field[]; actions: Action[] }
  /** Text shown exactly as given, in a fixed-width font: whitespace, blank
   *  lines and markup characters kept. It scrolls past `maxHeight` pixels
   *  (default 480), and has a copy button and a wrap toggle (`wrap`, default on). */
  | { type: "text"; text: string; title?: string; wrap?: boolean; maxHeight?: number }
  /** A list beside the pane of the entry chosen in it, as on the Skills page;
   *  one at a time on a phone. The choice is the browser's, kept across
   *  refreshes by `id`; `selected` is the first one shown. */
  | { type: "split"; id: string; title?: string; items: Pane[]; selected?: string }
  /** Alternative views of one thing, chosen with a segmented control in the
   *  browser and kept across refreshes by `id`. */
  | { type: "switch"; id: string; options: { id: string; label: string; blocks: Block[] }[]; selected?: string }
  | {
      type: "item";
      id?: string;
      title: string;
      subtitle?: string;
      status?: Status;
      /** Markdown. */
      body?: string;
      /** Session ids, linked to their pages. */
      sessions?: string[];
      links?: { label: string; url: string }[];
      actions?: Action[];
      children?: Block[];
      /** Folds under its header, which opens and closes it: `true` starts it
       *  folded, `false` open. Kept across refreshes by `id`. */
      collapsed?: boolean;
    };

/** What an action answers: words to show, a page to show instead, or an app link to go to (`#/session/<id>`). */
export interface ActionReply {
  message?: string;
  view?: View;
  open?: string;
}
