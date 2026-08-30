import type { Env } from "./types";

/**
 * The web app. It exists so a phone can receive notifications from this Worker
 * directly, with no third-party notification service in the path.
 *
 * On iOS, Web Push only works once the page has been added to the home screen,
 * so most of the interface here is about getting through that step and then
 * showing whether it actually worked.
 */

export function appPage(env: Env, origin: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>PopcornPager</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="PopcornPager">
<meta name="theme-color" content="#101218">
<style>
  :root {
    --bg: #101218;
    --panel: #191c24;
    --line: #262b36;
    --text: #e8eaf0;
    --dim: #939aab;
    --accent: #fbbf24;
    --good: #6ee7b7;
    --bad: #f87171;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: max(1.25rem, env(safe-area-inset-top)) 1.25rem calc(2rem + env(safe-area-inset-bottom));
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    max-width: 34rem;
    margin-inline: auto;
    -webkit-text-size-adjust: 100%;
  }
  header { display: flex; align-items: center; gap: .7rem; margin-bottom: 1.5rem; }
  header img { width: 34px; height: 34px; border-radius: 9px; }
  h1 { font-size: 1.1rem; margin: 0; letter-spacing: -0.01em; }
  h1 span { display: block; font-size: .78rem; font-weight: 400; color: var(--dim); }
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 1.05rem 1.1rem;
    margin-bottom: .9rem;
  }
  .card h2 { font-size: .95rem; margin: 0 0 .5rem; }
  .card p { margin: 0 0 .75rem; color: var(--dim); font-size: .9rem; }
  .card p:last-child { margin-bottom: 0; }
  ol { margin: 0; padding-left: 1.2rem; color: var(--dim); font-size: .9rem; }
  ol li { margin-bottom: .4rem; }
  button {
    appearance: none;
    width: 100%;
    padding: .8rem 1rem;
    font: inherit;
    font-weight: 600;
    color: #1a1204;
    background: var(--accent);
    border: 0;
    border-radius: 10px;
    cursor: pointer;
  }
  button.secondary { background: transparent; color: var(--text); border: 1px solid var(--line); }
  button:disabled { opacity: .45; }
  button + button { margin-top: .55rem; }
  input {
    width: 100%;
    padding: .7rem .8rem;
    font: inherit;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 10px;
    margin-bottom: .6rem;
  }
  .status { display: flex; align-items: baseline; gap: .5rem; font-size: .88rem; padding: .3rem 0; }
  .status b { font-weight: 600; min-width: 7.5rem; color: var(--dim); }
  .dot { width: .5rem; height: .5rem; border-radius: 50%; background: var(--dim); flex: none; align-self: center; }
  .dot.on { background: var(--good); }
  .dot.off { background: var(--bad); }
  .dot.wait { background: var(--accent); }
  .msg { border-top: 1px solid var(--line); padding: .7rem 0; }
  .msg:first-of-type { border-top: 0; padding-top: 0; }
  .msg h3 { font-size: .9rem; margin: 0 0 .15rem; }
  .msg pre { margin: 0; font: inherit; white-space: pre-wrap; color: var(--dim); font-size: .87rem; }
  .msg time { font-size: .75rem; color: var(--dim); }
  .hint { font-size: .8rem; color: var(--dim); margin-top: .6rem; }
