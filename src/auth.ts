import { errUnauthorized } from "./errors";
import type { Env } from "./types";
import { secureEquals } from "./util";

/**
 * Everything except the app shell, the health check and the push ack needs the
 * shared token, sent as `Authorization: Bearer <token>`.
 */
function isAuthorized(request: Request, env: Env): boolean {
  const token = env.AUTH_TOKEN;
  if (!token) {
    // Fails closed. AUTH_TOKEN is a secret, so nothing at deploy time proves it
    // was ever set; treating "missing" as "open" would hand the server to
    // anyone who found the URL.
    console.error({ event: "auth_misconfigured", error: "AUTH_TOKEN is not set" });
    return false;
  }

  const header = request.headers.get("Authorization");
  if (!header) return false;

  const separatorIndex = header.indexOf(" ");
  if (separatorIndex === -1) return false;
  if (header.slice(0, separatorIndex).toLowerCase() !== "bearer") return false;

  const value = header.slice(separatorIndex + 1).trim();
  return value !== "" && secureEquals(value, token);
}

export function requireAuth(request: Request, env: Env): void {
  if (!isAuthorized(request, env)) throw errUnauthorized();
}
