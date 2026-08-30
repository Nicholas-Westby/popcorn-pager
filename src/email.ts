/**
 * Getting readable text out of a raw email.
 *
 * A ticket confirmation is a multipart MIME document: a short plain-text part,
 * a long HTML part full of tracking pixels and layout tables, and often a
 * calendar invite or a PDF attached. Handing all of that to the extraction
 * model wastes most of the prompt on markup, so this picks the plain-text part
 * when there is one and falls back to stripping the HTML.
 *
 * This is not a general MIME parser and does not try to be. It handles what
 * cinema chains actually send.
 */

/** Well beyond any confirmation email, and far inside the model's context. */
const MAX_CHARS = 24_000;

interface Parts {
  plain?: string;
  html?: string;
}

export function readableEmail(raw: string): string {
  const { headers, body } = splitHeaders(raw);
  const found = collect(headers, body);
  // Plain text first, then stripped HTML, then whatever is left. The last case
  // covers an email malformed enough that none of the above matched.
  return collapse(found.plain || found.html || body).slice(0, MAX_CHARS);
}

function splitHeaders(raw: string): { headers: string; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const blank = normalized.indexOf("\n\n");
  if (blank === -1) return { headers: normalized, body: "" };
  return { headers: normalized.slice(0, blank), body: normalized.slice(blank + 2) };
}

/**
 * Walks a part, and any parts nested inside it, gathering the best plain-text
 * and HTML bodies it can find. Attachments are skipped: a calendar invite is
 * `text/plain` too, and picking it over the booking would send the model a
 * VCALENDAR block instead of the ticket.
 */
function collect(headers: string, body: string): Parts {
  const boundary = multipartBoundary(headers);

  if (boundary) {
    // Boundaries only count at the start of a line. Anchoring also stops an
    // outer boundary from splitting on a nested one that begins with it.
    const parts = body.split(new RegExp(`^--${escapeRegExp(boundary)}(?:--)?[ \\t]*$`, "m"));

    const found: Parts = {};
    for (const part of parts) {
      const { headers: partHeaders, body: partBody } = splitHeaders(part);
      if (!partBody.trim()) continue;
      if (/content-disposition:\s*attachment/i.test(partHeaders)) continue;

      const nested = collect(partHeaders, partBody);
      found.plain ??= nested.plain;
      found.html ??= nested.html;
    }
    return found;
  }

  const type = /content-type:\s*([^;\s]+)/i.exec(headers)?.[1]?.toLowerCase();
  const decoded = decodeBody(headers, body);

  if (type === "text/html") return { html: stripHtml(decoded) };
  // No Content-Type at all means a plain single-part email.
  if (!type || type === "text/plain") return { plain: decoded };
  return {};
}

/**
 * The boundary is only meaningful inside a multipart Content-Type. Scanning the
 * whole header block instead would let any header that happens to contain
 * `boundary=`, an X-Mailer version string for instance, turn a single-part
 * email into a multipart one and silently eat its first paragraph.
 */
function multipartBoundary(headers: string): string | undefined {
  // Header values fold onto continuation lines, which begin with whitespace.
  const contentType = /^content-type:[ \t]*([^\n]*(?:\n[ \t]+[^\n]*)*)/im.exec(headers)?.[1];
  if (!contentType || !/^\s*multipart\//i.test(contentType)) return undefined;
  return /boundary="?([^";\n]+)"?/i.exec(contentType)?.[1]?.trim();
}

function decodeBody(headers: string, body: string): string {
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    return decodeQuotedPrintable(body);
  }
  if (/content-transfer-encoding:\s*base64/i.test(headers)) {
    try {
      const bytes = Uint8Array.from(atob(body.replace(/\s+/g, "")), c => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      return body;
    }
  }
  return body;
}

function decodeQuotedPrintable(value: string): string {
  const joined = value.replace(/=\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i += 1) {
    const char = joined[i]!;
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // Everything a mail transport leaves unencoded is already ASCII.
      bytes.push(char.charCodeAt(0) & 0xff);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * The named entities that actually turn up in ticket emails. A film title with
 * a raw `&rsquo;` in it would otherwise end up on the lock screen that way.
 */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  middot: "·", bull: "•", ndash: "–", mdash: "—",
  hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“",
  rdquo: "”", trade: "™", reg: "®", copy: "©",
  deg: "°", times: "×", eacute: "é", ouml: "ö",
};

function decodeEntities(text: string): string {
  // One pass over both forms, so `&amp;#39;` decodes once rather than twice.
  return text.replace(/&(#[Xx]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] !== "#") return ENTITIES[body.toLowerCase()] ?? match;
    const hex = body[1] === "x" || body[1] === "X";
    const code = hex ? parseInt(body.slice(2), 16) : Number(body.slice(1));
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  });
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/?(p|div|tr|br|h[1-6]|li|table)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function collapse(text: string): string {
  return text
    .split("\n")
    .map(line => line.replace(/[ \t]+/g, " ").trim())
    .filter(line => line !== "")
    .join("\n")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
