import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ackToken, base64UrlEncode, notificationPayload } from "../src/webpush";
import { TOKEN, clearNotifications } from "./helpers";

const BASE = "https://popcorn-pager.example.workers.dev";

/** A subscription shaped exactly like the one a browser hands back. */
async function browserSubscription(endpoint = "https://web.push.apple.com/test-endpoint") {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  return {
    endpoint,
    keys: {
      p256dh: base64UrlEncode(raw),
      auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

async function call(path: string, init: RequestInit = {}, testEnv: unknown = env): Promise<Response> {
  const request = new Request(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) },
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, testEnv as never);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Same as call(), but without the Authorization header. */
async function open(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env as never);
  await waitOnExecutionContext(ctx);
  return res;
}

const sendNotification = (body = "Dune at 7:30", title = "Tickets", testEnv: unknown = env) =>
  call("/api/notify", { method: "POST", body: JSON.stringify({ title, body }) }, testEnv);

const subscribe = async (subscription: unknown) =>
  call("/api/subscribe", { method: "POST", body: JSON.stringify(subscription) });

/** Captures pushes to the push service instead of sending them. */
function capturePush(status = 201) {
  const calls: { url: string; headers: Headers; bytes: Uint8Array }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as RequestInfo, init);
      calls.push({
        url: request.url,
        headers: request.headers,
        bytes: new Uint8Array(await request.arrayBuffer()),
      });
      return new Response(null, { status });
    }),
  );
  return calls;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM push_subscriptions").run();
  await clearNotifications();
});
afterEach(() => vi.unstubAllGlobals());

