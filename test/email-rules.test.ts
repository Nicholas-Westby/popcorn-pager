import { describe, expect, it } from "vitest";
import { ruleAddress, ruleBody, targetsWorker, type EmailRule } from "../scripts/email-rules";

/**
 * These three functions decide which Email Routing rules belong to this
 * deployment. `reset.ts` deletes what they match, on an account that has other
 * domains and other Workers on it, so a rule that matches too eagerly costs
 * somebody their mail. Every case below is about the boundary.
 */

const rule = (over: Partial<EmailRule> = {}): EmailRule => ({
  tag: "abc123",
  enabled: true,
  matchers: [{ type: "literal", field: "to", value: "tickets-aa11@example.com" }],
  actions: [{ type: "worker", value: ["popcorn-pager"] }],
  ...over,
});

describe("targetsWorker", () => {
  it("matches a rule that delivers to this Worker", () => {
    expect(targetsWorker(rule(), "popcorn-pager")).toBe(true);
  });

  it("matches a disabled rule, because it is still this deployment's", () => {
    // Leaving a disabled rule behind is how you get a second inbox on the next
    // deploy, so reset has to find it too.
    expect(targetsWorker(rule({ enabled: false }), "popcorn-pager")).toBe(true);
  });

  it("does not match a Worker whose name merely starts the same", () => {
    // The case that matters: resetting "popcorn-pager" must not touch the
    // rule belonging to "popcorn-pager-test", or the reverse.
    expect(targetsWorker(rule(), "popcorn-pager-test")).toBe(false);
    expect(
      targetsWorker(rule({ actions: [{ type: "worker", value: ["popcorn-pager-test"] }] }), "popcorn-pager"),
    ).toBe(false);
  });

  it("ignores rules that forward to a person rather than a Worker", () => {
    expect(
      targetsWorker(rule({ actions: [{ type: "forward", value: ["popcorn-pager"] }] }), "popcorn-pager"),
    ).toBe(false);
    expect(targetsWorker(rule({ actions: [{ type: "drop", value: [] }] }), "popcorn-pager")).toBe(false);
  });

  it("finds the Worker among several actions", () => {
    const many = rule({
      actions: [
        { type: "forward", value: ["someone@example.com"] },
        { type: "worker", value: ["another-worker", "popcorn-pager"] },
      ],
    });
    expect(targetsWorker(many, "popcorn-pager")).toBe(true);
  });

  it("survives the shapes the API can hand back", () => {
    expect(targetsWorker(rule({ actions: undefined }), "popcorn-pager")).toBe(false);
    expect(targetsWorker(rule({ actions: [] }), "popcorn-pager")).toBe(false);
    expect(targetsWorker(rule({ actions: [{ type: "worker" }] }), "popcorn-pager")).toBe(false);
    // A bare string instead of a list is still compared whole, never by prefix.
    const bare = { ...rule(), actions: [{ type: "worker", value: "popcorn-pager" }] } as unknown as EmailRule;
    expect(targetsWorker(bare, "popcorn-pager")).toBe(true);
    expect(targetsWorker(bare, "popcorn")).toBe(false);
  });

  it("never matches an empty Worker name", () => {
    // A misread wrangler.jsonc must delete nothing rather than everything.
    expect(targetsWorker(rule({ actions: [{ type: "worker", value: [""] }] }), "")).toBe(false);
  });
});

describe("ruleAddress", () => {
  it("reads the address the rule catches", () => {
    expect(ruleAddress(rule())).toBe("tickets-aa11@example.com");
  });

  it("ignores a catch-all, which has no address to report", () => {
    expect(ruleAddress(rule({ matchers: [{ type: "all" }] }))).toBeUndefined();
    expect(ruleAddress(rule({ matchers: [] }))).toBeUndefined();
    expect(ruleAddress(rule({ matchers: undefined }))).toBeUndefined();
    expect(ruleAddress(rule({ matchers: [{ type: "literal", value: "" }] }))).toBeUndefined();
  });
});

describe("ruleBody", () => {
  it("builds a rule that deploy and reset both recognise", () => {
    const body = ruleBody("tickets-bb22@example.com", "popcorn-pager");
    expect(targetsWorker(body, "popcorn-pager")).toBe(true);
    expect(ruleAddress(body)).toBe("tickets-bb22@example.com");
    expect(body.enabled).toBe(true);
  });
});
