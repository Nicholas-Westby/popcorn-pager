import { describe, expect, it, vi } from "vitest";
import {
  base64UrlEncode,
  base64UrlToBytes,
  clearVapidCache,
  encryptPayload,
  vapidAuthorization,
} from "../src/webpush";

const VAPID_PUBLIC = "BLfKsuzbLWbLaE89llQQCIk0BmPOLPlbHMTxx2sbgUJJzq72WZ-GhkQduEKwUqKUfmHL4RD3GO9CVlZ8RtzT8uw";
const VAPID_PRIVATE =
  "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgo5ljEDhZo8dPqZWvvAXsmJTDbEzyMrmU7kVw2XCzbNmhRANCAAS3yrLs2y1my2hPPZZUEAiJNAZjziz5WxzE8cdrG4FCSc6u9lmfhoZEHbhCsFKilH5hy-EQ9xjvQlZWfEbc0_Ls";

/** Stands in for the browser: makes a subscription, then decrypts what we send it. */
async function makeClient() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer,
  );
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: keys.privateKey,
    publicRaw,
    p256dh: base64UrlEncode(publicRaw),
    auth: base64UrlEncode(authSecret),
    authSecret,
  };
}

/** The receiving half of RFC 8291, written independently of the sending half. */
async function decrypt(
  body: ArrayBuffer,
  client: Awaited<ReturnType<typeof makeClient>>,
): Promise<string> {
  const bytes = new Uint8Array(body);
  const salt = bytes.slice(0, 16);
  const recordSize = new DataView(bytes.buffer, bytes.byteOffset).getUint32(16, false);
  const keyIdLength = bytes[20]!;
  const serverPublicRaw = bytes.slice(21, 21 + keyIdLength);
  const ciphertext = bytes.slice(21 + keyIdLength);

  expect(recordSize).toBe(4096);
  expect(keyIdLength).toBe(65);

  const serverPublicKey = await crypto.subtle.importKey(
    "raw",
    serverPublicRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: serverPublicKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      client.privateKey,
      256,
    ),
  );

  const encoder = new TextEncoder();
  const keyInfo = new Uint8Array([
    ...encoder.encode("WebPush: info"),
    0,
    ...client.publicRaw,
    ...serverPublicRaw,
  ]);

  const hkdf = async (saltBytes: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) => {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: saltBytes, info },
        key,
        len * 8,
      ),
    );
  };

  const ikm = await hkdf(client.authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const record = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, ciphertext),
  );

  // The last byte is the record delimiter, 0x02 for the final record.
  expect(record[record.length - 1]).toBe(2);
  return new TextDecoder().decode(record.slice(0, -1));
}