describe("the web app", () => {
  it("serves the page, worker, manifest and icon without a token", async () => {
    const expectations: [string, string][] = [
      ["/", "text/html"],
      ["/sw.js", "text/javascript"],
      ["/manifest.webmanifest", "application/manifest+json"],
      ["/icon.png", "image/png"],
    ];
    for (const [path, type] of expectations) {
      const res = await open(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain(type);
    }
  });

  it("gives the page the public VAPID key and nothing secret", async () => {
    const html = await (await open("/")).text();
    expect(html).toContain(env.VAPID_PUBLIC_KEY!);
    expect(html).not.toContain(env.VAPID_PRIVATE_KEY!);
    expect(html).not.toContain(TOKEN);
  });

  it("scopes the service worker to the whole origin so it controls the app", async () => {
    const res = await open("/sw.js");
    expect(res.headers.get("Service-Worker-Allowed")).toBe("/");
    const js = await res.text();
    expect(js).toContain('addEventListener("push"');
    expect(js).toContain("showNotification");
  });

  it("serves the manifest with a root scope, matching the service worker", async () => {
    // A scope mismatch means the home screen app is not the one holding the
    // push subscription, and notifications go nowhere with no error.
    const manifest = await (await open("/manifest.webmanifest")).json<{
      scope: string;
      start_url: string;
    }>();
    expect(manifest.scope).toBe("/");
    expect(manifest.start_url).toBe("/");
  });
});

describe("push subscriptions", () => {
  it("requires a token to subscribe", async () => {
    const res = await open("/api/subscribe", {
      method: "POST",
      body: JSON.stringify(await browserSubscription()),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a subscription with no keys", async () => {
    const res = await subscribe({ endpoint: "https://web.push.apple.com/x" });
    expect(res.status).toBe(400);
  });

  it("stores a subscription and pushes to it, as ciphertext", async () => {
    const subscription = await browserSubscription();
    expect((await subscribe(subscription)).status).toBe(200);

    const calls = capturePush();
    const res = await sendNotification();

    expect(res.headers.get("X-Push")).toBe("ok:1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(subscription.endpoint);
    expect(calls[0]!.headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(calls[0]!.headers.get("Authorization")).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    expect(calls[0]!.headers.get("TTL")).toBe("86400");

    // The push service only ever sees ciphertext, so nothing readable is in it.
    const asText = new TextDecoder().decode(calls[0]!.bytes);
    expect(asText).not.toContain("Dune");
    expect(asText).not.toContain("Tickets");
    expect(calls[0]!.bytes.length).toBeGreaterThan(86); // header plus a GCM tag
  });

  it("forgets a subscription the push service says is gone", async () => {
    await subscribe(await browserSubscription());

    capturePush(410);
    const res = await sendNotification();
    expect(res.headers.get("X-Push")).toBe("failed:1");

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("keeps a subscription when the push merely fails", async () => {
    await subscribe(await browserSubscription());

    capturePush(500);
    await sendNotification();

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it("unsubscribes on request", async () => {
    const subscription = await browserSubscription();
    await subscribe(subscription);
    expect(
      (await call("/api/subscribe", {
        method: "DELETE",
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      })).status,
    ).toBe(200);

    const calls = capturePush();
    const res = await sendNotification();
    expect(res.headers.get("X-Push")).toBe("no-subscribers");
    expect(calls).toHaveLength(0);
  });

  it("pushes to every subscribed phone", async () => {
    await subscribe(await browserSubscription("https://web.push.apple.com/one"));
    await subscribe(await browserSubscription("https://web.push.apple.com/two"));

    const calls = capturePush();
    const res = await sendNotification();

    expect(res.headers.get("X-Push")).toBe("ok:2");
    expect(calls.map(c => c.url).sort()).toEqual([
      "https://web.push.apple.com/one",
      "https://web.push.apple.com/two",
    ]);
  });

  it("reports unconfigured when there are no VAPID keys", async () => {
    const res = await sendNotification("x", "y", {
      ...env,
      VAPID_PUBLIC_KEY: "",
      VAPID_PRIVATE_KEY: "",
    });
    expect(res.headers.get("X-Push")).toBe("unconfigured");
  });
});

describe("stored notifications", () => {
  it("stores the notification even when no phone could be reached", async () => {
    // The push is the fast path, not the record. A dropped push is recoverable
    // because the app reads these rows the next time it opens.
    const res = await sendNotification("Dune at 7:30", "Tickets");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Push")).toBe("no-subscribers");

    const { notifications } = await (await call("/api/notifications")).json<{
      notifications: { title: string; body: string }[];
    }>();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ title: "Tickets", body: "Dune at 7:30" });
  });

  it("returns the newest notification first", async () => {
    await sendNotification("first", "One");
    await sendNotification("second", "Two");

    const { notifications } = await (await call("/api/notifications")).json<{
      notifications: { title: string }[];
    }>();
    expect(notifications.map(n => n.title)).toEqual(["Two", "One"]);
  });

  it("refuses a notification with nothing in it", async () => {
    const res = await call("/api/notify", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });
});

describe("delivery acknowledgement", () => {
  // "The push service accepted it" and "the phone showed it" look identical
  // from the server: Apple answers 201 Created for a dead subscription too.
  // The service worker reports back to tell them apart.
  async function subscribed() {
    const subscription = await browserSubscription();
    await subscribe(subscription);
    return subscription;
  }

  it("accepts an ack derived from the encrypted payload", async () => {
    const subscription = await subscribed();
    const id = "aaaaaaaaaaaa";

    const res = await open("/api/ack", {
      method: "POST",
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        id,
        ack: await ackToken(env, subscription.endpoint, id),
        shown: true,
      }),
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT last_ok FROM push_subscriptions WHERE endpoint = ?")
      .bind(subscription.endpoint)
      .first<{ last_ok: number }>();
    expect(row?.last_ok).toBeGreaterThan(0);
  });

  it("rejects an ack that was not derived from a real push", async () => {
    const subscription = await subscribed();
    const res = await open("/api/ack", {
      method: "POST",
      body: JSON.stringify({ endpoint: subscription.endpoint, id: "aaaaaaaaaaaa", ack: "forged" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects an ack meant for a different notification", async () => {
    const subscription = await subscribed();
    const res = await open("/api/ack", {
      method: "POST",
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        id: "bbbbbbbbbbbb",
        ack: await ackToken(env, subscription.endpoint, "aaaaaaaaaaaa"),
      }),
    });
    expect(res.status).toBe(404);
  });

  it("puts a usable ack inside the encrypted payload", async () => {
    const endpoint = "https://web.push.apple.com/whoever";
    const payload = JSON.parse(
      await notificationPayload(
        env,
        { id: "cccccccccccc", time: 1, title: "t", body: "m" },
        endpoint,
      ),
    );
    expect(payload.ack).toBe(await ackToken(env, endpoint, "cccccccccccc"));
    // A different subscriber cannot produce it.
    expect(payload.ack).not.toBe(
      await ackToken(env, "https://web.push.apple.com/other", "cccccccccccc"),
    );
  });
});

describe("what the browser is served actually parses", () => {
  // Both are template literals with escaped sequences that TypeScript never
  // checks. A syntax error in either ships as "notifications just stopped".
  it("serves a service worker that is valid JavaScript", async () => {
    const js = await (await open("/sw.js")).text();
    expect(() => new Function(js)).not.toThrow();
  });

  it("serves a page whose inline script is valid JavaScript", async () => {
    const html = await (await open("/")).text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });
});

describe("an acknowledgement that the phone could not display", () => {
  it("is not recorded as a delivery", async () => {
    // This is the one case the ack exists to catch. Recording it as a success
    // would make the whole mechanism inert exactly when it matters.
    const subscription = await browserSubscription();
    await subscribe(subscription);
    const id = "dddddddddddd";

    const res = await open("/api/ack", {
      method: "POST",
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        id,
        ack: await ackToken(env, subscription.endpoint, id),
        shown: false,
      }),
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT last_ok, last_error FROM push_subscriptions WHERE endpoint = ?",
    )
      .bind(subscription.endpoint)
      .first<{ last_ok: number | null; last_error: string | null }>();
    expect(row?.last_ok).toBeNull();
    expect(row?.last_error).toContain("not shown");
  });
});
