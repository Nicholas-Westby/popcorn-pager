import { composeNotification } from "./compose";
import { readableEmail } from "./email";
import { extractBooking, NotATicketError } from "./extract";
import { notify } from "./notify";
import { researchFilm } from "./research";
import type { Env } from "./types";

/**
 * The whole point of the thing: a ticket confirmation lands, and a minute later
 * your phone tells you when the best moment to step out is and whether to sit
 * through the credits.
 *
 * Nothing in here is allowed to throw. An error out of an email handler bounces
 * the message back to the sender, and the booking is then gone for good, so a
 * failure becomes a notification of its own instead.
 */
/** Ten times the largest confirmation email worth reading. */
const MAX_RAW_CHARS = 2_000_000;

export async function handleTicketEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const started = Date.now();

  try {
    // Email Routing accepts up to 25 MB, and parsing a message that size makes
    // several full copies of it. Running out of memory is not catchable here,
    // and an uncatchable failure bounces the email, which is the one outcome
    // this handler exists to avoid. No confirmation is anywhere near this big.
    const raw = (await new Response(message.raw).text()).slice(0, MAX_RAW_CHARS);
    const text = readableEmail(raw);
    console.log({
      event: "email_received",
      from: message.from,
      raw_bytes: message.rawSize,
      chars: text.length,
    });

    const booking = await extractBooking(text, env);
    console.log({
      event: "booking_extracted",
      movie: booking.movie,
      theater: booking.theater,
      runtime: booking.runtimeMinutes,
    });

    const research = await researchFilm(env, booking.movie, booking.runtimeMinutes);
    const { title, body } = composeNotification(booking, research);

    const result = await notify(env, { title, body });
    console.log({
      event: "ticket_notified",
      movie: booking.movie,
      researched: research.length > 0,
      delivered: result.delivered,
      status: result.status,
      ms: Date.now() - started,
    });
  } catch (err) {
    if (err instanceof NotATicketError) {
      // Not a failure worth waking anyone for. The address is unguessable but
      // not secret, and a newsletter that lands here should be dropped quietly.
      console.warn({ event: "not_a_ticket", from: message.from, reason: err.message });
      return;
    }

    console.error({ event: "agent_failed", error: String(err), stack: (err as Error)?.stack });

    // Best effort. If even this fails there is nothing left to try, and the
    // error is already in the log.
    await notify(env, {
      title: "\u{1F37F} PopcornPager could not read that email",
      body: String((err as Error)?.message ?? err).slice(0, 300),
    }).catch(() => {});
  }
}