describe("web push encryption", () => {
  it("produces something the receiving half of RFC 8291 can decrypt", async () => {
    const client = await makeClient();
    const payload = JSON.stringify({
      title: "Credit Scene + Bathroom Break for Dune",
      body: "Dune · 7:30 PM\nAMC Century City · F4, F5\n🎬 Post-credits scene",
    });

    const body = await encryptPayload(payload, client.p256dh, client.auth);
    expect(await decrypt(body, client)).toBe(payload);
  });

  it("uses a fresh key and salt for every message", async () => {
    const client = await makeClient();
    const first = new Uint8Array(await encryptPayload("same", client.p256dh, client.auth));
    const second = new Uint8Array(await encryptPayload("same", client.p256dh, client.auth));

    expect(first.slice(0, 16)).not.toEqual(second.slice(0, 16)); // salt
    expect(first.slice(21, 86)).not.toEqual(second.slice(21, 86)); // server public key
    expect(await decrypt(first.buffer as ArrayBuffer, client)).toBe("same");
    expect(await decrypt(second.buffer as ArrayBuffer, client)).toBe("same");
  });

  /**
   * The push limit is 4 KB of bytes, and a character budget does not enforce
   * it. A Japanese film title is three bytes a character and an emoji is four,
   * so a notification that looks short can still be twice the size of one that
   * fits, and going over throws during encryption rather than trimming.
   */
  const bytes = (value: string) => new TextEncoder().encode(value).length;

  const oversized: [string, { title: string; body: string }][] = [
    ["a long ASCII body", { title: "t", body: "x".repeat(5000) }],
    ["a body of emoji", { title: "t", body: "\u{1F37F}".repeat(1000) }],
    ["a body of CJK", { title: "t", body: "\u6620\u753B".repeat(1000) }],
    ["a very long title", { title: "T".repeat(4000), body: "short" }],
    ["a title of CJK", { title: "\u6620\u753B".repeat(600), body: "short" }],
    ["both halves oversized", { title: "\u{1F37F}".repeat(500), body: "\u6620".repeat(3000) }],
  ];

  for (const [name, notification] of oversized) {
    it(`trims ${name} instead of failing to notify at all`, async () => {
      const { notificationPayload } = await import("../src/webpush");
      const json = await notificationPayload(
        { AUTH_TOKEN: "tk_test" } as any,
        { id: "abcdefghijkl", time: 1, ...notification },
        "https://web.push.apple.com/x",
      );

      expect(bytes(json)).toBeLessThanOrEqual(3800);

      // Trimming has to leave something readable, and cutting to a byte budget
      // must not split a character into a replacement glyph.
      const payload = JSON.parse(json);
      expect(payload.title.length).toBeGreaterThan(0);
      expect(payload.title + payload.body).not.toContain("\uFFFD");

      const client = await makeClient();
      const encrypted = await encryptPayload(json, client.p256dh, client.auth);
      expect(encrypted.byteLength).toBeLessThan(4096);
    });
  }

  it("marks a trimmed value so it is obvious something was cut", async () => {
    const { notificationPayload } = await import("../src/webpush");
    const payload = JSON.parse(
      await notificationPayload(
        { AUTH_TOKEN: "tk_test" } as any,
        { id: "abcdefghijkl", time: 1, title: "t", body: "x".repeat(5000) },
        "https://web.push.apple.com/x",
      ),
    );
    expect(payload.body.endsWith("\u2026")).toBe(true);
    expect(bytes(payload.body)).toBeLessThanOrEqual(2000);
  });

  it("refuses to sign an ack when there is no token to key it with", async () => {
    // Falling back to a constant would make every ack forgeable.
    const { ackToken } = await import("../src/webpush");
    await expect(ackToken({} as any, "https://web.push.apple.com/x", "abcdefghijkl"))
      .rejects.toThrow(/AUTH_TOKEN/);
  });

  it("refuses a payload too large for the push service", async () => {
    const client = await makeClient();
    await expect(encryptPayload("x".repeat(4000), client.p256dh, client.auth)).rejects.toThrow(
      /exceeds the push size limit/,
    );
  });
});

describe("VAPID", () => {
  const env = {
    VAPID_PUBLIC_KEY: VAPID_PUBLIC,
    VAPID_PRIVATE_KEY: VAPID_PRIVATE,
    VAPID_SUBJECT: "mailto:w@example.com",
  } as any;

  it("signs a JWT the push service can verify with the advertised key", async () => {
    const header = await vapidAuthorization(env, "https://web.push.apple.com/abc/def?x=1");

    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, jwt, key] = match!;
    expect(key).toBe(VAPID_PUBLIC);

    const [headerB64, claimsB64, signatureB64] = jwt!.split(".");
    expect(JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerB64!)))).toEqual({
      typ: "JWT",
      alg: "ES256",
    });

    const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(claimsB64!)));
    // The audience is the push service's origin, never the full endpoint.
    expect(claims.aud).toBe("https://web.push.apple.com");
    expect(claims.sub).toBe("mailto:w@example.com");
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(claims.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 24 * 60 * 60);

    // ES256 signatures are the raw r||s pair, 64 bytes, not DER.
    const signature = base64UrlToBytes(signatureB64!);
    expect(signature.length).toBe(64);

    const publicKey = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(VAPID_PUBLIC),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      new TextEncoder().encode(`${headerB64}.${claimsB64}`),
    );
    expect(verified).toBe(true);
  });
});

