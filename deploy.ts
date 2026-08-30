/**
 * One command that takes a fresh clone and a Cloudflare account and leaves you
 * with a working PopcornPager.
 *
 *   npm run deploy
 *
 * Safe to run again. Everything it generates is written to .secrets.json, which
 * is gitignored, and reused on the next run, so a redeploy does not invalidate
 * the notification subscriptions already on your phone.
 *
 * `npm run reset` is the other end of this: it removes everything below.
 *
 * Run with Node 24 or newer, which executes TypeScript directly. There are no
 * dependencies beyond wrangler, which is already a dev dependency.
 */

import { randomBytes, webcrypto } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  api,
  ask,
  BOLD,
  choose,
  closePrompt,
  confirm,
  describe,
  DIM,
  fail,
  GREEN,
  hasError,
  info,
  interactive,
  loadSecrets,
  ok,
  OFF,
  readConfig,
  ROOT,
  runInteractive,
  saveSecrets,
  signIn,
  step,
  warn,
  wrangler,
  generateToken,
  type Account,
  type Secrets,
} from "./scripts/cloudflare.ts";
import {
  ruleAddress,
  ruleBody,
  targetsWorker,
  type EmailRule,
  type RoutedAddress,
  type Zone,
} from "./scripts/email-rules.ts";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const base64Url = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("base64url");

/**
 * A VAPID keypair: the P-256 identity this server signs push requests with.
 * The public half goes to the browser, which binds its subscription to it, so
 * regenerating this invalidates every phone already subscribed.
 */
async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const keys = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  return {
    publicKey: base64Url(await webcrypto.subtle.exportKey("raw", keys.publicKey)),
    privateKey: base64Url(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)),
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * A workers.dev subdomain has to exist before a Worker can be published to one,
 * and a brand new account does not have one. Wrangler will not register it
 * without a prompt, so do it here.
 */
async function ensureSubdomain(token: string, account: Account): Promise<string> {
  step("Checking your workers.dev subdomain");

  const current = await api<{ subdomain: string }>(token, `/accounts/${account.id}/workers/subdomain`);
  if (current.success && current.result?.subdomain) {
    ok(`${current.result.subdomain}.workers.dev`);
    return current.result.subdomain;
  }
  if (!hasError(current, 10007)) {
    fail(`Could not read the workers.dev subdomain: ${describe(current)}`);
  }

  info("This account has no workers.dev subdomain yet. It becomes part of your URL.");
  if (!interactive) {
    fail(
      "This account needs a workers.dev subdomain, which is permanent and account-wide.\n" +
        "  Run this from a terminal so you can choose the name.",
    );
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wanted = (await ask("Choose one", suggestSubdomain(account.name))).toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(wanted)) {
      warn("Lowercase letters, digits and hyphens only.");
      continue;
    }

    const registered = await api(token, `/accounts/${account.id}/workers/subdomain`, {
      method: "PUT",
      body: JSON.stringify({ subdomain: wanted }),
    });
    if (registered.success) {
      ok(`${wanted}.workers.dev`);
      return wanted;
    }
    warn(hasError(registered, 10031) ? "That one is taken." : describe(registered));
  }

  return fail("Could not register a workers.dev subdomain after several tries.");
}

