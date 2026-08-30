import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { clearNotifications } from "./helpers";

describe("expiry cleanup", () => {
  it("the cron deletes expired notifications and keeps live ones", async () => {
    await clearNotifications();
    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(
      `INSERT INTO notifications (id, time, expires, title, body) VALUES
         ('expired00001', ?, ?, 'old', 'old'),
         ('current00001', ?, ?, 'new', 'new')`,
    )
      .bind(now - 10_000, now - 1, now, now + 10_000)
      .run();

    const controller = createScheduledController();
    const ctx = createExecutionContext();
    await worker.scheduled!(controller, env as never);
    await waitOnExecutionContext(ctx);

    const { results } = await env.DB.prepare("SELECT id FROM notifications").all<{ id: string }>();
    expect(results.map(r => r.id)).toEqual(["current00001"]);
  });
});
