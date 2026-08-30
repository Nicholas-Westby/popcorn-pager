const ID_CHARSET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * A short opaque id per notification. The service worker uses it as the
 * notification tag so a re-delivered push replaces rather than duplicates, and
 * the ack signature is bound to it.
 */
export function randomId(length = 12): string {
  // Rejection sampling, so the alphabet stays uniform rather than favouring its
  // first 8 characters.
  const limit = 256 - (256 % ID_CHARSET.length);
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (out.length >= length) break;
      if (byte < limit) out += ID_CHARSET[byte % ID_CHARSET.length];
    }
  }
  return out;
}

/** Length-independent, constant-time-ish string comparison. */
export function secureEquals(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
