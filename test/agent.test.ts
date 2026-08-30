import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { clearNotifications, clearSubscriptions } from "./helpers";

/**
 * The email handler's one hard rule is that it never throws. An error out of it
 * bounces the message back to the sender, and the booking is then gone for
 * good, so every failure has to turn into something else: a notification, or a
 * log line, but never an exception.
 */

const TICKET = [
  "Message-ID: <fd1@fandango.com>",
  "From: Fandango <no-reply@fandango.com>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "DUNE: PART THREE",
  "2 hr 46 min",
  "TCL Chinese Theatre",
  "Saturday, September 5, 2026",
  "7:30 PM",
  "Reserved Seating: F4, F5",
].join("\n");

const BOOKING = {
  movie: "Dune: Part Three",
  format: null,
  runtimeMinutes: 166,
  date: "Saturday, September 5, 2026",
  time: "7:30 PM",
  theater: "TCL Chinese Theatre",
  address: null,
  seats: "F4, F5",
};

function emailMessage(raw = TICKET): ForwardableEmailMessage {
  return {
    from: "no-reply@fandango.com",
    to: "tickets@example.com",
    raw: new Response(raw).body!,
    rawSize: new TextEncoder().encode(raw).length,
    headers: new Headers(),
    setReject: () => {},
    forward: async () => {},
    reply: async () => {},
  } as unknown as ForwardableEmailMessage;
}

/**
 * Stands in for the Workers AI binding. `run` is a real method so that a caller
 * pulling it off the object loses `this`, exactly as the live binding does.
 */
function stubAi(handlers: {
  extract?: () => unknown;
  research?: () => unknown;
}) {
  const calls: { model: string; inputs: Record<string, unknown> }[] = [];
  const ai = {
    run(this: unknown, model: string, inputs: Record<string, unknown>) {
      if (this !== ai) throw new TypeError("Cannot set properties of undefined (setting '#options')");
      calls.push({ model, inputs });
      const handler = model.startsWith("@cf/") ? handlers.extract : handlers.research;
      if (!handler) throw new Error(`unexpected model ${model}`);
      return Promise.resolve(handler());
    },
  };
  return { ai, calls };
}

const envWith = (ai: unknown) => ({ ...env, AI: ai, ANTHROPIC_API_KEY: undefined });

async function stored() {
  const { results } = await env.DB.prepare(
    "SELECT title, body FROM notifications ORDER BY seq DESC",
  ).all<{ title: string; body: string }>();
  return results;
}

beforeEach(async () => {
  await clearNotifications();
  await clearSubscriptions();
});
afterEach(() => vi.unstubAllGlobals());

describe("the email handler", () => {
  it("turns a ticket into a notification", async () => {
    const { ai, calls } = stubAi({
      extract: () => ({ response: BOOKING }),
      research: () => ({
        content: [
          {
            type: "text",
            text: '{"creditsScenes":"post","breakStartMinutes":70,"breakCue":"when the snow appears"}',
          },
        ],
      }),
    });

    await worker.email!(emailMessage(), envWith(ai) as never);

    expect(calls[0]!.model).toBe("@cf/meta/llama-3.1-8b-instruct-fast");
    // The schema is enforced by the runtime rather than asked for in the prompt.
    expect(calls[0]!.inputs.response_format).toMatchObject({ type: "json_schema" });

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("\u{1F37F} Dune: Part Three · 7:30 PM");
    expect(rows[0]!.body.split("\n")).toEqual([
      "\u{1F6BD} Best break: 70 minutes in, when the snow appears",
      "\u{1F3AC} Post-credits scene",
      "Saturday, September 5, 2026 · TCL Chinese Theatre · F4, F5",
    ]);
  });

  it("calls the AI binding as a method, so it keeps its `this`", async () => {
    // The live binding uses private class fields. Pulling `run` off the object
    // throws a TypeError that only shows up in production, which has happened.
    const { ai } = stubAi({ extract: () => ({ response: BOOKING }), research: () => ({ content: [] }) });
    await worker.email!(emailMessage(), envWith(ai) as never);

    const rows = await stored();
    expect(rows[0]!.title).toContain("Dune");
  });

  it("still sends the booking when the research call fails", async () => {
    const { ai } = stubAi({
      extract: () => ({ response: BOOKING }),
      research: () => {
        throw new Error("gateway exploded");
      },
    });

    await worker.email!(emailMessage(), envWith(ai) as never);

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain("Dune");
    expect(rows[0]!.body).not.toContain("Best break");
  });

  it("notifies you when extraction returns something unusable", async () => {
    // A truncated or chatty response is the model failing, not a stranger's
    // newsletter, and losing a real booking to it silently is the worst case.
    const { ai } = stubAi({ extract: () => ({ response: "I'm sorry, I can't" }) });

    await worker.email!(emailMessage(), envWith(ai) as never);

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain("could not read that email");
  });

  it("notifies you when the model throws", async () => {
    const { ai } = stubAi({
      extract: () => {
        throw new Error("Workers AI is down");
      },
    });

    await worker.email!(emailMessage(), envWith(ai) as never);

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain("could not read that email");
    expect(rows[0]!.body).toContain("Workers AI is down");
  });

  it("drops an email that parses fine but names no film", async () => {
    // The address is unguessable but not secret. A newsletter that finds it
    // must not be able to put anything on the lock screen.
    const { ai } = stubAi({ extract: () => ({ response: { ...BOOKING, movie: null } }) });

    await worker.email!(emailMessage("Subject: 20% off\n\nBig sale!"), envWith(ai) as never);

    expect(await stored()).toHaveLength(0);
  });

  it("never throws, even when storing the notification also fails", async () => {
    const { ai } = stubAi({
      extract: () => {
        throw new Error("first failure");
      },
    });
    const broken = {
      ...envWith(ai),
      DB: { prepare: () => { throw new Error("D1 is gone"); } },
    };

    await expect(worker.email!(emailMessage(), broken as never)).resolves.toBeUndefined();
  });

  it("does not read an unbounded amount of a huge message", async () => {
    // Email Routing accepts up to 25 MB. Running out of memory is not catchable
    // here, and an uncatchable failure bounces the email.
    let sawChars = 0;
    const { ai } = stubAi({
      extract: () => {
        throw new Error("stop here");
      },
    });
    const counting = {
      run(this: unknown, model: string, inputs: { messages: { content: string }[] }) {
        sawChars = inputs.messages[1]!.content.length;
        return (ai.run as never as typeof ai.run).call(this, model, inputs as never);
      },
    };

    await worker.email!(
      emailMessage(`Content-Type: text/plain\n\n${"x".repeat(3_000_000)}`),
      envWith(counting) as never,
    );

    expect(sawChars).toBeLessThanOrEqual(24_000);
  });
});