</style>
</head>
<body>
  <header>
    <img src="/icon.png" alt="">
    <h1>PopcornPager<span>${escapeHtml(hostOf(origin))}</span></h1>
  </header>

  <div class="card" id="install" hidden>
    <h2>Add this to your home screen first</h2>
    <p>iOS only allows notifications for web apps opened from the home screen. Safari on its own cannot ask.</p>
    <ol>
      <li>Tap the share button at the bottom of Safari.</li>
      <li>Choose <b>Add to Home Screen</b>.</li>
      <li>Open PopcornPager from your home screen and finish there.</li>
    </ol>
    <p class="hint" id="copyHint">A home screen app gets its own storage, so it will ask for the
      token again. Copy it now and it is one paste away.</p>
    <button class="secondary" id="copyToken" style="margin-top:.5rem">Copy token</button>
  </div>

  <div class="card" id="tokenCard" hidden>
    <h2>Sign in</h2>
    <p>Paste the token this server was deployed with. It stays on this device.</p>
    <input id="token" type="password" placeholder="tk_..." autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false">
    <button id="saveToken">Save</button>
  </div>

  <div class="card" id="enableCard" hidden>
    <h2>Turn on notifications</h2>
    <p>Buy a cinema ticket and this will tell you when the best moment to step out is, and whether to sit through the credits.</p>
    <button id="enable">Enable notifications</button>
  </div>

  <div class="card" id="statusCard" hidden>
    <h2>Status</h2>
    <div class="status"><span class="dot" id="dotHome"></span><b>Home screen</b><span id="valHome">-</span></div>
    <div class="status"><span class="dot" id="dotPerm"></span><b>Permission</b><span id="valPerm">-</span></div>
    <div class="status"><span class="dot" id="dotSub"></span><b>Subscription</b><span id="valSub">-</span></div>
    <button class="secondary" id="test" style="margin-top:.8rem">Send a test notification</button>
    <button class="secondary" id="disable">Turn off on this device</button>
    <p class="hint" id="hint"></p>
  </div>

  <div class="card" id="messagesCard" hidden>
    <h2>Recent</h2>
    <div id="messages"></div>
  </div>

<script>
const VAPID_PUBLIC_KEY = ${JSON.stringify(env.VAPID_PUBLIC_KEY ?? "").replace(/</g, "\\u003c")};
const el = id => document.getElementById(id);
// Set when the server turns the saved token down, so the input comes back
// rather than leaving a wrong token with no way to correct it.
let tokenRejected = false;
const store = {
  get token() { try { return localStorage.getItem("popcorn-pager-token") || ""; } catch { return ""; } },
  set token(v) { try { localStorage.setItem("popcorn-pager-token", v); } catch {} },
};

// A one-time link can carry the token so it never has to be typed on a phone.
if (location.hash.startsWith("#token=")) {
  store.token = decodeURIComponent(location.hash.slice(7));
  history.replaceState(null, "", location.pathname);
}

const standalone = window.matchMedia("(display-mode: standalone)").matches
  || window.navigator.standalone === true;
const isApple = /iPhone|iPad|iPod/.test(navigator.userAgent);
const canPush = "serviceWorker" in navigator && "PushManager" in window;

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: "Bearer " + store.token },
  });
}

function setDot(id, state) { el(id).className = "dot " + state; }

async function render() {
  const needsInstall = isApple && !standalone;
  el("install").hidden = !needsInstall;
  el("copyToken").hidden = !store.token;
  el("copyHint").hidden = !store.token;
  el("tokenCard").hidden = Boolean(store.token) && !tokenRejected;
  el("statusCard").hidden = !store.token;
  el("messagesCard").hidden = !store.token;

  setDot("dotHome", needsInstall ? "off" : "on");
  el("valHome").textContent = needsInstall ? "not yet" : (standalone ? "yes" : "not needed here");

  const permission = canPush ? Notification.permission : "unsupported";
  setDot("dotPerm", permission === "granted" ? "on" : permission === "denied" ? "off" : "wait");
  el("valPerm").textContent = permission;

  let subscription = null;
  if (canPush) {
    const registration = await navigator.serviceWorker.getRegistration("/");
    subscription = registration ? await registration.pushManager.getSubscription() : null;
  }
  setDot("dotSub", subscription ? "on" : "off");
  el("valSub").textContent = subscription ? "active" : "none";

  const ready = Boolean(store.token) && !needsInstall && canPush;
  el("enableCard").hidden = !ready || Boolean(subscription) || permission === "denied";
  el("test").hidden = !subscription;
  el("disable").hidden = !subscription;

  if (permission === "denied") {
    el("hint").textContent = "Notifications are blocked. Turn them back on in Settings, then reload.";
  } else if (!canPush) {
    el("hint").textContent = "This browser has no push support.";
  } else {
    el("hint").textContent = "";
  }

  if (store.token) loadMessages();
}

