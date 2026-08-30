/**
 * The other end of `deploy.ts`: removes this deployment from Cloudflare and
 * from the working copy, so `npm run deploy` starts from nothing again.
 *
 *   npm run reset
 *
 * It deletes the Worker, the D1 database, the inbound email address, and the
 * local .secrets.json. It asks first, listing exactly what it found, and it
 * takes no action on anything it cannot prove belongs to this deployment.
 *
 * Two things it deliberately leaves alone, because both are shared with the
 * rest of the account: the workers.dev subdomain, which is permanent, and
 * Email Routing on the domain, since turning that off rewrites the MX records
 * for every address on it.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  api,
  BOLD,
  closePrompt,
  describe,
  DIM,
  fail,
  GREEN,
  hasError,
  info,
  interactive,
  ok,
  OFF,
  prompt,
  readConfig,
  ROOT,
  SECRETS_PATH,
  signIn,
  step,
  warn,
  wrangler,
  type Account,
} from "./scripts/cloudflare.ts";
import { ruleAddress, targetsWorker, type EmailRule, type Zone } from "./scripts/email-rules.ts";

const WRANGLER_STATE = join(ROOT, ".wrangler");

/** An email rule, on a named domain, that this reset would delete. */
interface RoutedRule {
  zone: Zone;
  rule: EmailRule;
  address: string;
}

interface Found {
  worker: boolean;
  database?: { uuid: string; name: string };
  rules: RoutedRule[];
  secrets: boolean;
  state: boolean;
  /** Rows in the database, when it could be read. Nothing when it could not. */
  contents?: { notifications: number; subscriptions: number };
}

// ---------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------

async function findWorker(token: string, account: Account, workerName: string): Promise<boolean> {
  // Asked for the script itself, Cloudflare answers with the JavaScript rather
  // than a JSON envelope, and every Worker then looks like it is missing. The
  // service endpoint is the one that answers in JSON.
  const service = await api(token, `/accounts/${account.id}/workers/services/${workerName}`);
  // 10090 is "this Worker does not exist", the normal answer on a second run.
  if (!service.success && !hasError(service, 10090)) {
    warn(`Could not check the Worker: ${describe(service)}`);
  }
  return service.success;
}

async function findDatabase(
  token: string,
  account: Account,
  databaseName: string,
): Promise<{ uuid: string; name: string } | undefined> {
  const list = await api<{ uuid: string; name: string }[]>(
    token,
    `/accounts/${account.id}/d1/database?per_page=100&name=${encodeURIComponent(databaseName)}`,
  );
  if (!list.success || !Array.isArray(list.result)) {
    warn(`Could not list databases: ${describe(list)}`);
    return undefined;
  }
  // The name query is a search, not a lookup, so a database called
  // "popcorn-pager-test" comes back too. Only an exact name is ours.
  return list.result.find(database => database.name === databaseName);
}

/** Every rule, on every domain, that delivers to this Worker. */
async function findRules(token: string, workerName: string): Promise<RoutedRule[]> {
  const zones = await api<Zone[]>(token, "/zones?per_page=50");
  if (!zones.success || !Array.isArray(zones.result)) return [];

  const perZone = await Promise.all(
    zones.result.map(async zone => {
      const rules = await api<EmailRule[]>(
        token,
        `/zones/${zone.id}/email/routing/rules?per_page=50`,
      );
      if (!rules.success || !Array.isArray(rules.result)) return [];
      return rules.result
        .filter(rule => targetsWorker(rule, workerName))
        .map(rule => ({ zone, rule, address: ruleAddress(rule) ?? "(catch-all)" }));
    }),
  );

  return perZone.flat();
}

/**
 * What is actually in the database. This is the part of the confirmation that
 * matters: the row counts are what the deletion costs.
 */
async function readContents(
  databaseName: string,
  accountId: string,
): Promise<Found["contents"]> {
  const result = await wrangler(
    [
      "d1",
      "execute",
      databaseName,
      "--remote",
      "--json",
      "--command",
      "SELECT (SELECT COUNT(*) FROM notifications) AS notifications," +
        " (SELECT COUNT(*) FROM push_subscriptions) AS subscriptions",
    ],
    { env: { CLOUDFLARE_ACCOUNT_ID: accountId } },
  );
  if (result.code !== 0) return undefined;

  try {
    const parsed = JSON.parse(result.stdout) as {
      results?: { notifications?: number; subscriptions?: number }[];
    }[];
    const row = parsed[0]?.results?.[0];
    if (!row) return undefined;
    return { notifications: row.notifications ?? 0, subscriptions: row.subscriptions ?? 0 };
  } catch {
    return undefined;
  }
}

