// agentbox in a desktop window. The window only shows the board the server
// already serves: the server stays a process of its own (AGENTS.md), so
// quitting this app stops no agent. When the server is down, the app runs
// `agentbox start`, which starts it as any other command would.

const { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, session, shell } = require("electron");
const { execFile, execFileSync } = require("node:child_process");
const { homedir } = require("node:os");
const { join, resolve } = require("node:path");

const PORT = Number(process.env.AGENTBOX_PORT ?? 4479);
const ORIGIN = `http://localhost:${PORT}`;
const HOME = process.env.AGENTBOX_HOME ?? join(homedir(), ".local", "share", "agentbox");
// The board's icon on the macOS grid: a rounded body with a margin, as the Dock expects.
const ICON = join(__dirname, "icon.png");
/** The checkout this app is in: `agentbox start` there uses its service and serve-from-commit. */
const CHECKOUT = process.env.AGENTBOX_CHECKOUT ?? resolve(__dirname, "..");

/** A Dock launch has launchd's bare PATH, so ask a login shell where things are. */
function loginEnv() {
  try {
    const path = execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", "printf %s \"$PATH\""], { encoding: "utf8", timeout: 5000 });
    return { ...process.env, PATH: path };
  } catch {
    return { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };
  }
}

/** A URL on the board itself. A prefix test would let `localhost:4479.example.com` in. */
function ours(url) {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
}

async function reachable() {
  try {
    return (await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await reachable()) return true;
  // `start` waits for the server and exits non-zero when it does not come up.
  const started = await new Promise((done) => {
    execFile("bun", [join(CHECKOUT, "bin", "agentbox"), "start"], { cwd: CHECKOUT, env: loginEnv(), timeout: 60_000 }, (err) => done(!err));
  });
  return started && (await reachable());
}

let win = null;
let tray = null;

function show() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 400,
    minHeight: 300,
    title: "agentbox",
    icon: ICON,
    backgroundColor: "#111111",
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: true },
  });
  // Links to anywhere but the board open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!ours(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (ours(url)) return;
    e.preventDefault();
    void shell.openExternal(url);
  });
  win.on("closed", () => (win = null));
  void win.loadURL(ORIGIN);
}

function failurePage() {
  const log = join(HOME, "logs", "server.log");
  const html = `<body style="font:15px system-ui;background:#111;color:#ddd;padding:48px">
    <h2>The agentbox server did not start</h2><p>See <code>${log}</code>, then reopen the app.</p></body>`;
  win = new BrowserWindow({ width: 640, height: 320, title: "agentbox" });
  void win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", show);
app.setName("agentbox");

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(ICON);
  // The microphone for Voice and notifications; nothing else asks here.
  session.defaultSession.setPermissionRequestHandler((wc, permission, done) => {
    done(ours(wc.getURL()) && ["media", "notifications", "clipboard-read", "clipboard-sanitized-write"].includes(permission));
  });

  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 18, height: 18 }));
  tray.setToolTip("agentbox");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "Show agentbox", click: show }, { type: "separator" }, { role: "quit" }]));
  tray.on("click", show);
  globalShortcut.register("CommandOrControl+Shift+A", show);

  if (await ensureServer()) createWindow();
  else failurePage();
});

app.on("activate", show);
// The tray keeps it running on macOS, as other Mac apps do.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => globalShortcut.unregisterAll());
