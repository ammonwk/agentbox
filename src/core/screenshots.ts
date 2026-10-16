/** Recent desktop screenshots, discovered only when the human opens the picker. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { userHome } from "./paths";
import { shownImage } from "./images";
import { MAX_UPLOAD_BYTES } from "./uploads";

type Directory = { path: string; screenshotsOnly: boolean };
type Screenshot = { id: string; name: string; at: number };
const listed = new Map<string, { path: string; at: number; size: number; expires: number }>();
export function screenshotDirectories(): Directory[] {
  const home = userHome();
  if (process.platform === "darwin") {
    let path = join(home, "Desktop");
    try {
      const configured = execFileSync("defaults", ["read", "com.apple.screencapture", "location"], {encoding:"utf8",timeout:1000,stdio:["ignore","pipe","ignore"]}).trim();
      if (configured) path = configured.startsWith("~/") ? join(home,configured.slice(2)) : configured;
    } catch { /* macOS defaults to Desktop. */ }
    return [{path,screenshotsOnly:true}];
  }
  return [join(home,"Pictures","Screenshots"),join(home,"Pictures","screenshots"),join(home,"Desktop")]
    .map(path=>({path,screenshotsOnly:basename(path)==="Desktop"}));
}
export function recentScreenshots(directories = screenshotDirectories()): Screenshot[] {
  const now = Date.now();
  for (const [id, item] of listed) if (item.expires < now) listed.delete(id);
  const candidates: {path:string;at:number;size:number}[] = [];
  for (const directory of directories) {
    try {
      const root = realpathSync(directory.path);
      for (const name of readdirSync(root).sort().reverse().slice(0,5000)) {
        if (!/\.(png|jpe?g|gif|webp)$/i.test(name) || directory.screenshotsOnly && !/^(screenshot|screen shot|screen capture)[ _-]/i.test(name)) continue;
        const path = join(root,name), stat = lstatSync(path);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_UPLOAD_BYTES)
          candidates.push({path,at:stat.mtimeMs,size:stat.size});
      }
    } catch { /* Missing or inaccessible screenshot folders are an empty picker. */ }
  }
  const result: Screenshot[] = [];
  for (const item of candidates.sort((a,b)=>b.at-a.at)) {
    try { shownImage(item.path,null); } catch { continue; }
    const id = createHash("sha256").update(`${item.path}:${item.at}:${item.size}`).digest("hex");
    if (result.some(s=>s.id===id)) continue;
    listed.set(id,{...item,expires:now+10*60_000});
    result.push({id,name:basename(item.path),at:item.at});
    if (result.length===3) break;
  }
  while(listed.size>30) listed.delete(listed.keys().next().value!);
  return result;
}
/** No client path is accepted, and a listed file cannot be swapped for another. */
export function screenshotImage(id: string) {
  const item = listed.get(id);
  if (!item || item.expires < Date.now()) throw Error("Screenshot preview expired; reopen the picker");
  const stat = lstatSync(item.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs !== item.at || stat.size !== item.size) throw Error("Screenshot changed; reopen the picker");
  return shownImage(item.path,null);
}