function suggestSubdomain(accountName: string): string {
  const base = accountName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base.slice(0, 20) || "popcorn"}-${randomBytes(2).toString("hex")}`;
}

async function collectSecrets(secrets: Partial<Secrets>): Promise<Secrets> {
  step("Preparing secrets");

  if (!secrets.authToken) {
    secrets.authToken = generateToken();
    ok("Generated an auth token");
  } else {
    info("Reusing the auth token from .secrets.json");
  }

  if (!secrets.vapidPublicKey || !secrets.vapidPrivateKey) {
    const keys = await generateVapidKeys();
    secrets.vapidPublicKey = keys.publicKey;
    secrets.vapidPrivateKey = keys.privateKey;
    ok("Generated a Web Push keypair");
  } else {
    info("Reusing the Web Push keypair from .secrets.json");
  }

  saveSecrets(secrets);
  ok(`Saved to .secrets.json ${DIM}(gitignored — keep a copy)${OFF}`);

  return {
    authToken: secrets.authToken!,
    vapidPublicKey: secrets.vapidPublicKey!,
    vapidPrivateKey: secrets.vapidPrivateKey!,
    ...(secrets.emailAddress ? { emailAddress: secrets.emailAddress } : {}),
  };
}

async function uploadSecrets(
  secrets: Secrets,
  workerName: string,
  workerHost: string,
  accountId: string,
): Promise<void> {
  step("Uploading secrets");

  const payload: Record<string, string> = {
    AUTH_TOKEN: secrets.authToken,
    VAPID_PUBLIC_KEY: secrets.vapidPublicKey,
    VAPID_PRIVATE_KEY: secrets.vapidPrivateKey,
    // Apple is strict about this: lowercase scheme, no whitespace, and a host
    // with a dot in it.
    VAPID_SUBJECT: `mailto:popcorn-pager@${workerHost}`,
  };

  // `secret bulk` creates a draft Worker if this is the first run, which is why
  // it can go before the deploy.
  const result = await wrangler(["secret", "bulk", "--name", workerName], {
    stdin: JSON.stringify(payload),
    env: { CLOUDFLARE_ACCOUNT_ID: accountId },
  });
  if (result.code !== 0) fail(`Uploading secrets failed:\n${result.stderr || result.stdout}`);

  ok(`${Object.keys(payload).length} secrets uploaded`);
}

async function ensureDatabase(databaseName: string, accountId: string): Promise<void> {
  step("Setting up the database");

  const env = { CLOUDFLARE_ACCOUNT_ID: accountId };
  const existing = await wrangler(["d1", "info", databaseName, "--json"], { env });

  if (existing.code !== 0) {
    const created = await wrangler(["d1", "create", databaseName], { env });
    // "Already exists" is not a failure: `d1 info` can also fail on a network
    // blip, and creating over an existing database is a no-op we can ignore.
    if (created.code !== 0 && !/already exists/i.test(created.stderr + created.stdout)) {
      fail(`Creating the database failed:\n${created.stderr || created.stdout}`);
    }
    ok(`Created the D1 database "${databaseName}"`);
  } else {
    info(`Using the existing D1 database "${databaseName}"`);
  }

  const migrated = await wrangler(["d1", "migrations", "apply", databaseName, "--remote"], { env });
  if (migrated.code !== 0) fail(`Migrations failed:\n${migrated.stderr || migrated.stdout}`);
  ok("Migrations applied");
}

async function deploy(workerName: string, accountId: string): Promise<string> {
  step("Deploying");

  const outputDir = mkdtempSync(join(tmpdir(), "popcorn-"));
  const outputPath = join(outputDir, "wrangler.ndjson");
  const result = await wrangler(["deploy", "--name", workerName], {
    env: { CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_OUTPUT_FILE_PATH: outputPath },
  });
  if (result.code !== 0) fail(`Deploy failed:\n${result.stderr || result.stdout}`);

  // Wrangler writes one JSON object per line here, and the deploy entry names
  // the URLs it published to. More reliable than reading the pretty output.
  let url = "";
  if (existsSync(outputPath)) {
    for (const line of readFileSync(outputPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { type?: string; targets?: string[] };
      if (event.type === "deploy" && event.targets?.length) url = event.targets[0]!;
    }
  }

  rmSync(outputDir, { recursive: true, force: true });
  ok(url ? `Live at ${url}` : "Deployed");
  return url;
}

async function verify(url: string, secrets: Secrets): Promise<void> {
  step("Checking it works");

  // A hostname on a fresh workers.dev subdomain can take a while to resolve,
  // and the deploy has already succeeded by this point, so this retries and
  // then warns rather than aborting and skipping the email step.
  let healthy = false;
  for (let attempt = 0; attempt < 6 && !healthy; attempt += 1) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 5000));
    healthy = await fetch(`${url}/health`).then(r => r.ok).catch(() => false);
  }
  if (!healthy) {
    warn("The Worker is not answering yet. Give DNS a minute, then check the URL.");
    return;
  }
  ok("Health check passed");

  const debug = await fetch(`${url}/api/debug?vapid=1`, {
    headers: { Authorization: `Bearer ${secrets.authToken}` },
  }).catch(() => undefined);
  if (!debug) {
    warn("Could not reach the diagnostics endpoint. The deploy itself succeeded.");
    return;
  }
  if (debug.status === 401) fail("The auth token was not accepted. Try running this again.");
  if (!debug.ok) fail(`Diagnostics returned ${debug.status}`);

  const state = (await debug.json()) as {
    web_push_configured: boolean;
    vapid?: { accepted?: boolean; reason?: string };
  };

  if (!state.web_push_configured) fail("Web Push is not configured. The VAPID secrets did not land.");
  ok("Web Push is configured");

  // A live pre-flight against Apple's push service. It answers with a token
  // error for the made-up device, which is proof the signature was accepted.
  if (state.vapid?.accepted) ok("Apple accepted the push signature");
  else warn(`Apple did not accept the push signature: ${state.vapid?.reason ?? "unknown"}`);

  // Researching a film costs a few cents in web searches, so it is not run on
  // every deploy. `?research=<film>` is the way to check it, and no credits on
  // the Cloudflare account is the usual reason it comes back empty.
  info("Film research runs through AI Gateway. Check it with:");
  info(`  curl -H "Authorization: Bearer <token>" "${url}/api/debug?research=Wicked"`);
}

// ---------------------------------------------------------------------------
// Email routing
// ---------------------------------------------------------------------------

/**
 * Every address, across every domain on the account, that already delivers to
 * this Worker.
 *
 * Cloudflare is the source of truth here, not .secrets.json. Trusting the local
 * file means a lost or stale copy of it produces a second inbox on a rerun,
 * which is how you end up with two addresses and no idea which one your email
 * client is forwarding to.
 */
export async function routedAddresses(
  token: string,
  zones: Zone[],
  workerName: string,
): Promise<RoutedAddress[]> {
  const perZone = await Promise.all(
    zones.map(async zone => {
      const rules = await api<EmailRule[]>(
        token,
        `/zones/${zone.id}/email/routing/rules?per_page=50`,
      );
      if (!rules.success || !Array.isArray(rules.result)) return [];

      return rules.result
        .filter(rule => targetsWorker(rule, workerName))
        .map(rule => ({ zone, rule, address: ruleAddress(rule) ?? "" }))
        .filter(found => found.address !== "");
    }),
  );

  return perZone.flat();
}

/**
 * Wires an inbound address on one of your domains to this Worker.
 *
 * Cloudflare can only receive email on a domain it is the nameserver for, so
 * this needs a zone. Everything else is automatic: routing to a Worker needs no
 * verified destination address, unlike forwarding.
 */
async function setUpEmail(
  token: string,
  account: Account,
  secrets: Partial<Secrets>,
  workerName: string,
): Promise<string | undefined> {
  step("Wiring up the inbound email address");

  const zones = await api<Zone[]>(token, "/zones?per_page=50");
  if (!zones.success || zones.result.length === 0) {
    warn("No domains on this Cloudflare account, so there is nowhere to receive email.");
    info("Add a domain with Cloudflare as its nameserver, then run this again.");
    return undefined;
  }

  const routed = await routedAddresses(token, zones.result, workerName);

  // More than one is not something to resolve unasked: only you know which
  // address your email client forwards to.
  if (routed.length > 1) {
    warn(`${routed.length} addresses already deliver to "${workerName}":`);
    for (const found of routed) {
      info(`  ${found.address}${found.rule.enabled === false ? "  (disabled)" : ""}`);
    }
    info("Leaving them as they are. Remove the ones you do not want in the dashboard.");
    return routed.find(found => found.rule.enabled !== false)?.address ?? routed[0]!.address;
  }

  if (routed.length === 1) {
    const found = routed[0]!;
    if (found.rule.enabled !== false) {
      ok(`Already routed: ${found.address}`);
      return found.address;
    }
    // A disabled rule looks exactly like a working one until an email vanishes.
    const enabled = await api(token, `/zones/${found.zone.id}/email/routing/rules/${found.rule.tag}`, {
      method: "PUT",
      body: JSON.stringify(ruleBody(found.address, workerName)),
    });
    if (!enabled.success) {
      warn(`${found.address} is routed here but disabled, and re-enabling it failed: ${describe(enabled)}`);
      return found.address;
    }
    ok(`Re-enabled ${found.address}`);
    return found.address;
  }

  // Nothing points here yet. An address from a previous run, or from a Worker
  // that has been renamed, is repointed rather than replaced.
  if (secrets.emailAddress) {
    const zone = zones.result.find(z => secrets.emailAddress!.endsWith(`@${z.name}`));
    if (zone) {
      const rules = await api<EmailRule[]>(token, `/zones/${zone.id}/email/routing/rules?per_page=50`);
      const existing = rules.success && rules.result.find(r =>
        r.matchers?.some(m => m.value === secrets.emailAddress) &&
        r.actions?.some(a => a.type === "worker"),
      );
      if (existing) {
        const repointed = await api(token, `/zones/${zone.id}/email/routing/rules/${existing.tag}`, {
          method: "PUT",
          body: JSON.stringify(ruleBody(secrets.emailAddress, workerName)),
        });
        if (!repointed.success) {
          // Saying it worked when it did not would leave email going to a
          // Worker that no longer exists, with nothing in any log.
          warn(`Could not repoint ${secrets.emailAddress}: ${describe(repointed)}`);
          return undefined;
        }
        ok(`Repointed ${secrets.emailAddress} at "${workerName}"`);
        return secrets.emailAddress;
      }
    }
  }

  if (!interactive) {
    warn("Skipping email setup: run this from a terminal to wire up an address.");
    return undefined;
  }

  const zone = await choose("Which domain", zones.result, z => z.name);

  // Naming the domain matters: enabling Email Routing rewrites its MX records,
  // which is a bad surprise on a domain that already receives mail elsewhere.
  if (!(await confirm(`Create an inbound address on ${zone.name}?`))) return undefined;

  const settings = await api<{ enabled: boolean; status: string }>(
    token,
    `/zones/${zone.id}/email/routing`,
  );
  if (!settings.success || !settings.result?.enabled) {
    info(`Email Routing is not enabled on ${zone.name}. Turning it on.`);
    const enabled = await api(token, `/zones/${zone.id}/email/routing/enable`, { method: "POST" });
    if (!enabled.success) {
      warn(`Could not enable it: ${describe(enabled)}`);
      info(`Enable it by hand at https://dash.cloudflare.com/${account.id}/${zone.name}/email/routing`);
      return undefined;
    }
    ok("Email Routing enabled");
  }

  // An unguessable local part. Anyone who learns the address can make this
  // Worker do work, and can put a booking of their choosing on your lock
  // screen, so it is worth not publishing. It is obscurity, not a control.
  const address = `tickets-${randomBytes(6).toString("hex")}@${zone.name}`;
  const created = await api(token, `/zones/${zone.id}/email/routing/rules`, {
    method: "POST",
    body: JSON.stringify(ruleBody(address, workerName)),
  });
  if (!created.success) {
    warn(`Could not create the routing rule: ${describe(created)}`);
    return undefined;
  }

  ok(`Routed ${address} to "${workerName}"`);
  return address;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n${BOLD}\u{1F37F} PopcornPager${OFF}`);
  console.log(`${DIM}Buy a cinema ticket, and your phone tells you when to take a break.${OFF}`);

  if (!existsSync(join(ROOT, "node_modules", "wrangler"))) {
    step("Installing dependencies");
    if ((await runInteractive("npm", ["install"])) !== 0) fail("npm install failed.");
    ok("Installed");
  }

  const { account, token } = await signIn();
  const subdomain = await ensureSubdomain(token, account);

  const { workerName, databaseName } = readConfig();
  const secrets = loadSecrets();
  const workerHost = `${workerName}.${subdomain}.workers.dev`;
  const complete = await collectSecrets(secrets);

  await ensureDatabase(databaseName, account.id);
  await uploadSecrets(complete, workerName, workerHost, account.id);
  const url = (await deploy(workerName, account.id)) || `https://${workerHost}`;
  await verify(url, complete);

  const address = await setUpEmail(token, account, secrets, workerName);
  if (address) {
    secrets.emailAddress = address;
    saveSecrets(secrets);
  }

  console.log(`\n${GREEN}${BOLD}Done.${OFF}\n`);
  console.log(`${BOLD}On your phone${OFF}`);
  if (interactive) {
    console.log(`   1. Open ${BOLD}${url}/#token=${complete.authToken}${OFF} in Safari`);
  } else {
    // Not printed unattended, because that puts the token in a build log.
    console.log(`   1. Open ${BOLD}${url}/#token=<the authToken in .secrets.json>${OFF} in Safari`);
  }
  console.log("   2. Share button, then Add to Home Screen");
  console.log("   3. Open it from the home screen and turn notifications on");
  console.log(`\n   ${DIM}The link carries the token so you do not have to type it. iOS refuses${OFF}`);
  console.log(`   ${DIM}to let a web page ask for notifications until it is on the home screen.${OFF}`);

  if (address) {
    console.log(`\n${BOLD}To start getting notifications${OFF}`);
    console.log(`   Forward your cinema confirmation emails to ${BOLD}${address}${OFF}`);
    console.log(`   ${DIM}Most email clients can do this with a filter on the sender.${OFF}`);
  }

  console.log(`\n${BOLD}Useful later${OFF}`);
  console.log(`   npm run tail    ${DIM}watch it work${OFF}`);
  console.log(`   ${url}/api/debug?vapid=1  ${DIM}diagnose it${OFF}`);
  console.log(`   npm run reset   ${DIM}remove all of it${OFF}`);
  console.log();
}

main()
  .catch(err => fail(String(err?.stack ?? err)))
  .finally(() => closePrompt());
