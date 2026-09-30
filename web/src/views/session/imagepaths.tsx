import { Fragment, useContext, useState } from "react";
import { Lightbox } from "../../attachments";
import { shownImageUrl } from "../../api";
import { SessionLinks } from "./sessionlinks";

/** A path to an image in text: absolute, `~/…`, `./…` or relative, ending in
 *  an extension the server will show. Not the tail of a URL (`https://…/a.png`
 *  is the web's), and no spaces — a quoted path with one stays text. */
const IMAGE_PATH = /(?<![\w/.~:@%+-])(?:~|\.{1,2})?\/?[\w.@%+~/-]*\w\.(?:png|jpe?g|gif|webp)(?![\w/]|\.\w)/gi;

export interface ImagePathRef {
  start: number;
  end: number;
  path: string;
}

export function imagePathRefs(text: string): ImagePathRef[] {
  if (!/\.(?:png|jpe?g|gif|webp)/i.test(text)) return [];
  return [...text.matchAll(IMAGE_PATH)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, path: m[0] }));
}

export const isImagePath = (s: string): boolean => {
  const r = imagePathRefs(s);
  return r.length === 1 && r[0]!.start === 0 && r[0]!.end === s.length;
};

/** An image's path, which opens the image full size. It sits inside rows that
 *  are buttons themselves, so the click is its own. */
export function ImagePath({ path, children }: { path: string; children?: React.ReactNode }) {
  const { self } = useContext(SessionLinks);
  const [open, setOpen] = useState(false);
  if (!self) return <>{children ?? path}</>;
  const url = shownImageUrl(self, path);
  return (
    <>
      <a
        href={url}
        className="sx-imgpath"
        title={`${path} · click to view`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {children ?? path}
      </a>
      {open ? <Lightbox src={url} label={path.split("/").pop() || path} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Plain text with every image path in it made an `ImagePath`. */
export function WithImagePaths({ text }: { text: string }) {
  const refs = imagePathRefs(text);
  if (refs.length === 0) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const r of refs) {
    if (r.start > at) out.push(<Fragment key={`t${at}`}>{text.slice(at, r.start)}</Fragment>);
    out.push(<ImagePath key={`p${r.start}`} path={r.path} />);
    at = r.end;
  }
  if (at < text.length) out.push(<Fragment key={`t${at}`}>{text.slice(at)}</Fragment>);
  return <>{out}</>;
}
