/**
 * The parts of talking to Cloudflare that both `deploy.ts` and `reset.ts` need:
 * running wrangler, calling the API, asking questions, and printing steps.
 *
 * It lives here so the two scripts cannot drift. They have to agree on the
 * Worker name, the database name and which email rules belong to this project,
 * and a disagreement between them is not a visible bug: it is a second inbox,
 * or a database that outlives the Worker that used it.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SECRETS_PATH = join(ROOT, ".secrets.json");
const API = "https://api.cloudflare.com/client/v4";

/** Everything `npm run deploy` generated for one Cloudflare account. */
export interface Secrets {
  authToken: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  /** Set once the inbound address has been wired up, so we do not ask twice. */
  emailAddress?: string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const BOLD = "\u001b[1m";
export const DIM = "\u001b[2m";
export const GREEN = "\u001b[32m";
export const YELLOW = "\u001b[33m";
export const RED = "\u001b[31m";
export const OFF = "\u001b[0m";

let stepNumber = 0;
export const step = (text: string) => console.log(`\n${BOLD}${++stepNumber}. ${text}${OFF}`);
export const ok = (text: string) => console.log(`   ${GREEN}✓${OFF} ${text}`);
export const info = (text: string) => console.log(`   ${DIM}${text}${OFF}`);
export const warn = (text: string) => console.log(`   ${YELLOW}!${OFF} ${text}`);

export function fail(text: string): never {
  console.error(`\n${RED}✗ ${text}${OFF}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command, capturing its output. Never throws; check `code`. */
export function run(
  command: string,
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...options.env },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => (stdout += chunk));
    child.stderr?.on("data", chunk => (stderr += chunk));
    if (options.stdin !== undefined) child.stdin!.end(options.stdin);

    // Without this, a missing binary throws out of the EventEmitter instead of
    // rejecting, and the user gets a raw stack rather than an explanation.
    child.on("error", err => resolve({ code: 127, stdout: "", stderr: String(err) }));
    child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Runs a command with the terminal attached, for anything that needs the user. */
export function runInteractive(command: string, args: string[]): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", err => {
      console.error(`   could not run ${command}: ${String(err)}`);
      resolve(127);
    });
    child.on("close", code => resolve(code ?? 1));
  });
}

export const wrangler = (
  args: string[],
  options?: { stdin?: string; env?: Record<string, string> },
) => run("npx", ["--no-install", "wrangler", ...args], options);

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

/**
 * Whether there is a person on the other end. Piped into a script or run from
 * CI there is not, so nothing prompts: every question takes its default and
 * says so, and the steps that need a real answer are skipped rather than
 * guessed at.
 */
export const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

let rl: ReturnType<typeof createInterface> | undefined;
export const prompt = (text: string) => {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(text);
};

export const closePrompt = () => rl?.close();

export async function ask(question: string, fallback = ""): Promise<string> {
  if (!interactive) {
    info(`${question}: ${fallback || "(skipped, not a terminal)"}`);
    return fallback;
  }
  const suffix = fallback ? ` ${DIM}[${fallback}]${OFF}` : "";
  return (await prompt(`   ${question}${suffix}: `)).trim() || fallback;
}

export async function confirm(question: string, fallback = true): Promise<boolean> {
  if (!interactive) {
    info(`${question}: ${fallback ? "yes" : "no"} (not a terminal)`);
    return fallback;
  }
  const answer = (await prompt(`   ${question} ${DIM}[${fallback ? "Y/n" : "y/N"}]${OFF}: `))
    .trim()
    .toLowerCase();
  return answer ? answer.startsWith("y") : fallback;
}

/** Pick from a list. Never asks when there is only one, or nobody to ask. */
export async function choose<T>(
  label: string,
  options: T[],
  describeOption: (option: T) => string,
): Promise<T> {
  const first = options[0]!;
  if (options.length === 1 || !interactive) return first;
  console.log(`   ${options.map((o, i) => `${i + 1}) ${describeOption(o)}`).join("\n   ")}`);
  const choice = Number(await ask(label, "1"));
  return Number.isInteger(choice) && options[choice - 1] ? options[choice - 1]! : first;
}

// ---------------------------------------------------------------------------
// Cloudflare API
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  success: boolean;
  result: T;
  errors: { code: number; message: string }[];
}

export async function api<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string>),
    },
  });

  try {
    return (await response.json()) as ApiResponse<T>;
  } catch {
    // A rate limit or a 5xx answers with HTML, not JSON.
    return {
      success: false,
      result: undefined as T,
      errors: [{ code: response.status, message: `Cloudflare returned ${response.status}` }],
    };
  }
}

export const hasError = (response: ApiResponse<unknown>, code: number) =>
  response.errors?.some(e => e.code === code) ?? false;

export const describe = (response: ApiResponse<unknown>) =>
  response.errors?.map(e => `${e.code} ${e.message}`).join("; ") || "unknown error";

// ---------------------------------------------------------------------------
// Config and secrets
// ---------------------------------------------------------------------------

/**
 * The Worker and database names both live in wrangler.jsonc, which is the only
 * place they can safely live: a name chosen here would not match the
 * `database_name` the Worker binds, and the two would quietly diverge. To
 * rename a deployment, change both in that file.
 */
export function readConfig(): { workerName: string; databaseName: string } {
  const path = join(ROOT, "wrangler.jsonc");
  let config: { name?: string; d1_databases?: { database_name?: string }[] };
  try {
    const text = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    config = JSON.parse(text);
  } catch (err) {
    fail(`Could not read ${path}: ${String(err)}`);
  }

  const workerName = config.name;
  const databaseName = config.d1_databases?.[0]?.database_name;
  if (!workerName || !databaseName) {
    fail(`${path} needs a "name" and a d1_databases[0].database_name.`);
  }
  return { workerName, databaseName };
}

export function loadSecrets(): Partial<Secrets> {
  if (!existsSync(SECRETS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, "utf8")) as Partial<Secrets>;
  } catch {
    fail(`${SECRETS_PATH} is not valid JSON. Fix or delete it and run again.`);
  }
}

export function saveSecrets(secrets: Partial<Secrets>): void {
  writeFileSync(SECRETS_PATH, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

export interface Account {
  id: string;
  name: string;
}

export async function signIn(): Promise<{ account: Account; token: string }> {
  step("Signing in to Cloudflare");

  let whoami = await wrangler(["whoami", "--json"]);
  if (whoami.code !== 0) {
    info("Not signed in. Opening a browser to authorise wrangler.");
    if ((await runInteractive("npx", ["--no-install", "wrangler", "login"])) !== 0) {
      fail("wrangler login did not complete.");
    }
    whoami = await wrangler(["whoami", "--json"]);
    if (whoami.code !== 0) fail("Still not signed in after logging in.");
  }

  const identity = JSON.parse(whoami.stdout) as { email?: string; accounts?: Account[] };
  const accounts = identity.accounts ?? [];
  if (accounts.length === 0) fail("That login has no Cloudflare accounts on it.");

  const account = await choose("Which account", accounts, a => a.name);

  const auth = await wrangler(["auth", "token", "--json"]);
  if (auth.code !== 0) fail("Could not read the wrangler auth token.");
  const token = (JSON.parse(auth.stdout) as { token: string }).token;

  ok(`${identity.email ?? "signed in"} — ${account.name}`);
  return { account, token };
}

/** Base62, so it survives being typed on a phone keyboard. */
export function generateToken(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(32);
  let out = "tk_";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}
