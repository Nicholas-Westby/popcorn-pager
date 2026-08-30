import { handleTicketEmail } from "./agent";
import { appPage, manifestResponse, serviceWorkerResponse } from "./app";
import { requireAuth } from "./auth";
import { ApiError, errBadRequest, errNotFound } from "./errors";
import { jsonResponse, preflightResponse, withCors } from "./http";
import { iconResponse } from "./icon";
import { notify, pushHeader, ttlSeconds } from "./notify";
import {
  countSubscriptions,
  deleteSubscription,
  recordDelivery,
  saveSubscription,
} from "./pushstore";
import { researchFilm } from "./research";
import { deleteExpired, recentNotifications } from "./store";
import type { Env } from "./types";
import { secureEquals } from "./util";
import { ackToken, checkVapid, webPushConfigured } from "./webpush";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof ApiError) {
        // Rejections are otherwise invisible: the caller just sees a 4xx and
        // nothing reaches the phone. Log enough to find it with `wrangler tail`.
        console.warn({
          event: "rejected",
          http: err.http,
          error: err.text,
          method: request.method,
          path: new URL(request.url).pathname,
        });
        return withCors(err.toResponse());
      }
      console.error({
        event: "unhandled_error",
        error: String(err),
        stack: (err as Error)?.stack,
      });
      return withCors(jsonResponse({ error: "internal server error" }, 500));
    }
  },

  /**
   * Cloudflare Email Routing delivers here. Everything is caught, because an
   * error thrown out of this handler bounces the email and the booking is lost.
   */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleTicketEmail(message, env);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const deleted = await deleteExpired(env.DB);
    console.log({ event: "cleanup", deleted });
  },
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const readOnly = request.method === "GET" || request.method === "HEAD";

  if (request.method === "OPTIONS") return preflightResponse();

  // The app shell loads before there is any token to send, so it is open.
  // Everything it then calls is not.
  if (readOnly) {
    if (path === "/") return withCors(appPage(env, url.origin));
    if (path === "/sw.js") return serviceWorkerResponse();
    if (path === "/manifest.webmanifest") return withCors(manifestResponse());
    if (path === "/icon.png") return iconResponse();
    // HEAD as well as GET, because that is what uptime monitors tend to send.
    if (path === "/health") return withCors(jsonResponse({ ok: true }));
  }

  // The service worker reports back here and has no token. The ack it presents
  // is the credential, and it only ever came out of an encrypted push.
  if (path === "/api/ack") return pushAck(request, env);

  requireAuth(request, env);

  if (path === "/api/subscribe") return subscribeRoute(request, env);

  if (path === "/api/notifications" && request.method === "GET") {
    return withCors(jsonResponse({ notifications: await recentNotifications(env.DB) }));
  }

  if (path === "/api/notify" && request.method === "POST") return notifyRoute(request, env);

  if (path === "/api/debug" && readOnly) return debugResponse(url, env);

  throw errNotFound();
}

/** Send a notification. The app's test button and anything external use this. */
async function notifyRoute(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
    body?: unknown;
    click?: unknown;
  } | null;

  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (!title && !text) throw errBadRequest("title or body is required");

  const result = await notify(env, {
    title: title || "PopcornPager",
    body: text,
    ...(typeof body?.click === "string" ? { click: body.click } : {}),
  });

  // Publishing succeeds even when no push went out, because the notification is
  // stored either way. The header is how a caller finds out that delivery is
  // quietly not happening.
  const response = withCors(jsonResponse(result.notification));
  response.headers.set("X-Push", pushHeader(result));
  return response;
}

async function subscribeRoute(request: Request, env: Env): Promise<Response> {
  if (request.method === "POST") {
    const body = (await request.json().catch(() => null)) as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    } | null;

    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : undefined;
    const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : undefined;
    const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : undefined;
    if (!endpoint || !p256dh || !auth) throw errBadRequest("endpoint and keys are required");

    await saveSubscription(env.DB, { endpoint, p256dh, auth });
    console.log({ event: "push_subscribed", endpoint: endpoint.slice(0, 60) });
    return withCors(jsonResponse({ ok: true }));
  }

  if (request.method === "DELETE") {
    const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
    if (typeof body?.endpoint !== "string") throw errBadRequest("endpoint is required");
    await deleteSubscription(env.DB, body.endpoint);
    return withCors(jsonResponse({ ok: true }));
  }

  throw errNotFound();
}

/**
 * The service worker calls this once it has actually shown a notification. It
 * is the only way to tell "the push service accepted it" from "the phone showed
 * it", which otherwise look identical from here: Apple answers 201 Created even
 * for a subscription that no longer works.
 */
async function pushAck(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") throw errNotFound();

  const body = (await request.json().catch(() => null)) as {
    endpoint?: unknown;
    id?: unknown;
    ack?: unknown;
    shown?: unknown;
  } | null;

  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : undefined;
  const id = typeof body?.id === "string" ? body.id : undefined;
  const ack = typeof body?.ack === "string" ? body.ack : undefined;
  if (!endpoint || !id || !ack) throw errNotFound();

  if (!secureEquals(ack, await ackToken(env, endpoint, id))) {
    console.warn({ event: "push_ack_rejected", id });
    throw errNotFound();
  }

  const shown = body?.shown !== false;
  console.log({ event: "push_shown", id, endpoint: endpoint.slice(0, 60), shown });

  // A worker that could not display the notification is the one case this
  // whole mechanism exists to catch, so it must not be recorded as a delivery.
  await recordDelivery(env.DB, endpoint, shown ? undefined : "delivered but not shown");
  return withCors(jsonResponse({ ok: true }));
}

/** One request that answers the questions asked when notifications stop. */
async function debugResponse(url: URL, env: Env): Promise<Response> {
  const film = url.searchParams.get("research");
  return withCors(
    jsonResponse({
      origin: url.origin,
      web_push_configured: webPushConfigured(env),
      web_push_subscribers: await countSubscriptions(env.DB),
      notification_ttl_hours: ttlSeconds(env) / 3600,
      // Both of these cost a live request to somebody, so they are opt in.
      // ?vapid=1 pre-flights the push service; ?research=<film> runs the real
      // research call and shows you the lines it would put on your phone.
      vapid: url.searchParams.get("vapid") === "1" ? await checkVapid(env) : undefined,
      research_lines: film ? await researchFilm(env, film) : undefined,
    }),
  );
}
