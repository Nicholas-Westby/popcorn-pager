# Reference

Every setting, every route, and how to run the thing locally.

[← README](../README.md)

## Configuration

`npm run deploy` sets all of this. There is nothing to edit by hand for a normal
deployment.

| Name | Kind | Set by | Purpose |
| --- | --- | --- | --- |
| `DB` | D1 binding | `wrangler.jsonc`; the database itself is created and migrated by the deploy | Notifications and push subscriptions |
| `AI` | Workers AI binding | `wrangler.jsonc` | Extraction, and the research call, which the same binding forwards to AI Gateway |
| `NOTIFICATION_TTL_HOURS` | var | `wrangler.jsonc`, `720` (30 days) | How long a notification is kept before the hourly cleanup deletes it |
| `AUTH_TOKEN` | secret | deploy | The shared token. Everything except the app shell, `/health` and the ack needs it. If it is unset, nothing is authorised: it fails closed rather than open |
| `VAPID_PUBLIC_KEY` | secret | deploy | Web Push identity. The browser needs this half, so it is not confidential, but it is stored with its pair |
| `VAPID_PRIVATE_KEY` | secret | deploy | The other half. Without both, Web Push is off and nothing can reach a phone |
| `VAPID_SUBJECT` | secret | deploy, as `mailto:popcorn-pager@<worker host>` | The contact URI VAPID requires in the signed token. Apple rejects it unless the scheme is lowercase, the host has a dot in it, and there is no whitespace |

Those four secrets are the entire set the deploy uploads. To add or change one
later, run `npm run deploy` again, or use `npx wrangler secret put NAME`.

`.secrets.json` holds the generated auth token, the VAPID keypair and the
inbound address. It is gitignored and reused on the next run, so a redeploy does
not unsubscribe your phone. Keep a copy: losing the VAPID keypair means every
phone has to enable notifications again.

### What else is in `wrangler.jsonc`

Nothing in the file is specific to one Cloudflare account, which is why it is
committed as it stands.

| Setting | Why |
| --- | --- |
| `name`, `d1_databases[0].database_name` | The Worker and database names. The deploy reads them rather than asking |
| `triggers.crons` | `17 * * * *`, the hourly cleanup of expired notifications |
| `preview_urls: false` | A per-version preview URL would be a second origin, and a service worker and its push subscriptions belong to one origin |
| no `database_id` | The database is resolved by name on deploy and created if it does not exist, which keeps the id out of git |

Renaming a deployment means changing `name` and `d1_databases[0].database_name`
together. They have to agree, because the Worker binds its database by name, and
a name chosen anywhere else would quietly diverge from the one the Worker binds.
A rename also orphans the email routing rule, which names the Worker script; see
[Troubleshooting](troubleshooting.md).

## The API

Authentication is `Authorization: Bearer <token>` and nothing else. A token in
the query string is not accepted.

| Route | Method | Auth | What it is |
| --- | --- | --- | --- |
| `/` | GET, HEAD | no | The web app. Open, because it is where you enter the token |
| `/sw.js` | GET, HEAD | no | The service worker, scoped to the whole origin |
| `/manifest.webmanifest` | GET, HEAD | no | Home screen manifest |
| `/icon.png` | GET, HEAD | no | The icon, inlined in the Worker |
| `/health` | GET, HEAD | no | `{"ok":true}`, for uptime monitors |
| `/api/ack` | POST | signature | The service worker confirming a notification appeared. Its ack is an HMAC that could only have come out of an encrypted push, so no token is needed |
| `/api/subscribe` | POST | yes | Store a push subscription. `{"endpoint","keys":{"p256dh","auth"}}` |
| `/api/subscribe` | DELETE | yes | Forget one. `{"endpoint"}` |
| `/api/notifications` | GET | yes | The 50 most recent, newest first |
| `/api/notify` | POST | yes | Send one. `{"title","body","click"}`, and the response carries `X-Push` |
| `/api/debug` | GET, HEAD | yes | Diagnostics, below |

`OPTIONS` answers a CORS preflight with a 204. Trailing slashes are stripped.
The token is checked before the route is matched, so an unauthenticated call to
anything below the app shell is a 401. After that, everything else is a 404:
a path that does not exist, and a method a route does not take.

### `X-Push`

`/api/notify` returns 200 whether or not the push went anywhere, because the
notification is stored either way and the app reads the same rows the next time
it opens. The header is how a caller finds out that delivery is quietly not
happening.

