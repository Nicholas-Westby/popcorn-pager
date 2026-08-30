# How it works

The path a forwarded ticket confirmation takes from your inbox to your lock
screen, and the reasoning behind each step.

[← README](../README.md)

## One Worker, three handlers

The whole deployment is one Cloudflare Worker and one D1 database.

| Handler | What it does |
| --- | --- |
| `fetch` | Serves the web app, the service worker, the manifest, the icon and a small API |
| `email` | Runs the pipeline below, once per forwarded confirmation |
| `scheduled` | Deletes expired notifications, once an hour |

D1 holds two tables and no more: the notifications that have been sent, so the
app can show you what it already told you, and the phones that have agreed to be
pushed to.

## From email to phone

| | What happens | Where |
| --- | --- | --- |
| 1 | Cloudflare Email Routing hands the forwarded confirmation to the `email` handler | `src/index.ts` |
| 2 | The MIME document is reduced to readable text: the plain-text part if there is one, otherwise stripped HTML, skipping attachments | `src/email.ts` |
| 3 | Workers AI reads the booking out of that text, against a JSON schema the runtime enforces | `src/extract.ts` |
| 4 | Claude searches the web for the film and answers with a break minute, a cue, and whether there are extra scenes | `src/research.ts` |
| 5 | Booking and research become a title and up to four body lines | `src/compose.ts` |
| 6 | The notification is stored in D1, then encrypted once per subscription and posted to the push service | `src/notify.ts`, `src/webpush.ts` |
| 7 | The service worker displays it and posts back to `/api/ack` | `src/app.ts` |

Step 2 is not a general MIME parser and does not try to be; it handles what
cinema chains actually send. A calendar invite is `text/plain` too, so
attachments are skipped rather than picked over the booking.

Two size caps sit in front of it. The raw message is cut at 2,000,000
characters and the readable text at 24,000. Email Routing accepts up to 25 MB,
and parsing a message that size makes several full copies of it; running out of
memory is not catchable, and an uncatchable failure bounces the email.

That is the rule the handler is built around: nothing in it may throw, because
an error out of an email handler bounces the message back to the sender and the
booking is gone for good. A failure becomes a notification of its own instead.
The exception is an email that parses but names no film. That is logged as
`not_a_ticket` and dropped without notifying, because the address is unguessable
but not secret, and a stranger's newsletter should not light up your phone.

## Nothing between the Worker and the phone

Web Push is implemented here by hand, in `src/webpush.ts`, against three RFCs:

| RFC | What it covers |
| --- | --- |
| RFC 8291 | Message encryption: ECDH, HKDF, AES-128-GCM |
| RFC 8188 | The `aes128gcm` content coding that wraps it |
| RFC 8292 | VAPID, the identity the push service checks |

The push service, Apple's in the case of an iPhone, only ever carries
ciphertext. It cannot read the title or the body. There is no third-party
notification service in the path and no account with one to keep.

A fresh ECDH keypair is generated per message, as RFC 8291 requires. The VAPID
token is the one thing cached: one signed token per push service, good for
twelve hours and re-signed an hour before it expires. Apple asks callers not to
re-sign more than once an hour, and there is no reason to, since the token says
nothing about the message.

## The ack, and why two log lines are not the same

Step 7 exists because Apple answers `201 Created` even for a subscription that
no longer works. Without a report from the phone, an accepted push and a
displayed notification are indistinguishable from the Worker.

| Log line | What it proves |
| --- | --- |
| `web_push_accepted` | The push service took the message. That is all |
| `push_shown` | A phone displayed it. This is the only proof it arrived |

The ack the service worker presents is an HMAC of the endpoint and the
notification id, keyed by `AUTH_TOKEN`. It rides inside the encrypted payload,
so only the real subscriber can produce one, and the server re-derives it rather
than storing anything. That is why `/api/ack` takes no bearer token.

A service worker that failed to display the notification acks with
`shown: false`, which is recorded as an error against the subscription rather
than as a delivery. That case is the reason the mechanism exists, so it must not
be counted as a success.

## Why the lines are in that order

```
🍿 Dune: Part Three · 7:30 PM
🚽 Best break: 70 minutes in, when the snow appears
🎬 Post-credits scene
Sat, Sep 5 · TCL Chinese Theatre · F4, F5
6925 Hollywood Blvd, Los Angeles, CA 90028
```

A lock screen previews about four lines before it truncates, so the order is a
ranking rather than a layout:

| Line | Why it is there |
| --- | --- |
| Film and start time, as the title | Says what the notification is about |
| Break | The line you act on during the film, and the reason this exists |
| Extra scenes | Acted on at the end, so it comes second |
| Date, cinema, screen format, seats | What you want on arrival |
| Address | Last, because it is the line you can afford to lose: you already know where the cinema is, you are driving there |

