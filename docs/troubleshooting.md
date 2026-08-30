# Troubleshooting

What to check when notifications stop arriving, or a forwarded email produces
nothing at all.

[← README](../README.md)

## Start here

```bash
curl -H "Authorization: Bearer $TOKEN" "https://<your worker>/api/debug?vapid=1"
npm run tail
```

The pre-flight posts to Apple's push service with a device token that cannot
exist. Apple checks the signature before the token, so what it complains about
tells you which half is broken.

| Answer | What it means |
| --- | --- |
| `"accepted": true` | The signature, subject, audience and key were all accepted. The VAPID setup is sound, so the problem is one subscription, not the configuration |
| `"accepted": false` with `"status": 403` | The configuration is wrong for every device at once. `VAPID_SUBJECT` is the usual reason, and `detail` says so |
| `"accepted": false` with anything else, a 401 or a 5xx included | Not evidence either way. `detail` reads "treat as unproven" |
| `"configured": false` | The VAPID keys are not set, so nothing can reach a phone at all |

## Reading the log

The lines that answer most questions:

| Log line | Meaning |
| --- | --- |
| `email_received` | The message reached the Worker. Carries the sender, the raw size, and the character count after the MIME reduction |
| `booking_extracted` | The film, cinema and runtime that were read out of it |
| `not_a_ticket` | The email parsed but named no film, so it was dropped without notifying. A newsletter that finds the address stops here |
| `research` | The research call returned. Carries `searches`, how many `lines` came out of it, and `cue_rejected` when a cue was thrown away |
| `research_skipped` | There is no `AI` binding |
| `research_failed` | The call threw. The notification still goes out with the booking details |
| `notification_stored` | It is in D1. Titles and bodies are deliberately never logged: log lines leave the Worker, and the research lines are the whole private payload |
| `web_push_accepted` | The push service took the message, for one subscription. That is all it means |
| `web_push` | The per-notification total: `delivered` out of `attempted` |
| `web_push_failed` | Carries the push service's own `status` and `reason` |
| `push_skipped` | Either there are no VAPID keys or no phone has subscribed. The `reason` says which |
| `push_shown` | A phone displayed it. This is the only proof it arrived |
| `agent_failed` | The pipeline threw, and you also got a notification saying so |

Also in the log, less often useful:

| Log line | Meaning |
| --- | --- |
| `cleanup` | The hourly sweep, and how many expired rows it deleted |
| `push_subscribed` | A phone stored a subscription |
| `push_ack_rejected` | An ack arrived whose HMAC did not match. Nothing is recorded |
| `rejected` | An API call was turned down. Carries the status, the path and the method |
| `auth_misconfigured` | `AUTH_TOKEN` is not set, so every authenticated call fails closed |
| `unhandled_error` | Something in `fetch` threw that was not an `ApiError` |

## A push failed. Was the subscription pruned?

The difference matters, because pruning the wrong thing unsubscribes phones that
were fine.

- **410, 404, or 400 with a reason of `BadDeviceToken`, `BadWebPushToken`,
  `MissingDeviceToken`, `Unregistered` or `VapidPkHashMismatch`.** That one
  subscription is dead and is deleted; the browser makes a new one the next time
  the app opens. Apple returns 400 for these rather than the 410 the spec
  suggests, and 404 is Mozilla's answer for an unknown endpoint.
- **403, whatever the reason.** Nothing is pruned. A 403 is our own VAPID
  configuration failing, and it fails for every device at once, so pruning on it
  would unsubscribe the whole fleet over one bad setting.

Everything else is left alone as well, and shows up as `web_push_failed` with
the status and reason the push service gave.

## Every phone stopped at once

Changing `VAPID_PUBLIC_KEY` invalidates every subscription made against the old
one. They fail with `VapidPkHashMismatch`, are deleted as dead, and every phone
has to enable notifications again. That is why the deploy reuses the keypair in
`.secrets.json` instead of generating a fresh one on each run, and why a copy of
that file is worth keeping.

## The break line has a time but no scene

The minute count and the cue are validated separately, so the line degrades to
"70 minutes in" rather than disappearing. The `research` log line names the rule
that dropped the cue:

- `cue_rejected` is one of `missing`, `too long`, `too many words`, `spoiler`,
  `site jargon`, `cut off` or `not a clause`.
- `cue` carries the raw text the model offered, so a wrong rejection is visible.
  It is withheld when the reason was `spoiler`, since printing it into the log
  would defeat the point of dropping it, and there is nothing to carry when the
  reason was `missing`.

`missing` means the model offered no cue, which is what it is told to do rather
than spoil the film. Every other reason means it offered one and validation
threw it away; the rules are in
[How it works](how-it-works.md#the-research-answer-is-treated-as-untrusted).

Expect it to vary between runs. Every research call does a fresh web search and
nothing is cached, so the same film can produce a cue one time and not the next.

## A forwarded email produced nothing

If there is no log line at all, not even `email_received`, the Worker was never
invoked. Two things to check, in this order:

- **The email routing rule** still points at the Worker. Renaming the Worker
  breaks it, because the rule names the script. Re-running `npm run deploy`
  repoints an address it created earlier, since the address is recorded in
  `.secrets.json`.
- **DMARC.** Cloudflare rejects inbound mail at SMTP time with
  `550 5.7.1 DMARC checks failed` when the `From:` domain publishes a strict
  policy and the forward broke its alignment. Nothing reaches the Worker and
  there is nothing in the log, because the message was refused at the door. A
  client-side forward usually survives this; a plain re-send of the raw message
  from somewhere else usually does not.

If `email_received` is there but nothing followed, read the next line down. A
`not_a_ticket` means the extraction model read the email cleanly and found no
film in it, and dropping it is deliberate. An `agent_failed` means something
threw, and a notification saying so was sent to your phone.
