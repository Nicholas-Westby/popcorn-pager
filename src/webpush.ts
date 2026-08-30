import type { Env, Notification, PushSubscriptionRecord } from "./types";

/**
 * Web Push, implemented directly against the RFCs so that a notification can go
 * from this Worker to the phone with nothing in between:
 *
 *   RFC 8291  message encryption (ECDH + HKDF + AES-128-GCM)
 *   RFC 8188  the aes128gcm content coding that wraps it
 *   RFC 8292  VAPID, which is how the push service knows who we are
 *
 * The push service (Apple's, for an iPhone) only ever sees ciphertext. It
 * cannot read the title or the message.
 */

const RECORD_SIZE = 4096;
/** Payload cap. Apple rejects anything larger. */
const MAX_PAYLOAD_BYTES = 3800;
const JWT_LIFETIME_SECONDS = 12 * 60 * 60;
/** Re-sign a little before expiry so a cached token is never used past it. */
const JWT_REFRESH_MARGIN_SECONDS = 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;

/**
 * Reasons that mean this particular subscription is dead and will never work
 * again. Apple returns 400 for these rather than the 410 the spec suggests.
 *
 * Everything else is left alone on purpose. A 403 is a problem with our own
 * VAPID configuration and fails for every device at once, so pruning on it
 * would unsubscribe the whole phone fleet over one bad setting.
 */
const DEAD_SUBSCRIPTION_REASONS = new Set([
  "BadDeviceToken",
  "BadWebPushToken",
  "MissingDeviceToken",
  "Unregistered",
  // Returned after a VAPID key rotation; the old subscription cannot be revived.
  "VapidPkHashMismatch",
]);

export interface PushResult {
  endpoint: string;
  ok: boolean;
  status?: number;
  error?: string;
  /** The push service's machine-readable reason, when it gave one. */
  reason?: string;
  /** The push service's own id for the accepted push, for tracing. */
  id?: string;
  /** The subscription is dead and should be forgotten. */
  gone?: boolean;
}

/**
 * Apple serves its JSON error bodies as text/plain, so the content type says
 * nothing about whether there is a reason to read.
 */
function pushErrorReason(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

function isDeadSubscription(status: number, reason: string | undefined): boolean {
  if (status === 410) return true;
  if (status === 404) return true; // Mozilla's answer for an unknown endpoint
  if (status === 400 && reason) return DEAD_SUBSCRIPTION_REASONS.has(reason);
  return false;
}

export function webPushConfigured(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/**
 * Apple caps a push at 4 KB. Everything here is measured in encoded bytes, not
 * characters: a film title in Japanese is three bytes a character, and a
 * character budget would let a perfectly ordinary notification blow the limit
 * and throw during encryption, which loses the notification entirely.
 */
const MAX_TITLE_BYTES = 400;
const MAX_BODY_BYTES = 2000;

/**
 * What the service worker receives. Both halves are trimmed rather than allowed
 * to push the payload over the limit, because a shortened notification is still
 * a notification and the full text is one tap away in the app.
 *
 * `ack` lets the worker prove it displayed the notification. It rides inside
 * the encrypted payload, so only the real subscriber can produce it, and the
 * server can re-derive it without storing anything.
 */
export async function notificationPayload(
  env: Env,
  notification: Notification,
  endpoint: string,
): Promise<string> {
  const fixed = {
    id: notification.id,
    title: truncateBytes(notification.title, MAX_TITLE_BYTES),
    click: notification.click,
    time: notification.time,
    ack: await ackToken(env, endpoint, notification.id),
  };

  // JSON escaping expands some characters, so the only reliable way to land
  // under the cap is to encode and measure. Two passes is the normal case.
  let body = truncateBytes(notification.body, MAX_BODY_BYTES);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const payload = JSON.stringify({ ...fixed, body });
    const over = byteLength(payload) - MAX_PAYLOAD_BYTES;
    if (over <= 0) return payload;
    if (body === "") break;
    body = truncateBytes(body, Math.max(0, byteLength(body) - over - 16));
  }

  return JSON.stringify({ ...fixed, body: "" });
}

const byteLength = (value: string) => new TextEncoder().encode(value).length;

/** Cuts to a byte budget without splitting a character in half. */
function truncateBytes(value: string, max: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= max) return value;
  if (max <= 3) return "";

  // Leave room for the ellipsis, then back up off any continuation byte so the
  // slice ends on a character boundary rather than decoding to U+FFFD.
  let end = max - 3;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${new TextDecoder().decode(bytes.slice(0, end))}\u2026`;
}

/**
 * Proof that a given subscription received a given notification. Derived rather
 * than stored, and worthless to anyone who cannot decrypt the push it came in.
 */
export async function ackToken(env: Env, endpoint: string, id: string): Promise<string> {
  // No fallback key. Substituting a constant would make every ack forgeable by
  // anyone holding an endpoint, and everything else here fails closed when
  // AUTH_TOKEN is missing.
  if (!env.AUTH_TOKEN) throw new Error("AUTH_TOKEN is not set");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.AUTH_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${endpoint}\n${id}`),
  );
  return base64UrlEncode(new Uint8Array(signature).slice(0, 12));
}