async function find(
  token: string,
  account: Account,
  workerName: string,
  databaseName: string,
): Promise<Found> {
  step("Finding what belongs to this deployment");

  const [worker, database, rules] = await Promise.all([
    findWorker(token, account, workerName),
    findDatabase(token, account, databaseName),
    findRules(token, workerName),
  ]);

  const found: Found = {
    worker,
    database,
    rules,
    secrets: existsSync(SECRETS_PATH),
    state: existsSync(WRANGLER_STATE),
  };
  if (database) found.contents = await readContents(databaseName, account.id);

  report(found, workerName, databaseName);
  return found;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function report(found: Found, workerName: string, databaseName: string): void {
  const line = (label: string, value: string) => info(`${label.padEnd(16)}${value}`);
  const gone = `${DIM}not there${OFF}`;

  line("Worker", found.worker ? workerName : gone);
  line(
    "Database",
    found.database
      ? `${databaseName}${found.contents ? ` (${count(found.contents.notifications, "notification")}, ${count(found.contents.subscriptions, "subscribed phone")})` : ""}`
      : gone,
  );
  line(
    "Email address",
    found.rules.length ? found.rules.map(r => r.address).join(", ") : gone,
  );
  line("Local secrets", found.secrets ? ".secrets.json" : gone);
  line("Local state", found.state ? ".wrangler/" : gone);
}

const anything = (found: Found) =>
  found.worker || Boolean(found.database) || found.rules.length > 0 || found.secrets || found.state;

// ---------------------------------------------------------------------------
// Confirming
// ---------------------------------------------------------------------------

/**
 * Nothing here is recoverable, and the account this runs against is somebody's
 * real one, so the confirmation is typing the Worker's name rather than a
 * keystroke. `--yes` skips it, for a script that already knows.
 */
async function confirmed(found: Found, workerName: string, assumeYes: boolean): Promise<boolean> {
  step("Confirming");

  if (found.contents?.subscriptions) {
    warn(`${count(found.contents.subscriptions, "phone")} will stop receiving notifications.`);
  }
  if (found.secrets) {
    warn("The Web Push keypair in .secrets.json is deleted with it, and cannot be recovered.");
  }
  if (found.rules.length) {
    warn("Email sent to the address above will bounce once the rule is gone.");
  }

  if (assumeYes) {
    info("--yes given, so not asking.");
    return true;
  }
  if (!interactive) {
    warn("Nothing deleted: this is not a terminal, so there is nobody to ask.");
    info("Pass --yes if you meant to run it unattended.");
    return false;
  }

  const typed = (await prompt(`   Type ${BOLD}${workerName}${OFF} to delete all of it: `)).trim();
  if (typed !== workerName) {
    info("That did not match. Nothing deleted.");
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Removing
// ---------------------------------------------------------------------------

/**
 * The rules go first. A Worker that an Email Routing rule still points at is a
 * Worker that Cloudflare can refuse to delete, and a rule left behind is one
 * that delivers mail to nothing.
 */
async function removeRules(token: string, rules: RoutedRule[]): Promise<void> {
  if (rules.length === 0) return;
  step("Removing the inbound email address");

  for (const routed of rules) {
    const deleted = await api(
      token,
      `/zones/${routed.zone.id}/email/routing/rules/${routed.rule.tag}`,
      { method: "DELETE" },
    );
    if (deleted.success) ok(`Deleted ${routed.address}`);
    else warn(`Could not delete ${routed.address}: ${describe(deleted)}`);
  }

  info("Email Routing is still on for the domain. Turning it off would rewrite its MX records.");
}

async function removeWorker(
  token: string,
  account: Account,
  workerName: string,
  present: boolean,
): Promise<void> {
  if (!present) return;
  step("Deleting the Worker");

  const deleted = await api(token, `/accounts/${account.id}/workers/scripts/${workerName}`, {
    method: "DELETE",
  });
  if (!deleted.success) fail(`Could not delete the Worker: ${describe(deleted)}`);
  ok(`Deleted "${workerName}", along with its secrets, cron trigger and routes`);
}

async function removeDatabase(
  token: string,
  account: Account,
  database: Found["database"],
): Promise<void> {
  if (!database) return;
  step("Deleting the database");

  const deleted = await api(token, `/accounts/${account.id}/d1/database/${database.uuid}`, {
    method: "DELETE",
  });
  if (!deleted.success) fail(`Could not delete the database: ${describe(deleted)}`);
  ok(`Deleted "${database.name}"`);
}

function removeLocalFiles(found: Found): void {
  if (!found.secrets && !found.state) return;
  step("Clearing local files");

  if (found.secrets) {
    rmSync(SECRETS_PATH, { force: true });
    ok("Removed .secrets.json");
  }
  if (found.state) {
    rmSync(WRANGLER_STATE, { recursive: true, force: true });
    ok("Removed .wrangler/");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const assumeYes = process.argv.slice(2).some(arg => arg === "--yes" || arg === "-y");

  console.log(`\n${BOLD}\u{1F37F} PopcornPager reset${OFF}`);
  console.log(`${DIM}Removes this deployment from Cloudflare so you can start again.${OFF}`);

  const { workerName, databaseName } = readConfig();
  const { account, token } = await signIn();
  const found = await find(token, account, workerName, databaseName);

  if (!anything(found)) {
    console.log(`\n${GREEN}Nothing to remove. This is already a clean slate.${OFF}\n`);
    return;
  }

  if (!(await confirmed(found, workerName, assumeYes))) {
    console.log();
    process.exitCode = 1;
    return;
  }

  await removeRules(token, found.rules);
  await removeWorker(token, account, workerName, found.worker);
  await removeDatabase(token, account, found.database);
  removeLocalFiles(found);

  console.log(`\n${GREEN}${BOLD}Done.${OFF}`);
  console.log(`   Run ${BOLD}npm run deploy${OFF} to set it up again from scratch.`);
  console.log(`\n   ${DIM}Left alone, because the rest of your account shares them:${OFF}`);
  console.log(`   ${DIM}the workers.dev subdomain, and Email Routing on the domain.${OFF}`);
  console.log(`   ${DIM}Notifications already on a phone stay there until they are cleared.${OFF}`);
  console.log();
}

main()
  .catch(err => fail(String(err?.stack ?? err)))
  .finally(() => closePrompt());
