import type { Booking } from "./types";

/**
 * Turns a booking and the research lines into the notification you actually
 * see.
 *
 * Line order is the whole design here. A lock screen previews about four lines
 * before it truncates, and the two research lines are the reason this exists,
 * so they come first. The address goes last because it is the line you can
 * afford to lose: you already know where the cinema is, you are driving there.
 */
export function composeNotification(
  booking: Booking,
  researchLines: string[],
): { title: string; body: string } {
  const title = joinParts(["\u{1F37F} " + clean(booking.movie)!, clean(booking.time)]);

  const body = [
    ...researchLines,
    joinParts([
      clean(booking.date),
      clean(booking.theater),
      screenFormat(booking),
      clean(booking.seats),
    ]),
    clean(booking.address),
  ]
    .filter(Boolean)
    .join("\n");

  return { title, body: body || "Tickets booked." };
}

/**
 * IMAX or Dolby is worth saying, because it is a different room in the same
 * building. Cinema names often already end in the format, though, so it is
 * dropped rather than repeated.
 */
function screenFormat(booking: Booking): string | undefined {
  const format = clean(booking.format);
  if (!format) return undefined;
  const theater = clean(booking.theater)?.toLowerCase() ?? "";
  return theater.includes(format.toLowerCase()) ? undefined : format;
}

function joinParts(parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(" · ");
}

/**
 * Extraction models answer "null", "N/A" or "unknown" as often as they omit a
 * field, and those read as real values to anything checking for truthiness.
 */
const NON_ANSWERS = new Set(["null", "undefined", "none", "n/a", "na", "unknown", "-", ""]);

function clean(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return NON_ANSWERS.has(trimmed.toLowerCase()) ? undefined : trimmed || undefined;
}
