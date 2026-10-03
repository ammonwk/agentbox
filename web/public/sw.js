// agentbox as an installed app. The page is always fetched fresh when there is
// a network — stale code after a `web:build` is the failure this must never
// cause — and falls back to the last copy offline. Content-hashed assets are
// immutable, so they are served from the cache once seen. The API and the
// sockets are never touched. It also shows the server's pushes — a session
// blocked on you (src/core/push.ts) — and a tap opens that session.
const CACHE = "agentbox-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;

  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/").then((r) => r || new Response("agentbox is unreachable — is Tailscale on?", { status: 503 }))),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

self.addEventListener("push", (e) => {
  let msg = {};
  try {
    msg = e.data.json();
  } catch {
    // Not ours to read; still shown, since iOS drops a subscription whose pushes show nothing.
  }
  e.waitUntil(
    self.registration.showNotification(msg.title || "agentbox", {
      body: msg.body || "",
      tag: msg.tag,
      icon: "/icon-512.png",
      data: { url: msg.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((open) => {
      // An open app goes there itself (lib/push.ts): navigating it from here would reload it.
      const app = open.find((c) => c.visibilityState === "visible") || open[0];
      if (!app) return self.clients.openWindow(url);
      app.postMessage({ type: "open", url });
      return app.focus();
    }),
  );
});
