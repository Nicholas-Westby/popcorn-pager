import type { Booking, Env } from "./types";

/**
 * Reading the booking out of the email.
 *
 * Workers AI rather than a paid model, because this is the easy half of the
 * job: the answer is all sitting in the text, nothing has to be inferred, and
 * the free daily allowance covers hundreds of emails. The schema is enforced by
 * the runtime rather than asked for in the prompt, so a chatty model cannot
 * produce something unparseable.
 */
const EXTRACTION_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const NULLABLE_STRING = { type: ["string", "null"] };

const BOOKING_SCHEMA = {
  type: "object",
  properties: {
    movie: NULLABLE_STRING,
    format: NULLABLE_STRING,
    runtimeMinutes: { type: ["integer", "null"] },
    date: NULLABLE_STRING,
    time: NULLABLE_STRING,
    theater: NULLABLE_STRING,
    address: NULLABLE_STRING,
    seats: NULLABLE_STRING,
  },
  required: [
    "movie",
    "format",
    "runtimeMinutes",
    "date",
    "time",
    "theater",
    "address",
    "seats",
  ],
};

const SYSTEM_PROMPT = `
Extract the movie-ticket purchase from this confirmation email.

- movie: the film title, without the cinema chain or format tacked on
- format: IMAX, 3D, RPX, Dolby, or similar. Null if it is a standard screening
- runtimeMinutes: the running time as a whole number of minutes
- date: the date of the screening, as written in the email
- time: the start time of the screening, as written in the email
- theater: the name of the cinema
- address: the street address of the cinema
- seats: the seat numbers, comma separated

Use null for anything the email does not say. Do not infer, guess or look
anything up. Copy values as they appear rather than reformatting them.
`.trim();

/**
 * Thrown when the email simply is not a ticket confirmation. Kept separate from
 * a real failure, because the address is public enough that anything could
 * arrive at it, and a stranger's newsletter should not light up your phone.
 */
export class NotATicketError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "NotATicketError";
  }
}

export async function extractBooking(text: string, env: Env): Promise<Booking> {
  const result = (await env.AI.run(EXTRACTION_MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    response_format: { type: "json_schema", json_schema: BOOKING_SCHEMA },
    temperature: 0,
    max_tokens: 800,
  } as never)) as { response?: unknown };

  // A response we cannot even parse is a failure worth waking someone for. A
  // response that parses but names no film is simply not a ticket. Treating
  // both as the second would drop real bookings whenever the model stumbled.
  const parsed = parseModelResponse(result?.response);
  if (!parsed) {
    throw new Error(`extraction returned an unusable response: ${preview(result?.response)}`);
  }

  const booking = normalizeBooking(parsed);
  if (!booking) throw new NotATicketError("the email names no film");
  return booking;
}

/**
 * Exported for testing. The schema makes the shape reliable but not the
 * content, so every field is still checked before it can reach a notification.
 */
export function parseModelResponse(response: unknown): Record<string, unknown> | undefined {
  let data: unknown = response;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  return data as Record<string, unknown>;
}

export function normalizeBooking(response: unknown): Booking | undefined {
  const raw = parseModelResponse(response);
  if (!raw) return undefined;
  const movie = readString(raw.movie);
  if (!movie) return undefined;

  const booking: Booking = { movie };
  for (const field of ["format", "date", "time", "theater", "address", "seats"] as const) {
    const value = readString(raw[field]);
    if (value) booking[field] = value;
  }

  const runtime = Number(raw.runtimeMinutes);
  if (Number.isFinite(runtime) && runtime > 0 && runtime < 600) {
    booking.runtimeMinutes = Math.round(runtime);
  }

  return booking;
}

/** Models answer "null" and "N/A" as often as they omit a field. */
const NON_ANSWERS = new Set(["null", "undefined", "none", "n/a", "na", "unknown", "-", ""]);

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return NON_ANSWERS.has(trimmed.toLowerCase()) ? undefined : trimmed || undefined;
}

function preview(value: unknown): string {
  return (typeof value === "string" ? value : JSON.stringify(value) ?? "").slice(0, 200);
}
