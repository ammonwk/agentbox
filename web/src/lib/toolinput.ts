/** A tool call's input as fields to lay out, not JSON to read. Pure. */

export type InputField =
  /** A shell command, joined when it came as argv. */
  | { key: string; kind: "shell"; text: string }
  /** An edit: what was replaced and what replaced it. */
  | { key: string; kind: "diff"; old: string; new: string }
  /** Multi-line or long text, or a nested value as indented JSON. */
  | { key: string; kind: "block"; text: string }
  | { key: string; kind: "inline"; text: string };

const SHELL = ["command", "cmd"];
/** Where the call points, shown right after the command. */
const TARGET = ["file_path", "notebook_path", "path", "url", "pattern", "query"];

/**
 * The fields of a tool call's input, the command first and then what it
 * points at, the rest in the order the agent wrote them. `title` is already
 * in the row's header, so a `description` that says the same is left out.
 * Null when the input is not a JSON object (a patch, capped raw text): show
 * it as it is.
 */
export function inputFields(input: string | undefined, title?: string): InputField[] | null {
  if (!input) return null;
  let v: unknown;
  try {
    v = JSON.parse(input);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const obj = { ...(v as Record<string, unknown>) };
  if (typeof obj.description === "string" && title && obj.description.trim().startsWith(title.replace(/…$/, "").trim())) delete obj.description;

  const out: InputField[] = [];
  for (const k of SHELL) {
    const c = obj[k];
    const text = typeof c === "string" ? c : Array.isArray(c) && c.every((a) => typeof a === "string") ? shellJoin(c) : null;
    if (text === null) continue;
    out.push({ key: k, kind: "shell", text: unwrapShell(text) });
    delete obj[k];
  }
  for (const k of TARGET) {
    if (typeof obj[k] !== "string" || !obj[k]) continue;
    out.push(field(k, obj[k]));
    delete obj[k];
  }
  if (typeof obj.old_string === "string" && typeof obj.new_string === "string") {
    out.push({ key: "change", kind: "diff", old: obj.old_string, new: obj.new_string });
    delete obj.old_string;
    delete obj.new_string;
  }
  for (const [k, val] of Object.entries(obj)) {
    // An unset flag is the default: noise.
    if (val === null || val === undefined || val === "" || val === false) continue;
    out.push(field(k, val));
  }
  return out;
}

function field(key: string, v: unknown): InputField {
  if (typeof v === "string") return { key, kind: v.includes("\n") || v.length > 100 ? "block" : "inline", text: v };
  if (typeof v !== "object") return { key, kind: "inline", text: String(v) };
  if (Array.isArray(v) && v.every((a) => typeof a !== "object") && v.join(", ").length <= 100) return { key, kind: "inline", text: v.join(", ") };
  return { key, kind: "block", text: JSON.stringify(v, null, 2) };
}

/** Codex runs `["bash", "-lc", "<script>"]`: the script is the command. */
function unwrapShell(text: string): string {
  const m = /^(?:\/\S*\/)?(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(text);
  return m && !m[1]!.includes("'") ? m[1]! : text;
}

function shellJoin(argv: string[]): string {
  if (argv.length === 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)) return argv[2]!;
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** A field's key as a label: `file_path` → "file path". */
export const labelOf = (key: string): string => key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
