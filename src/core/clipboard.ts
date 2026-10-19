/** The desktop clipboard, kept across something that copies into it behind
 *  your back: Claude's /btw panel copies its answer to the system clipboard
 *  as well as into tmux, and agentbox presses that `c` to read the answer. */

type Tool = { read: (type?: string) => string[]; write: (type: string) => string[]; types: string[] };

const XCLIP: Tool = {
  read: (type) => ["xclip", "-selection", "clipboard", "-o", ...(type ? ["-t", type] : [])],
  write: (type) => ["xclip", "-selection", "clipboard", "-i", "-t", type],
  types: ["xclip", "-selection", "clipboard", "-o", "-t", "TARGETS"],
};
const WL: Tool = {
  read: (type) => ["wl-paste", "--no-newline", ...(type ? ["--type", type] : [])],
  write: (type) => ["wl-copy", "--type", type],
  types: ["wl-paste", "--list-types"],
};

function tool(): Tool | null {
  if (process.env.DISPLAY && Bun.which("xclip")) return XCLIP;
  if (process.env.WAYLAND_DISPLAY && Bun.which("wl-paste")) return WL;
  return null;
}

function run(cmd: string[]): Buffer | null {
  try {
    const r = Bun.spawnSync(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 2_000 });
    return r.exitCode === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/** What the clipboard holds now, and a function that puts it back once
 *  `copied` has landed there (or a moment has passed). Best effort: with no
 *  clipboard tool, or nothing on it, there is nothing to restore. */
export function keepClipboard(): (copied: string) => Promise<void> {
  const t = tool();
  if (!t) return async () => {};
  const types = (run(t.types)?.toString() ?? "").split("\n").map((s) => s.trim());
  // The first real type is the one the owner offers best: an image stays an image.
  const type = types.find((s) => s.includes("/") && !s.startsWith("x-special/")) ?? null;
  const saved = type ? run(t.read(type)) : null;
  return async (copied) => {
    // The TUI's own copy runs beside its tmux one, so it may land just after.
    for (let i = 0; i < 15 && run(t.read())?.toString().trimEnd() !== copied; i++) await Bun.sleep(100);
    if (!type || !saved) return;
    try {
      const p = Bun.spawn(t.write(type), { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      p.stdin.write(saved);
      await p.stdin.end();
    } catch {}
  };
}
