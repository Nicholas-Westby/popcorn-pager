import { allSubscriptions, deleteSubscription } from "./pushstore";
import { insertNotification } from "./store";
import type { Env, Notification } from "./types";
import { nowSeconds, randomId } from "./util";
import { notificationPayload, sendPush, webPushConfigured } from "./webpush";

const DEFAULT_TTL_HOURS = 720;

export interface NotifyResult {
  notification: Notification;
  /** How many phones the push service accepted the notification for. */
  delivered: number;
  attempted: number;
  /** `unconfigured` and `no-subscribers` are the two ways this quietly does nothing. */
  status: "ok" | "unconfigured" | "no-subscribers" | "failed";
}

/**
 * Store a notification and push it to every phone that has subscribed.
 *
 * Storing comes first and never depends on the push succeeding. A push that
 * does not arrive is recoverable, because the app reads the same rows when it
 * next opens; a notification that was never written is simply gone.
 */
export async function notify(
  env: Env,
  input: { title: string; body: string; click?: string },
): Promise<NotifyResult> {
  const notification: Notification = {
    id: randomId(),
    time: nowSeconds(),
    title: input.title,
    body: input.body,
    ...(input.click ? { click: input.click } : {}),
  };

  await insertNotification(env.DB, notification, ttlSeconds(env));

  // The notification text is deliberately not logged: log lines leave the
  // Worker for Cloudflare's log pipeline, and the research lines are the whole
  // private payload. The film title is logged in the agent, because debugging
  // "did it research the right film" is impossible without it.
  console.log({
    event: "notification_stored",
    id: notification.id,
    bytes: notification.body.length,
  });

  const push = await deliver(env, notification);
  return { notification, ...push };
}

async function deliver(
  env: Env,
  notification: Notification,
): Promise<Omit<NotifyResult, "notification">> {
  if (!webPushConfigured(env)) {
    console.warn({ event: "push_skipped", reason: "VAPID keys are not set" });
    return { delivered: 0, attempted: 0, status: "unconfigured" };
  }

  const subscriptions = await allSubscriptions(env.DB);
  if (subscriptions.length === 0) {
    console.warn({ event: "push_skipped", reason: "no phone has subscribed" });
    return { delivered: 0, attempted: 0, status: "no-subscribers" };
  }

  const results = await Promise.all(
    subscriptions.map(async sub =>
      sendPush(env, sub, await notificationPayload(env, notification, sub.endpoint)),
    ),
  );

  let delivered = 0;
  for (const result of results) {
    if (result.ok) {
      delivered += 1;
      console.log({
        event: "web_push_accepted",
        id: notification.id,
        status: result.status,
        push_id: result.id,
      });
      continue;
    }
    console.warn({
      event: "web_push_failed",
      endpoint: result.endpoint.slice(0, 60),
      status: result.status,
      reason: result.reason,
      error: result.error,
      gone: result.gone,
    });
    // A subscription the push service reports as gone is deleted, because the
    // browser will have made a new one. Nothing is pruned on a 403, which is
    // what a wrong VAPID setting looks like and would otherwise unsubscribe
    // every phone at once.
    if (result.gone) await deleteSubscription(env.DB, result.endpoint);
  }

  console.log({
    event: "web_push",
    id: notification.id,
    delivered,
    attempted: results.length,
  });

  return {
    delivered,
    attempted: results.length,
    status: delivered > 0 ? "ok" : "failed",
  };
}

export function ttlSeconds(env: Env): number {
  const hours = Number(env.NOTIFICATION_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS) * 3600;
}

/** Compact summary of what happened to a push, for the X-Push response header. */
export function pushHeader(result: NotifyResult): string {
  if (result.status === "ok") return `ok:${result.delivered}`;
  if (result.status === "failed") return `failed:${result.attempted}`;
  return result.status;
}