| Value | Meaning |
| --- | --- |
| `ok:<n>` | The push service accepted it for `n` subscriptions |
| `failed:<n>` | It was attempted for `n` subscriptions and accepted for none |
| `no-subscribers` | No phone has subscribed |
| `unconfigured` | The VAPID keys are not set, so no push was attempted |

### `/api/debug`

Always returned:

| Field | What it is |
| --- | --- |
| `origin` | The origin the Worker is answering on |
| `web_push_configured` | Whether both VAPID keys are set |
| `web_push_subscribers` | How many phones are subscribed |
| `notification_ttl_hours` | The TTL in force, resolved from the var |

Two query parameters make it do real work, so they are opt in and cost a live
request each time:

| Parameter | What it adds |
| --- | --- |
| `?vapid=1` | `vapid`, a pre-flight of Apple's push service using a device token that cannot exist. Apple checks the signature before the token, so a complaint about the token is proof that the signature, subject, audience and key were all fine |
| `?research=<film>` | `research_lines`, the real research call for that title and the lines it would put on your phone. This spends web searches |

## Starting over

`npm run reset` is the opposite of the deploy. It finds what belongs to this
deployment, prints it, and deletes it once you type the Worker's name back:

| Removed | Note |
| --- | --- |
| The Worker | Its secrets, cron trigger and routes go with it |
| The D1 database | Every stored notification, and every subscription |
| Every email rule pointing at the Worker | Mail to that address bounces afterwards |
| `.secrets.json` | Including the VAPID keypair, which is not recoverable |
| `.wrangler/` | Local build and state cache |

Two things it leaves alone on purpose, because the rest of the account shares
them: the workers.dev subdomain, which is permanent once registered, and Email
Routing on the domain, since turning that off rewrites the MX records for every
address on it.

It only ever touches names that match `wrangler.jsonc` exactly. This matters
more than it sounds: Cloudflare's database lookup is a substring search, so
asking for `popcorn-pager` also returns `popcorn-pager-test`. Both the database
and the email rules are matched on the full name in code rather than trusted
from the query.

Nothing is deleted without a person confirming. Pass `--yes` to skip the
question; without a terminal and without that flag, it reports what it found and
exits without touching anything.

## Development

```bash
npm test          # 158 tests, about a second
npm run typecheck # the Worker, then deploy.ts and reset.ts under their own tsconfig
npm run dev       # wrangler dev, local
```

Two caveats worth knowing up front:

- The tests run against the real Workers runtime with a real local D1, not a
  mock of either. Migrations are applied in `test/setup.ts`, and `fetch` is
  stubbed wherever a push would otherwise leave the machine, so the suite needs
  no network and no Cloudflare account.
- `wrangler dev --remote` does not work as checked in. `wrangler.jsonc` leaves
  `database_id` out on purpose, so that the id stays out of git and the database
  is resolved by name at deploy time, but a remote session needs that id. Add it
  by hand if you want remote dev. Plain `npm run dev` is unaffected.

`npm run test:watch` and `npm run tail` are the other two scripts.

## Layout

```
deploy.ts          sign in, generate, migrate, deploy, verify, route the email
reset.ts           find everything that deploy made, and delete it
scripts/           what both of those share: wrangler, the API, prompts, rules
wrangler.jsonc     bindings, the hourly cron, nothing account-specific
migrations/        the two tables: notifications and push_subscriptions
src/index.ts       the three handlers, routing, and the debug endpoint
src/agent.ts       the email pipeline end to end, and its own error handling
src/email.ts       readable text out of a raw MIME email
src/extract.ts     Workers AI reads the booking, against a JSON schema
src/research.ts    Claude and web search, and the validation of what comes back
src/compose.ts     booking plus research into the lines you see
src/notify.ts      store, push to every subscription, prune the dead ones
src/webpush.ts     RFC 8291/8188/8292 by hand: encryption and VAPID
src/app.ts         the web app, the service worker and the manifest
src/store.ts       notification rows, and the expiry sweep
src/pushstore.ts   subscription rows
src/auth.ts        bearer token checking, failing closed
src/icon.ts        the home screen icon, inlined so there is nothing to host
src/types.ts       Env, and the shapes that cross module boundaries
src/util.ts        ids, constant-time compare, the clock
src/http.ts        JSON and CORS responses
src/errors.ts      ApiError and the three helpers that raise it
test/              10 test files, one per area
```
