import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

// Deliberately standalone rather than reading wrangler.jsonc, so the suite does
// not depend on deployment config: no D1 database id, no real keys, and no
// Cloudflare account. `npm test` works immediately after `npm install`.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-19",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        bindings: {
          TEST_MIGRATIONS: migrations,
          NOTIFICATION_TTL_HOURS: "720",
          AUTH_TOKEN: "tk_testtoken0000000000000000000",
          VAPID_SUBJECT: "mailto:test@example.com",
          VAPID_PUBLIC_KEY:
            "BLfKsuzbLWbLaE89llQQCIk0BmPOLPlbHMTxx2sbgUJJzq72WZ-GhkQduEKwUqKUfmHL4RD3GO9CVlZ8RtzT8uw",
          VAPID_PRIVATE_KEY:
            "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgo5ljEDhZo8dPqZWvvAXsmJTDbEzyMrmU7kVw2XCzbNmhRANCAAS3yrLs2y1my2hPPZZUEAiJNAZjziz5WxzE8cdrG4FCSc6u9lmfhoZEHbhCsFKilH5hy-EQ9xjvQlZWfEbc0_Ls",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
