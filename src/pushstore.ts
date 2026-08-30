import type { PushSubscriptionRecord } from "./types";
import { nowSeconds } from "./util";

export async function saveSubscription(
  db: D1Database,
  subscription: { endpoint: string; p256dh: string; auth: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         last_error = NULL`,
    )
    .bind(subscription.endpoint, subscription.p256dh, subscription.auth, nowSeconds())
    .run();
}

export async function deleteSubscription(db: D1Database, endpoint: string): Promise<void> {
  await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
}

/** Every phone that has agreed to be notified. There is one feed, so no filtering. */
export async function allSubscriptions(db: D1Database): Promise<PushSubscriptionRecord[]> {
  const { results } = await db
    .prepare("SELECT endpoint, p256dh, auth, created FROM push_subscriptions")
    .all<PushSubscriptionRecord>();
  return results;
}

export async function countSubscriptions(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM push_subscriptions")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function recordDelivery(
  db: D1Database,
  endpoint: string,
  error?: string,
): Promise<void> {
  await db
    .prepare("UPDATE push_subscriptions SET last_ok = ?, last_error = ? WHERE endpoint = ?")
    .bind(error ? null : nowSeconds(), error ?? null, endpoint)
    .run();
}
