// What the board can ask of the desktop app. The GitHub CLI's token signs the
// app in to the cloud (supabase/functions/github-session); it goes from `gh`
// to the cloud through this window, never through the local server.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentboxDesktop", {
  githubToken: () => ipcRenderer.invoke("github-token"),
});