describe("deciding a subscription is dead", () => {
  // Getting this wrong in either direction is expensive: prune too eagerly and
  // a misconfiguration silently unsubscribes every device; prune too little and
  // dead endpoints pile up forever.
  const cases: [number, string | undefined, boolean, string][] = [
    [410, undefined, true, "the standard gone response"],
    [404, undefined, true, "Mozilla's answer for an unknown endpoint"],
    [400, "BadDeviceToken", true, "Apple's answer for a dead subscription"],
    [400, "BadWebPushToken", true, "the web push spelling of the same thing"],
    [400, "VapidPkHashMismatch", true, "left over from a key rotation"],
    [400, "BadWebPushRequest", false, "our request was malformed, not their token"],
    [400, "PayloadTooLarge", false, "our payload, not their token"],
    [400, undefined, false, "an unexplained 400 is not proof of anything"],
    [403, "BadJwtToken", false, "our VAPID config is wrong, and it is wrong for everyone"],
    [403, undefined, false, "same, with no reason given"],
    [500, undefined, false, "their problem, probably temporary"],
    [429, undefined, false, "rate limited, try again later"],
  ];

  for (const [status, reason, expected, why] of cases) {
    it(`${expected ? "prunes" : "keeps"} on ${status}${reason ? ` ${reason}` : ""}: ${why}`, async () => {
      const { sendPush } = await import("../src/webpush");
      const client = await makeClient();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(reason ? JSON.stringify({ reason }) : "", {
              status,
              // Apple serves JSON errors as text/plain, so the parser must not
              // depend on the content type.
              headers: { "Content-Type": "text/plain; charset=UTF-8" },
            }),
        ),
      );

      const result = await sendPush(
        { VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE } as any,
        {
          endpoint: "https://web.push.apple.com/x",
          p256dh: client.p256dh,
          auth: client.auth,
          created: 0,
        },
        "{}",
      );

      expect(result.ok).toBe(false);
      expect(result.gone ?? false).toBe(expected);
      expect(result.reason).toBe(reason);
      vi.unstubAllGlobals();
    });
  }
});

describe("VAPID token reuse", () => {
  it("reuses one token per push service instead of re-signing every message", async () => {
    const { clearVapidCache } = await import("../src/webpush");
    clearVapidCache();
    const env = {
      VAPID_PUBLIC_KEY: VAPID_PUBLIC,
      VAPID_PRIVATE_KEY: VAPID_PRIVATE,
      VAPID_SUBJECT: "mailto:admin@example.com",
    } as any;

    const apple = await vapidAuthorization(env, "https://web.push.apple.com/a");
    const appleAgain = await vapidAuthorization(env, "https://web.push.apple.com/b");
    const mozilla = await vapidAuthorization(env, "https://updates.push.services.mozilla.com/c");

    expect(appleAgain).toBe(apple);
    // A token is bound to one audience, so a different service gets its own.
    expect(mozilla).not.toBe(apple);
  });

  it("signs a subject Apple will accept", async () => {
    // Apple wants a dotted host, a lowercase scheme and no whitespace.
    const header = await vapidAuthorization(
      { VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE, VAPID_SUBJECT: "mailto:popcorn-pager@popcorn-pager.example.workers.dev" } as any,
      "https://web.push.apple.com/z",
    );
    const claims = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(header.split(".")[1]!)),
    );
    expect(claims.sub).toMatch(/^[a-z]+:/);
    expect(claims.sub).not.toMatch(/\s/);
    expect(claims.sub.split("@").pop()).toContain(".");
    // Apple's accepted window is roughly [now - 300, now + 86700].
    expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThan(86400);
  });
});

describe("the key format deploy.ts generates", () => {
  /**
   * deploy.ts makes the VAPID keypair with these exact calls and base64url
   * encodes both halves. If that ever stops matching what the server expects,
   * the failure shows up as notifications silently not arriving, so it is
   * pinned here instead.
   */
  async function generateLikeDeployScript() {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    return {
      VAPID_PUBLIC_KEY: base64UrlEncode(
        new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer),
      ),
      VAPID_PRIVATE_KEY: base64UrlEncode(
        new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer),
      ),
      VAPID_SUBJECT: "mailto:popcorn-pager@popcorn-pager.example.workers.dev",
    };
  }

  it("signs a real VAPID header", async () => {
    clearVapidCache();
    const generated = await generateLikeDeployScript();
    const header = await vapidAuthorization(generated as never, "https://web.push.apple.com/abc");

    const [, token, key] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=(.+)$/.exec(header) ?? [];
    expect(token).toBeTruthy();
    expect(key).toBe(generated.VAPID_PUBLIC_KEY);

    const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(token!.split(".")[1]!)));
    expect(claims.aud).toBe("https://web.push.apple.com");
    expect(claims.sub).toBe(generated.VAPID_SUBJECT);
    clearVapidCache();
  });

  it("produces an uncompressed P-256 public key, which is what a browser needs", async () => {
    const generated = await generateLikeDeployScript();
    const bytes = base64UrlToBytes(generated.VAPID_PUBLIC_KEY);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });
});
