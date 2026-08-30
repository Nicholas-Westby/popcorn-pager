-- PopcornPager storage.
--
-- Two tables and no more. One holds the notifications that have been sent, so
-- the app can show you what it already told you. The other holds the phones
-- that have agreed to be pushed to.

CREATE TABLE IF NOT EXISTS notifications (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id      TEXT    NOT NULL UNIQUE,
  time    INTEGER NOT NULL,  -- unix seconds
  expires INTEGER NOT NULL,  -- unix seconds; the hourly cron deletes past this
  title   TEXT    NOT NULL,
  body    TEXT    NOT NULL,
  click   TEXT               -- opened when the notification is tapped
);

CREATE INDEX IF NOT EXISTS idx_notifications_expires ON notifications (expires);

-- One row per browser that has granted notification permission. iOS only allows
-- this once the page has been added to the home screen.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,  -- e.g. https://web.push.apple.com/...
  p256dh     TEXT NOT NULL,     -- base64url of the browser's public key
  auth       TEXT NOT NULL,     -- base64url of the browser's auth secret
  created    INTEGER NOT NULL,
  last_ok    INTEGER,           -- last confirmed display, set by the ack
  last_error TEXT
);