export async function sendPush(
  env: Env,
  subscription: PushSubscriptionRecord,
  payload: string,
): Promise<PushResult> {
  try {
    const body = await encryptPayload(payload, subscription.p256dh, subscription.auth);
    const authorization = await vapidAuthorization(env, subscription.endpoint);

    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "high",
      },
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });

    if (res.ok) {
      await res.body?.cancel();
      return {
        endpoint: subscription.endpoint,
        ok: true,
        status: res.status,
        // Apple returns this on every accepted push. It is the only handle on a
        // notification that was accepted but never appeared.
        id: res.headers.get("apns-id") ?? undefined,
      };
    }

    const detail = (await res.text().catch(() => "")).slice(0, 300);
    const reason = pushErrorReason(detail);
    return {
      endpoint: subscription.endpoint,
      ok: false,
      status: res.status,
      error: reason ? `${reason}: ${detail}` : detail,
      reason,
      gone: isDeadSubscription(res.status, reason),
    };
  } catch (err) {
    return { endpoint: subscription.endpoint, ok: false, error: String(err) };
  }
}

// --------------------------------------------------------------------------
// RFC 8291 encryption
// --------------------------------------------------------------------------

export async function encryptPayload(
  payload: string,
  clientPublicKeyB64: string,
  authSecretB64: string,
): Promise<ArrayBuffer> {
  const plaintext = new TextEncoder().encode(payload);
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload of ${plaintext.length} bytes exceeds the push size limit`);
  }

  const clientPublicRaw = base64UrlToBytes(clientPublicKeyB64);
  const authSecret = base64UrlToBytes(authSecretB64);

  // A fresh keypair per message, as the RFC requires.
  const serverKeys = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const serverPublicRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", serverKeys.publicKey)) as ArrayBuffer,
  );

  const clientPublicKey = await crypto.subtle.importKey(
    "raw",
    clientPublicRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // The Workers types call this `$public` because `public` is reserved in
      // their generator; the runtime reads `public`.
      { name: "ECDH", public: clientPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      serverKeys.privateKey,
      256,
    ),
  );

  // First HKDF: mix the ECDH secret with the subscription's auth secret, binding
  // the result to both public keys so it cannot be replayed against another one.
  const keyInfo = concat(
    new TextEncoder().encode("WebPush: info"),
    new Uint8Array([0]),
    clientPublicRaw,
    serverPublicRaw,
  );
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  // Second HKDF: the RFC 8188 content-encryption key and nonce.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, labelInfo("aes128gcm"), 16);
  const nonce = await hkdf(salt, ikm, labelInfo("nonce"), 12);

  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  // 0x02 marks the last (here, only) record.
  const record = concat(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, record),
  );

  // aes128gcm header: salt | record size | key id length | key id | ciphertext
  const header = new Uint8Array(16 + 4 + 1 + serverPublicRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = serverPublicRaw.length;
  header.set(serverPublicRaw, 21);

  return concat(header, ciphertext).buffer as ArrayBuffer;
}

function labelInfo(label: string): Uint8Array {
  return new TextEncoder().encode(`Content-Encoding: ${label}\0`);
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

// --------------------------------------------------------------------------
// RFC 8292 VAPID
// --------------------------------------------------------------------------

/**
 * One signed token per push service, reused until it is close to expiring.
 * Apple asks callers not to re-sign more than once an hour, and there is no
 * reason to: the token says nothing about the message.
 */
const jwtCache = new Map<string, { token: string; expires: number }>();

export async function vapidAuthorization(env: Env, endpoint: string): Promise<string> {
  const audience = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);

  // Keyed by the signing key as well, so a rotation cannot pair an old
  // signature with the new `k=` and fail with an unprunable 403.
  const cacheKey = `${audience}\n${env.VAPID_PUBLIC_KEY}`;
  const cached = jwtCache.get(cacheKey);
  if (cached && cached.expires - now > JWT_REFRESH_MARGIN_SECONDS) {
    return `vapid t=${cached.token}, k=${env.VAPID_PUBLIC_KEY}`;
  }

  const header = { typ: "JWT", alg: "ES256" };
  const expires = now + JWT_LIFETIME_SECONDS;
  const claims = {
    aud: audience,
    exp: expires,
    // Apple rejects this outright unless the host has a dot in it, the scheme is
    // lowercase, and there is no whitespace. The failure is an opaque 403 that
    // names no claim, so it is worth being careful here.
    sub: env.VAPID_SUBJECT || "mailto:admin@example.com",
  };

  const signingInput = `${base64UrlEncode(jsonBytes(header))}.${base64UrlEncode(jsonBytes(claims))}`;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    base64UrlToBytes(env.VAPID_PRIVATE_KEY!),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto emits the raw r||s pair, which is exactly what JWS ES256 wants.
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );

  const token = `${signingInput}.${base64UrlEncode(signature)}`;
  jwtCache.set(cacheKey, { token, expires });
  return `vapid t=${token}, k=${env.VAPID_PUBLIC_KEY}`;
}

/** Test seam: the cache is per isolate and otherwise invisible. */
export function clearVapidCache(): void {
  jwtCache.clear();
}

/**
 * Asks the push service to validate our VAPID setup, using a device token that
 * cannot exist. The token is checked after the signature, so a complaint about
 * the token means the signature, subject, audience and key were all accepted.
 * This is the one way to tell a broken configuration from a dead subscription
 * without waiting for a real notification to go missing.
 */
/** What the push service says about a device token that cannot exist. */
const EXPECTED_PREFLIGHT_REASONS = new Set([
  "BadDeviceToken",
  "BadWebPushToken",
  "MissingDeviceToken",
  "Unregistered",
]);

export async function checkVapid(env: Env): Promise<Record<string, unknown>> {
  if (!webPushConfigured(env)) return { configured: false };

  const endpoint = `https://web.push.apple.com/${"A".repeat(64)}`;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(env, endpoint),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
      },
      body: new Uint8Array(120),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });

    const reason = pushErrorReason((await res.text().catch(() => "")).slice(0, 300));
    return {
      configured: true,
      subject: env.VAPID_SUBJECT,
      status: res.status,
      reason,
      // Only a complaint about the made-up device token proves the signature,
      // subject, audience and key were all accepted. Anything else, a 401 or a
      // 5xx included, is not evidence of a working configuration.
      accepted: EXPECTED_PREFLIGHT_REASONS.has(reason ?? ""),
      detail:
        res.status === 403
          ? "the push service rejected our VAPID token; check VAPID_SUBJECT"
          : EXPECTED_PREFLIGHT_REASONS.has(reason ?? "")
            ? "the push service accepted our VAPID token"
            : "the push service answered something unexpected; treat as unproven",
    };
  } catch (err) {
    return { configured: true, error: String(err) };
  }
}

// --------------------------------------------------------------------------

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
