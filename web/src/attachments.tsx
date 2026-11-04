/** Images pasted into a prompt box.
 *
 * Paste, drop or pick an image and it is uploaded at once (src/core/uploads.ts)
 * while an `[Image #1]` token goes in at the caret, so the text can say where
 * each one belongs ("compare [Image #1] with [Image #2]"). The token and the
 * thumbnail are one thing: delete either and the other goes too. On send the
 * tokens become `[Image #1: /path/to/file.png]`, which every agent CLI can
 * read from disk.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { api, uploadUrl } from "./api";
import { Icon, Spinner } from "./components";
import { stepOf, trailFrom } from "./lib/previews";
import { loadDraft, newRevision, saveDraft } from "./views/session/drafts";

export interface Attachment {
  n: number;
  /** Thumbnail source: a blob URL while local, the server's once restored. */
  url: string;
  state: "uploading" | "ready" | "error";
  error: string | null;
  /** Kept to retry a failed upload; absent for a restored draft's images. */
  file?: File;
}

/** What a draft remembers of an uploaded image. */
export interface SavedAttachment {
  n: number;
  name: string;
  path: string;
}

const TOKEN = /\[Image #(\d+)\]/g;
const tokenOf = (n: number) => `[Image #${n}]`;

export function tokensIn(text: string): Set<number> {
  return new Set([...text.matchAll(TOKEN)].map((m) => Number(m[1])));
}

/** Drop a token and one space beside it, so removing it leaves no gap. */
export function removeToken(text: string, n: number): string {
  const t = tokenOf(n);
  const i = text.indexOf(t);
  if (i < 0) return text;
  let a = i;
  let b = i + t.length;
  if (text[b] === " ") b++;
  else if (a > 0 && text[a - 1] === " ") a--;
  return text.slice(0, a) + text.slice(b);
}

/** `[Image #1]` → `[Image #1: /path]`, for the images that uploaded. */
export function expandImages(text: string, paths: ReadonlyMap<number, string>): string {
  return text.replace(TOKEN, (whole, n: string) => {
    const p = paths.get(Number(n));
    return p ? `[Image #${n}: ${p}]` : whole;
  });
}

export function useAttachments({
  text,
  setText,
  textareaRef,
  initial,
}: {
  text: string;
  setText: (t: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  initial?: readonly SavedAttachment[];
}) {
  const [atts, setAtts] = useState<Attachment[]>(() =>
    (initial ?? []).filter((a) => tokensIn(text).has(a.n)).map((a) => ({ n: a.n, url: uploadUrl(a.name), state: "ready", error: null })),
  );
  /** Uploads, by image number: read at send time without waiting on a render. */
  const saved = useRef(new Map<number, { name: string; path: string }>((initial ?? []).map((a) => [a.n, { name: a.name, path: a.path }])));
  const pending = useRef(new Map<number, Promise<void>>());
  const [dropping, setDropping] = useState(false);
  const pendingCaret = useRef<number | null>(null);

  // A token deleted from the text takes its image with it.
  useEffect(() => {
    const live = tokensIn(text);
    if (atts.some((a) => !live.has(a.n))) {
      for (const a of atts) if (!live.has(a.n)) forget(a);
      setAtts((xs) => xs.filter((a) => live.has(a.n)));
    }
    const el = textareaRef.current;
    if (el && pendingCaret.current != null) {
      el.focus();
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);

  useEffect(() => () => atts.forEach((a) => a.url.startsWith("blob:") && URL.revokeObjectURL(a.url)), []);

  function forget(a: Attachment) {
    if (a.url.startsWith("blob:")) URL.revokeObjectURL(a.url);
    saved.current.delete(a.n);
    pending.current.delete(a.n);
  }

  function upload(n: number, file: File) {
    // An image removed mid-upload may have its number reused by the next
    // paste; the old upload landing late must not claim it.
    const current = () => pending.current.get(n) === p;
    const p: Promise<void> = api
      .upload(file)
      .then((u) => {
        if (!current()) return;
        saved.current.set(n, u);
        setAtts((xs) => xs.map((a) => (a.n === n ? { ...a, state: "ready", error: null } : a)));
      })
      .catch((e: unknown) => {
        if (!current()) return;
        setAtts((xs) => xs.map((a) => (a.n === n ? { ...a, state: "error", error: e instanceof Error ? e.message : String(e) } : a)));
      })
      .finally(() => {
        if (current()) pending.current.delete(n);
      });
    pending.current.set(n, p);
  }

  /** Attach the images among `files`; false when there were none. */
  function add(files: readonly File[]): boolean {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return false;
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    let n = Math.max(0, ...atts.map((a) => a.n), ...tokensIn(text));
    const added: Attachment[] = images.map((file) => ({ n: ++n, url: URL.createObjectURL(file), state: "uploading", error: null, file }));
    const before = text.slice(0, start);
    const after = text.slice(end);
    const ins = `${before && !/\s$/.test(before) ? " " : ""}${added.map((a) => tokenOf(a.n)).join(" ")}${after && !/^\s/.test(after) ? " " : ""}`;
    pendingCaret.current = before.length + ins.length;
    setAtts((xs) => [...xs, ...added]);
    setText(before + ins + after);
    for (const a of added) upload(a.n, a.file!);
    return true;
  }

  function remove(n: number) {
    const a = atts.find((x) => x.n === n);
    if (a) forget(a);
    setAtts((xs) => xs.filter((x) => x.n !== n));
    setText(removeToken(text, n));
  }

  function retry(n: number) {
    const a = atts.find((x) => x.n === n);
    if (!a?.file) return remove(n);
    setAtts((xs) => xs.map((x) => (x.n === n ? { ...x, state: "uploading", error: null } : x)));
    upload(n, a.file);
  }

  /** The text to send: waits for uploads in flight, refuses if one failed. */
  async function resolve(t: string): Promise<string> {
    await Promise.all(pending.current.values());
    const missing = [...tokensIn(t)].filter((n) => atts.some((a) => a.n === n) && !saved.current.has(n));
    if (missing.length) throw new Error(`image #${missing.join(", #")} did not upload — retry it or remove it`);
    return expandImages(t, new Map([...saved.current].map(([n, u]) => [n, u.path])));
  }

  function clear() {
    atts.forEach(forget);
    setAtts([]);
  }

  /** Reattach a failed submission's already uploaded images, with numbers
   *  chosen by the composer so they do not collide with its newer input. */
  function restore(uploaded: readonly SavedAttachment[]) {
    for (const a of uploaded) saved.current.set(a.n, { name: a.name, path: a.path });
    setAtts((xs) => [...xs, ...uploaded.map((a): Attachment => ({ n: a.n, url: uploadUrl(a.name), state: "ready", error: null }))]);
  }

  /** Backspace right after a token deletes the whole token, not its `]`. */
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (e.key !== "Backspace" && e.key !== "Delete") return false;
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd) return false;
    const at = el.selectionStart;
    const m =
      e.key === "Backspace" ? /\[Image #(\d+)\]$/.exec(text.slice(0, at)) : /^\[Image #(\d+)\]/.exec(text.slice(at));
    if (!m) return false;
    e.preventDefault();
    const n = Number(m[1]);
    const from = e.key === "Backspace" ? at - m[0].length : at;
    const a = atts.find((x) => x.n === n);
    if (a) forget(a);
    setAtts((xs) => xs.filter((x) => x.n !== n));
    pendingCaret.current = from;
    setText(text.slice(0, from) + text.slice(from + m[0].length));
    return true;
  }

  const handlers = {
    onPaste(e: React.ClipboardEvent) {
      if (add([...e.clipboardData.files])) e.preventDefault();
    },
    onDragOver(e: React.DragEvent) {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropping(true);
    },
    onDragLeave(e: React.DragEvent) {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
    },
    onDrop(e: React.DragEvent) {
      setDropping(false);
      if (add([...e.dataTransfer.files])) e.preventDefault();
    },
  };

  return {
    atts,
    add,
    remove,
    retry,
    resolve,
    clear,
    restore,
    onKeyDown,
    handlers,
    dropping,
    uploading: atts.some((a) => a.state === "uploading"),
    /** For a draft: the images that made it to the server. */
    saved: (): SavedAttachment[] =>
      atts.flatMap((a) => {
        const u = saved.current.get(a.n);
        return u ? [{ n: a.n, ...u }] : [];
      }),
  };
}

export type Attachments = ReturnType<typeof useAttachments>;

/**
 * A text box with images that keeps what is typed in it as the composer keeps
 * its draft (views/session/drafts.ts), under `key`: closing the box or
 * reloading the page finds the text and its images where they were. `body()`
 * is the text to send, the images as paths; `discard()`, once it is sent,
 * forgets the draft, and is safe after the box is gone.
 */
export function useDraft(key: string, textareaRef: RefObject<HTMLTextAreaElement | null>) {
  const draft = useMemo(() => loadDraft(key), [key]);
  const [text, setText] = useState(draft?.text ?? "");
  const revision = useRef(draft?.revision ?? newRevision()).current;
  const images = useAttachments({ text, setText, textareaRef, initial: draft?.images });
  const saved = images.saved();
  const savedKey = JSON.stringify(saved);
  useEffect(() => void saveDraft(key, text, saved, revision, revision), [key, text, savedKey]);
  return {
    text,
    setText,
    images,
    body: async () => (await images.resolve(text)).trim(),
    discard: () => void saveDraft(key, "", [], revision, revision),
  };
}

/**
 * The frame a prompt box and its images share: the border, the focus ring
 * and the drop highlight are on this, so the thumbnails read as part of the
 * box rather than something under it.
 */
export function AttachFrame({ a, className, children, footer }: { a: Attachments; className?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className={`att-frame${className ? ` ${className}` : ""}`} data-drop={a.dropping || undefined} {...a.handlers}>
      {children}
      <AttachmentStrip a={a} />
      {footer}
      {a.dropping ? <div className="att-dropzone">Drop to attach</div> : null}
    </div>
  );
}

/** A paperclip that opens the file picker. */
export function AttachButton({ a, className }: { a: Attachments; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={`att-pick${className ? ` ${className}` : ""}`}
        title="Attach images — or paste or drop them into the box"
        aria-label="Attach images"
        onClick={() => input.current?.click()}
      >
        <Icon.paperclip size={17} />
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          a.add([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </>
  );
}

function AttachmentStrip({ a }: { a: Attachments }) {
  const [preview, setPreview] = useState<HTMLElement | null>(null);
  if (a.atts.length === 0) return null;
  return (
    <div className="att-strip" role="list" aria-label="Attached images" data-preview-scope="">
      {a.atts.map((x) => (
        <div key={x.n} role="listitem" className="att" data-state={x.state}>
          <button
            type="button"
            className="att-thumb"
            title={x.state === "error" ? `Upload failed: ${x.error} — click to retry` : x.state === "uploading" ? "Uploading…" : `Image #${x.n} — click to view`}
            data-preview={x.state === "error" ? undefined : "image"}
            data-target={x.url}
            data-label={`Image #${x.n}`}
            onClick={(e) => (x.state === "error" ? a.retry(x.n) : setPreview(e.currentTarget))}
          >
            <img src={x.url} alt={`Image #${x.n}`} draggable={false} />
            {x.state === "uploading" ? (
              <span className="att-over">
                <Spinner size={14} />
              </span>
            ) : x.state === "error" ? (
              <span className="att-over att-err">
                <Icon.refresh size={14} />
              </span>
            ) : null}
          </button>
          <span className="att-n" aria-hidden="true">
            #{x.n}
          </span>
          <button type="button" className="att-x" aria-label={`Remove image #${x.n}`} title="Remove" onClick={() => a.remove(x.n)}>
            <Icon.x size={10} />
          </button>
        </div>
      ))}
      {preview ? <Lightbox from={preview} onClose={() => setPreview(null)} /> : null}
    </div>
  );
}

/** Full size, over everything; Escape or a click anywhere closes it — and
 *  only it, not the dialog underneath. ← and → step to the images beside the
 *  one it was opened from (`lib/previews`). */
export function Lightbox({ from, onClose }: { from: HTMLElement; onClose: () => void }) {
  const [trail, setTrail] = useState(() => trailFrom(from));
  const { target: src, label } = trail.items[trail.at]!;
  // An agent's path can name a file that is gone, or never was an image.
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = e.key === "Escape" ? 0 : stepOf(e, trail);
      if (e.key !== "Escape" && !step) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (step) setTrail({ ...trail, at: trail.at + step });
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, trail]);
  const count = trail.items.length > 1 ? ` · ${trail.at + 1} of ${trail.items.length}` : "";
  return createPortal(
    // React events bubble through a portal to the dialog underneath, whose
    // backdrop would take this click as "close the dialog".
    <div
      className="att-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      {failed === src ? <span className="att-lightbox-err">Could not open {label}: it is gone, or not an image.</span> : <img key={src} src={src} alt={label} onError={() => setFailed(src)} />}
      <span className="att-lightbox-cap">{label}{count} · Esc to close</span>
    </div>,
    document.body,
  );
}
