export interface Env {
  DB: D1Database;
  /** Workers AI, used to read the booking out of the email. */
  AI: Ai;

  /** How long a notification is kept before the cleanup cron deletes it. */
  NOTIFICATION_TTL_HOURS: string;

  /** Shared secret. Everything except the app shell and the ack needs it. */
  AUTH_TOKEN: string;

  /**
   * VAPID keypair for Web Push. The public half is meant to be public: the
   * browser needs it to create a subscription. Without the private half, Web
   * Push is off and nothing can reach a phone.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** Contact address VAPID requires in the JWT's `sub` claim. */
  VAPID_SUBJECT?: string;
}

/**
 * One notification, as stored and as sent. This is the whole wire format: there
 * is exactly one producer (the email handler) and one consumer (the phone), so
 * it stays small deliberately.
 */
export interface Notification {
  id: string;
  /** Unix seconds. */
  time: number;
  title: string;
  body: string;
  /** URL opened when the notification is tapped. */
  click?: string;
}

/** A browser that has granted notification permission and can be pushed to. */
export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
  created: number;
}

/** What the extraction model is asked to pull out of the email. */
export interface Booking {
  movie: string;
  format?: string;
  runtimeMinutes?: number;
  date?: string;
  time?: string;
  theater?: string;
  address?: string;
  seats?: string;
}