function urlBase64ToUint8Array(value) {
  const padded = (value + "=".repeat((4 - value.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

async function enable() {
  el("enable").disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return render();

    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    const res = await api("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    });
    if (!res.ok) throw new Error("server rejected the subscription: " + res.status);
    el("hint").textContent = "Ready. Try the test button.";
  } catch (err) {
    el("hint").textContent = String(err && err.message ? err.message : err);
  } finally {
    el("enable").disabled = false;
    render();
  }
}

async function disable() {
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = registration && await registration.pushManager.getSubscription();
  if (subscription) {
    await api("/api/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
  }
  render();
}

async function sendTest() {
  el("test").disabled = true;
  const res = await api("/api/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "\\u{1F37F} Test notification",
      body: "\\u{1F6BD} Best break: 70 minutes in, when the snow appears\\n\\u{1F3AC} Post-credits scene",
    }),
  });
  el("hint").textContent = res.ok ? "Sent. It should arrive in a second." : "Failed: " + res.status;
  el("test").disabled = false;
}

async function loadMessages() {
  try {
    const res = await api("/api/notifications");
    if (!res.ok) {
      if (res.status === 401 && !tokenRejected) {
        tokenRejected = true;
        el("messages").textContent = "That token was not accepted. Try another.";
        return render();
      }
      el("messages").textContent = res.status === 401 ? "That token was not accepted." : "";
      return;
    }
    tokenRejected = false;
    const { notifications } = await res.json();
    el("messages").innerHTML = notifications.map(n =>
      '<div class="msg"><h3>' + esc(n.title) + "</h3><pre>" + esc(n.body || "")
        + "</pre><time>" + new Date(n.time * 1000).toLocaleString() + "</time></div>"
    ).join("") || "<p>Nothing yet. Buy a cinema ticket.</p>";
  } catch (err) {
    el("messages").textContent = String(err);
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

el("saveToken").addEventListener("click", () => {
  store.token = el("token").value.trim();
  tokenRejected = false;
  render();
});
el("copyToken").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(store.token);
    el("copyHint").textContent = "Copied. Paste it into the app on your home screen.";
  } catch {
    el("copyHint").textContent = "Could not copy. Select the token from wherever you saved it.";
  }
});
el("enable").addEventListener("click", enable);
el("disable").addEventListener("click", disable);
el("test").addEventListener("click", sendTest);
render();
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

export function manifestResponse(): Response {
  return new Response(
    JSON.stringify({
      name: "PopcornPager",
      short_name: "PopcornPager",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#101218",
      theme_color: "#101218",
      icons: [{ src: "/icon.png", sizes: "180x180", type: "image/png", purpose: "any" }],
    }),
    { headers: { "Content-Type": "application/manifest+json" } },
  );
}

/**
 * The service worker. It only has to turn an encrypted push into a visible
 * notification; everything it needs is already inside the payload, so it never
 * has to ask the server what the notification says.
 */
export function serviceWorkerResponse(): Response {
  const js = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "PopcornPager", body: event.data ? event.data.text() : "" };
  }

  // Kept to the options every browser supports. An option WebKit dislikes would
  // cost the entire notification, and a notification that never appears is the
  // hardest kind of failure to notice.
  const options = {
    body: String(data.body || ""),
    icon: "/icon.png",
    // Tagging by id means a redelivery replaces rather than repeats.
    // renotify keeps a replacement from arriving silently.
    tag: String(data.id || Date.now()),
    renotify: true,
    data: { click: data.click || "/" },
  };

  event.waitUntil(
    self.registration
      .showNotification(String(data.title || "PopcornPager"), options)
      .catch(() =>
        // Last resort: something about the options was rejected, so show the
        // plainest possible notification rather than none.
        self.registration.showNotification(String(data.title || "PopcornPager"), {
          body: String(data.body || ""),
        })
      )
      .then(() => acknowledge(data, true))
      .catch(() => acknowledge(data, false))
  );
});

/**
 * Tells the server this notification actually appeared. Without it, a push that
 * the push service accepted and the phone silently dropped looks exactly like a
 * successful delivery.
 */
async function acknowledge(data, shown) {
  if (!data || !data.ack || !data.id) return;
  try {
    const subscription = await self.registration.pushManager.getSubscription();
    if (!subscription) return;
    await fetch("/api/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        id: data.id,
        ack: data.ack,
        shown: shown,
      }),
    });
  } catch (err) {
    // Reporting is best effort; never let it break the notification itself.
  }
}

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.click) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      // Focusing an open window is not enough on its own: it would ignore where
      // the notification actually points. Navigate it, then bring it forward.
      for (const client of clients) {
        if ("navigate" in client) return client.navigate(target).then(c => (c || client).focus());
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
`;
  return new Response(js, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
      "Cache-Control": "no-cache",
    },
  });
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
