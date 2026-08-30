import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { TOKEN, authed } from "./helpers";

const notify = (init: RequestInit = {}) =>
  SELF.fetch("https://example.com/api/notify", {
    method: "POST",
    body: JSON.stringify({ title: "t", body: "b" }),
    ...init,
  });

describe("auth", () => {
  it("rejects a notification with no credentials", async () => {
    const res = await notify();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects reading notifications with no credentials", async () => {
    const res = await SELF.fetch("https://example.com/api/notifications");
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const res = await notify({ headers: { Authorization: "Bearer tk_wrong" } });
    expect(res.status).toBe(401);
  });

  it("accepts the token as a Bearer credential", async () => {
    const res = await notify(authed());
    expect(res.status).toBe(200);
  });

  it("does not accept the token in the query string", async () => {
    // A credential in a URL ends up in more logs and histories than one in a
    // header, and nothing here needs it: every client can set a header.
    const res = await SELF.fetch(`https://example.com/api/notifications?auth=${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("refuses everything when no token is configured", async () => {
    // Fails closed: a deploy that forgot `wrangler secret put AUTH_TOKEN` must
    // not come up as an open relay.
    for (const value of ["", undefined]) {
      const request = new Request("https://example.com/api/notifications");
      const ctx = createExecutionContext();
      const res = await worker.fetch(request, { ...env, AUTH_TOKEN: value } as never);
      await waitOnExecutionContext(ctx);
      expect(res.status, String(value)).toBe(401);
    }
  });

  it("rejects a token that is right except for its last character", async () => {
    const res = await notify({ headers: { Authorization: `Bearer ${TOKEN.slice(0, -1)}x` } });
    expect(res.status).toBe(401);
  });

  it("rejects a token that is a prefix of the real one", async () => {
    // The comparison is length-independent, so a short guess must not pass by
    // matching every byte it does have.
    const res = await notify({ headers: { Authorization: `Bearer ${TOKEN.slice(0, 8)}` } });
    expect(res.status).toBe(401);
  });

  it("rejects a bare token with no scheme", async () => {
    const res = await notify({ headers: { Authorization: TOKEN } });
    expect(res.status).toBe(401);
  });

  it("leaves the health endpoint open", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers HEAD on the open endpoints, for uptime monitors", async () => {
    for (const path of ["/", "/health"]) {
      const res = await SELF.fetch(`https://example.com${path}`, { method: "HEAD" });
      expect(res.status, path).toBe(200);
    }
  });

  it("serves the app itself without a token, since that is where you enter it", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("404s an unknown authenticated path rather than hinting at one", async () => {
    const res = await SELF.fetch("https://example.com/api/nope", authed());
    expect(res.status).toBe(404);
  });
});
