import { env } from "cloudflare:test";

/** The token every test authenticates with (matches vitest.config.ts). */
export const TOKEN = "tk_testtoken0000000000000000000";

export function authed(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      Authorization: `Bearer ${TOKEN}`,
    },
  };
}

export async function clearNotifications(): Promise<void> {
  await env.DB.prepare("DELETE FROM notifications").run();
}

export async function clearSubscriptions(): Promise<void> {
  await env.DB.prepare("DELETE FROM push_subscriptions").run();
}
