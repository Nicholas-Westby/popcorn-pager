import type { Notification } from "./types";
import { nowSeconds } from "./util";

/**
 * How many notifications the app shows. There is one of these per cinema trip,
 * so this is months of history and there is no reason to page.
 */
const RECENT_LIMIT = 50;

/** Deleting in batches, because D1 has a statement time limit. */
const DELETE_BATCH = 5000;
const MAX_DELETE_BATCHES = 20;

interface Row {
  id: string;
  time: number;
  title: string;
  body: string;
  click: string | null;
}

export async function insertNotification(
  db: D1Database,
  notification: Notification,
  ttlSeconds: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notifications (id, time, expires, title, body, click)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      notification.id,
      notification.time,
      notification.time + ttlSeconds,
      notification.title,
      notification.body,
      notification.click ?? null,
    )
    .run();
}

/** Most recent first, which is the order the app renders them in. */
export async function recentNotifications(db: D1Database): Promise<Notification[]> {
  const { results } = await db
    .prepare(
      `SELECT id, time, title, body, click FROM notifications
       ORDER BY seq DESC LIMIT ?`,
    )
    .bind(RECENT_LIMIT)
    .all<Row>();

  return results.map(rowToNotification);
}

export async function deleteExpired(db: D1Database): Promise<number> {
  const now = nowSeconds();
  let deleted = 0;

  for (let batch = 0; batch < MAX_DELETE_BATCHES; batch += 1) {
    const result = await db
      .prepare(
        `DELETE FROM notifications WHERE seq IN (
           SELECT seq FROM notifications WHERE expires <= ? LIMIT ?
         )`,
      )
      .bind(now, DELETE_BATCH)
      .run();

    const count = result.meta.changes ?? 0;
    deleted += count;
    if (count < DELETE_BATCH) break;
  }

  return deleted;
}

function rowToNotification(row: Row): Notification {
  const notification: Notification = {
    id: row.id,
    time: row.time,
    title: row.title,
    body: row.body,
  };
  if (row.click) notification.click = row.click;
  return notification;
}