IMAX or Dolby is worth saying, because it is a different room in the same
building, but cinema names often already end in the format, so it is dropped
rather than repeated. Extraction models answer "null", "N/A" or "unknown" as
often as they omit a field, and those read as real values to anything checking
for truthiness, so every part is filtered against a small list of non-answers
before it can reach a line.

## The two models

| | Model | Cost |
| --- | --- | --- |
| Extraction | Workers AI, `@cf/meta/llama-3.1-8b-instruct-fast` | The free daily allowance covers hundreds of emails |
| Research | `anthropic/claude-sonnet-4.6` through Cloudflare AI Gateway, with the server-side web search tool | Billed against prepaid credits on your Cloudflare account. Web search is billed per search and is the dominant cost, so the tool is capped at four searches per film |

Extraction is the easy half. The answer is already sitting in the email, nothing
has to be inferred, and the schema is enforced by the runtime rather than asked
for in the prompt, so a chatty model cannot produce something unparseable.

Research is the half the email cannot answer, and it needs a model that can
search, read, and refuse to guess. It goes out over the same `AI` binding, which
forwards any `author/model` string to AI Gateway at runtime. There is one
provider to set up: the inference is billed to the same Cloudflare account as
everything else, there is no separate API key to manage, and the gateway creates
itself on the first request. Without credits on the account, research quietly
returns nothing and the notification still goes out with the booking details,
which is most of the value.

A long search turn can pause and ask to be continued. The call hands the
assistant's own message back unchanged and carries on, up to twice; without that
the answer is silently truncated.

## The research answer is treated as untrusted

Nothing the model says is printed as it arrives. This notification reaches you
before the film, so a stray sentence on the lock screen ruins the thing you
bought a ticket for. Anything that fails validation is dropped rather than
shown, because a missing line is better than a wrong or spoiling one. The rules
are in `src/research.ts`.

The reply is expected to be a JSON object. It is pulled out of the surrounding
text by finding the first `{` and the last `}`, so a preamble, trailing chatter
or a code fence around it costs nothing, and a refusal or an apology parses as
nothing at all. Text blocks are searched newest first, so the answer is found
by content rather than by position, whichever version of the search tool is in
play.

| Field | Rule |
| --- | --- |
| `creditsScenes` | Reduced to letters, then matched against a fixed four-value vocabulary (`mid`, `post`, `both`, `none`) and printed from a label table. The model's own words never reach the screen, so a description of a scene cannot leak through. A leading negation is excluded, so "no mid or post credits scenes" is not read as both |
| `breakStartMinutes` | Read as a whole number of minutes and required to fall between 1 and 400. A string that opens with a number is accepted, because models answer "70 minutes in" despite being asked for a number |
| `breakCue` | Normalised, then put through the seven checks below. The survivor gets a lowercase first letter, because it is printed straight after "70 minutes in, " |

Normalising a cue means collapsing whitespace, trimming, and stripping
surrounding quotes and trailing punctuation. Then, in this order:

| Rejection | Rule |
| --- | --- |
| `missing` | Not a string, or nothing left after normalising |
| `too long` | Over 45 characters |
| `too many words` | Over 7 words |
| `spoiler` | Matches the deny-list: `dies`, `kills`, `reveals`, `betrays`, `twist`, `unmasked`, `survives`, `villain`, `traitor`, `ending` and friends |
| `site jargon` | Matches `peetime`, `pee times` or `runpee`. RunPee is the best source for this and the model reads its pages, so it sometimes answers in RunPee's own vocabulary, and "when the third peetime begins" is not a cue anyone can act on |
| `cut off` | Ends on a dangling preposition or article, which reads as broken |
| `not a clause` | Does not open with `when`, `while`, `during`, `as`, `once`, `after` or `before`, the last two optionally as `right after` or `just before`. The cue is printed mid-sentence, so a noun phrase reads as gibberish, and requiring an opener checks that without trying to parse English |

The two halves of the break line are validated separately, so a usable minute
count survives a cue that does not, and the line degrades to "70 minutes in"
rather than disappearing.

When a cue is thrown away the reason is logged, and so is the text, except when
the reason was a spoiler. Without that, "the model said nothing" and "we threw
away something perfectly good" look identical from the outside, and the second
is a bug you would never find. See
[Troubleshooting](troubleshooting.md#the-break-line-has-a-time-but-no-scene).

Be honest about what the caps buy. They keep a paragraph of plot off the lock
screen, but "when the dog dies" is four words and fits, which is what the
deny-list is for. The prompt is still the main defence.
