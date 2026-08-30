import { describe, expect, it } from "vitest";
import { readableEmail } from "../src/email";

/**
 * Whatever comes out of here is the entire prompt the extraction model sees, so
 * the tests are about the two halves of that job: the booking details survive
 * intact, and the markup, tracking pixels and attachments wrapped around them do
 * not come with them.
 */

const singlePart = `From: Grand Cinemas <no-reply@cinemas.example.com>
To: owner@example.com
Subject: Your tickets for Materialists
DKIM-Signature: v=1; a=rsa-sha256; d=cinemas.example.com; s=mail; b=cGxlYXNlaWdub3Jl
Received: from mx.cinemas.example.com (mx.cinemas.example.com [203.0.113.7])
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8

Your booking is confirmed.
MATERIALISTS (IMAX)
Seats: F4, F5
`;

// Real mail uses CRLF, and both the header split and the part split have to
// survive it. The boundary is the JavaMail shape, where the delimiter lines end
// up as four leading dashes.
const alternative = `From: Grand Cinemas <no-reply@cinemas.example.com>
To: owner@example.com
Subject: Your tickets for Materialists
Date: Fri, 5 Sep 2026 18:02:11 +0000
Message-ID: <9f2a1c@mx.cinemas.example.com>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="--=_Part_8891_1725559331"

----=_Part_8891_1725559331
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 7bit

Your booking is confirmed.

MATERIALISTS (IMAX)
Fri, Sep 5, 2026 at 7:30 PM
TCL Chinese Theatre
6925 Hollywood Blvd, Los Angeles, CA 90028
Seats: F4, F5
Order #RG-4471902

----=_Part_8891_1725559331
Content-Type: text/html; charset=UTF-8
Content-Transfer-Encoding: 7bit

<html><body><table><tr><td><h1>Your booking is confirmed.</h1></td></tr>
<tr><td>MATERIALISTS (IMAX)</td></tr>
<tr><td>Fri, Sep 5, 2026 at 7:30 PM</td></tr></table>
<img src="https://track.cinemas.example.com/open.gif?id=9f2a1c" width="1" height="1">
</body></html>

----=_Part_8891_1725559331--
`.replace(/\n/g, "\r\n");

const mixed = `From: Vue Cinemas <noreply@myvue.com>
Subject: Your booking
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="OUTER-7712"

--OUTER-7712
Content-Type: multipart/alternative; boundary="INNER-3390"

--INNER-3390
Content-Type: text/plain; charset=UTF-8

Booking reference VUE-88213
ONE BATTLE AFTER ANOTHER
Thu, Sep 11 at 8:00 PM
Vue Westfield, Seats G9 and G10

--INNER-3390
Content-Type: text/html; charset=UTF-8

<div>Booking reference VUE-88213</div><div>ONE BATTLE AFTER ANOTHER</div>

--INNER-3390--

--OUTER-7712
Content-Type: application/pdf; name="tickets.pdf"
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="tickets.pdf"

JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDMgMCBSL0Zp
bHRlci9GbGF0ZURlY29kZT4+CnN0cmVhbQo=

--OUTER-7712--
`;

const spaced = `Content-Type: text/plain

Row F   seat 4\tand\tseat 5\t

    Screen 3

IMAX
`;

describe("readableEmail", () => {
  it("drops the headers and keeps the body of a plain-text email", () => {
    const text = readableEmail(singlePart);
    expect(text).toBe("Your booking is confirmed.\nMATERIALISTS (IMAX)\nSeats: F4, F5");
    expect(text).not.toContain("DKIM-Signature");
    expect(text).not.toContain("mx.cinemas.example.com");
    expect(text).not.toContain("Subject:");
  });

  it("returns the plain-text part of a multipart/alternative confirmation", () => {
    expect(readableEmail(alternative).split("\n")).toEqual([
      "Your booking is confirmed.",
      "MATERIALISTS (IMAX)",
      "Fri, Sep 5, 2026 at 7:30 PM",
      "TCL Chinese Theatre",
      "6925 Hollywood Blvd, Los Angeles, CA 90028",
      "Seats: F4, F5",
      "Order #RG-4471902",
    ]);
  });

  it("spends none of the prompt on the HTML half of the same email", () => {
    const text = readableEmail(alternative);
    expect(text).not.toMatch(/<[^>]+>/);
    expect(text).not.toContain("track.cinemas.example.com");
  });

  it("finds the plain text nested inside a multipart/mixed with an attachment", () => {
    const text = readableEmail(mixed);
    expect(text.split("\n")).toEqual([
      "Booking reference VUE-88213",
      "ONE BATTLE AFTER ANOTHER",
      "Thu, Sep 11 at 8:00 PM",
      "Vue Westfield, Seats G9 and G10",
    ]);
    expect(text).not.toContain("JVBERi0xLjQ");
  });

  it("collapses blank lines and runs of spaces and tabs", () => {
    expect(readableEmail(spaced)).toBe("Row F seat 4 and seat 5\nScreen 3\nIMAX");
  });

  it("caps the output well short of the model's context", () => {
    const long = `Content-Type: text/plain\n\n${"Row A, seat 1.\n".repeat(4000)}`;
    expect(long.length).toBeGreaterThan(24_000);
    expect(readableEmail(long)).toHaveLength(24_000);
  });
});

