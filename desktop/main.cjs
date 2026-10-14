// agentbox in a desktop window. The window only shows the board the server
// already serves: the server stays a process of its own (AGENTS.md), so
// quitting this app stops no agent. When the server is down, the app starts
// it the way `ensureServer` (src/cli/index.ts) does where no systemd is.

const { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, session, shell } = require("electron");
const { execFileSync, spawn } = require("node:child_process");
const { existsSync, mkdirSync, openSync } = require("node:fs");
const { homedir } = require("node:os");
const { join, resolve } = require("node:path");

const PORT = Number(process.env.AGENTBOX_PORT ?? 4479);
const ORIGIN = `http://localhost:${PORT}`;
const HOME = process.env.AGENTBOX_HOME ?? join(homedir(), ".local", "share", "agentbox");
const ICON = resolve(__dirname, "..", "web", "public", "icon-512.png");

/** The checkout the server runs from: the deployed one when there is one, else this one. */
function checkout() {
  if (process.env.AGENTBOX_CHECKOUT) return process.env.AGENTBOX_CHECKOUT;
  const live = join(HOME, "live");
  return existsSync(join(live, "bin", "agentbox")) ? live : resolve(__dirname, "..");
}

/** A Dock launch has launchd's bare PATH, so ask a login shell where things are. */
function loginEnv() {
  try {
    const path = execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", "printf %s \"$PATH\""], { encoding: "utf8", timeout: 5000 });
    return { ...process.env, PATH: path };
  } catch {
    return { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };
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
  const logs = join(HOME, "logs");
  mkdirSync(logs, { recursive: true });
  const log = openSync(join(logs, "server.log"), "a");
  const root = checkout();
  // detached: a session of its own, so it outlives this app.
  spawn("bun", [join(root, "bin", "agentbox"), "serve"], { cwd: root, env: loginEnv(), detached: true, stdio: ["ignore", log, log] }).unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await reachable()) return true;
  }
  return false;
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
    if (!url.startsWith(ORIGIN)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith(ORIGIN)) return;
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
    done(wc.getURL().startsWith(ORIGIN) && ["media", "notifications", "clipboard-read", "clipboard-sanitized-write"].includes(permission));
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