describe("readableEmail, on an HTML-only email", () => {
  const htmlOnly = `From: AMC Theatres <tickets@amctheatres.com>
Subject: Your AMC ticket confirmation
MIME-Version: 1.0
Content-Type: text/html; charset=UTF-8

<html><head><title>AMC Confirmation</title><style>.ticket{color:#f00}</style></head>
<body>
<script>window.__track = 'pixelbeacon';</script>
<h1>Sinners &amp; Friends</h1>
<p>Sat, Sep 6&#183; 8:40 PM</p>
<div>Tonight&#39;s seats:&nbsp;H7, H8</div>
<style>.footer{display:none}</style>
<p>AMC Century City 15</p>
</body></html>
`;

  it("keeps the visible text and strips the tags around it", () => {
    const text = readableEmail(htmlOnly);
    expect(text.split("\n")).toEqual([
      "Sinners & Friends",
      "Sat, Sep 6· 8:40 PM",
      "Tonight's seats: H7, H8",
      "AMC Century City 15",
    ]);
    expect(text).not.toMatch(/<[^>]+>/);
  });

  it("does not hand the model the contents of a script or style block", () => {
    const text = readableEmail(htmlOnly);
    expect(text).not.toContain("pixelbeacon");
    expect(text).not.toContain("color:#f00");
    expect(text).not.toContain("display:none");
    expect(text).not.toContain("AMC Confirmation");
  });

  it("decodes the entities a ticket email actually uses", () => {
    const text = readableEmail(htmlOnly);
    expect(text).toContain("Sinners & Friends");
    expect(text).toContain("Tonight's seats");
    expect(text).not.toMatch(/&(amp|nbsp|#\d+);/);
  });
});

describe("readableEmail, decoding transfer encodings", () => {
  const quotedPrintable = `From: Cineworld <noreply@cineworld.co.uk>
Subject: Booking confirmation
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: quoted-printable

Tonight=E2=80=99s screening is confirmed.
Your seats are J12 and =
J13.
Doors open at 6:45=C2=A0PM.
`;

  // 76-column wrapping is what a mail transport does to a base64 part, and the
  // decoder has to put the lines back together before it can read the UTF-8.
  const base64 = `From: Odeon <noreply@odeon.co.uk>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="ODEON-42"

--ODEON-42
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: base64

WW91ciBib29raW5nIGlzIGNvbmZpcm1lZC4KCk1BVEVSSUFMSVNUUyDigJQg
SU1BWApTYXQsIFNlcCA2IGF0IDc6MTUgUE0KU2VhdHM6IEoxMiwgSjEzCg==

--ODEON-42--
`;

  it("rejoins quoted-printable soft line breaks and decodes its escapes", () => {
    expect(readableEmail(quotedPrintable).split("\n")).toEqual([
      "Tonight’s screening is confirmed.",
      "Your seats are J12 and J13.",
      "Doors open at 6:45\u00A0PM.",
    ]);
  });

  it("decodes a base64 part back to its UTF-8 text", () => {
    expect(readableEmail(base64).split("\n")).toEqual([
      "Your booking is confirmed.",
      "MATERIALISTS — IMAX",
      "Sat, Sep 6 at 7:15 PM",
      "Seats: J12, J13",
    ]);
  });
});

describe("readableEmail, on input it cannot parse", () => {
  // A forwarded email is whatever arrived at the worker's address, so this is
  // reached by anyone who can send mail. It has to return something rather than
  // throw, however little sense the input makes.
  it("returns nothing for an empty email or one with no body at all", () => {
    expect(readableEmail("")).toBe("");
    expect(readableEmail("Subject: hi\r\nFrom: sender@example.com")).toBe("");
  });

  it("reads what it can from a multipart cut off before its closing boundary", () => {
    const truncated = `Content-Type: multipart/alternative; boundary="B1"

--B1
Content-Type: text/plain; charset=UTF-8

Your seats are F4 and F5.`;
    expect(readableEmail(truncated)).toBe("Your seats are F4 and F5.");
  });

  it("falls back to the raw body when a multipart stops mid-part", () => {
    const truncated = `Content-Type: multipart/alternative; boundary="B1"

--B1
Content-Type: text/pl`;
    expect(() => readableEmail(truncated)).not.toThrow();
    expect(readableEmail(truncated)).toContain("Content-Type: text/pl");
  });
});

describe("readableEmail, on the shapes that used to defeat it", () => {
  it("ignores a text/plain attachment and keeps the real body", () => {
    // A calendar invite is text/plain too. Picking it over the booking would
    // send the model a VCALENDAR block instead of the ticket.
    const raw = [
      "From: tickets@cinemas.example.com",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Dune: Part Three",
      "7:30 PM, seats F4 and F5",
      "--outer",
      'Content-Type: text/plain; charset=utf-8; name="invite.ics"',
      'Content-Disposition: attachment; filename="invite.ics"',
      "",
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "END:VCALENDAR",
      "--outer--",
    ].join("\n");

    const text = readableEmail(raw);
    expect(text).toContain("Dune: Part Three");
    expect(text).toContain("seats F4 and F5");
    expect(text).not.toContain("VCALENDAR");
  });

  it("decodes the named and hex entities ticket emails actually use", () => {
    // A raw &rsquo; in a film title would otherwise end up on the lock screen.
    const raw = [
      "Content-Type: text/html",
      "",
      "<p>Sat, Sep 6 &middot; 8:40 PM &mdash; Tonight&rsquo;s show &#x27;IMAX&quot;</p>",
      "<p>TCL Chinese Theatre &nbsp;&#8226; 90&deg;</p>",
    ].join("\n");

    const text = readableEmail(raw);
    expect(text).toContain("Sat, Sep 6 · 8:40 PM — Tonight’s show 'IMAX\"");
    expect(text).toContain("TCL Chinese Theatre • 90°");
    expect(text).not.toMatch(/&[a-zA-Z#][a-zA-Z0-9]*;/);
  });

  it("does not decode an entity twice", () => {
    const raw = ["Content-Type: text/html", "", "<p>Literally &amp;#39; here</p>"].join("\n");
    expect(readableEmail(raw)).toBe("Literally &#39; here");
  });

  it("splits on the right boundary when one is a prefix of the other", () => {
    // Apple Mail nests boundaries like this, and an unanchored split would cut
    // the inner parts apart at the wrong places.
    const raw = [
      'Content-Type: multipart/mixed; boundary="Apple-Mail-1"',
      "",
      "--Apple-Mail-1",
      'Content-Type: multipart/alternative; boundary="Apple-Mail-1-alt"',
      "",
      "--Apple-Mail-1-alt",
      "Content-Type: text/plain",
      "",
      "Sinners at the Grand Illusion, row C",
      "--Apple-Mail-1-alt--",
      "",
      "--Apple-Mail-1--",
    ].join("\n");

    expect(readableEmail(raw)).toBe("Sinners at the Grand Illusion, row C");
  });

  it("skips a part that is neither text nor HTML", () => {
    const raw = [
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: application/pdf",
      "",
      "%PDF-1.4 binary junk",
      "--b",
      "Content-Type: text/plain",
      "",
      "Weapons, 9:15 PM",
      "--b--",
    ].join("\n");

    const text = readableEmail(raw);
    expect(text).toBe("Weapons, 9:15 PM");
    expect(text).not.toContain("PDF");
  });
});

describe("readableEmail, on a boundary that is not a boundary", () => {
  it("ignores boundary= in a header that is not the Content-Type", () => {
    // An X-Mailer version string containing "boundary=" used to turn a
    // single-part email into a multipart one, and the split then ate the first
    // paragraph, which is usually the film title.
    const raw = [
      "From: tickets@cinemas.example.com",
      "X-Mailer: SendGrid (boundary=zz)",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "MATERIALISTS (IMAX)",
      "Fri, Sep 5 at 7:30 PM",
      "Seats: F4, F5",
    ].join("\n");

    expect(readableEmail(raw).split("\n")).toEqual([
      "MATERIALISTS (IMAX)",
      "Fri, Sep 5 at 7:30 PM",
      "Seats: F4, F5",
    ]);
  });

  it("still finds the boundary when the Content-Type is folded over two lines", () => {
    const raw = [
      "From: tickets@cinemas.example.com",
      "Content-Type: multipart/alternative;",
      '\tboundary="fold-1"',
      "",
      "--fold-1",
      "Content-Type: text/plain",
      "",
      "Weapons, 9:15 PM",
      "--fold-1--",
    ].join("\n");

    expect(readableEmail(raw)).toBe("Weapons, 9:15 PM");
  });
});
