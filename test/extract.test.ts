import { describe, expect, it } from "vitest";
import { normalizeBooking } from "../src/extract";

/**
 * The response schema fixes the shape of what the extraction model returns but
 * not the sense of it, so everything is checked again here before it can reach a
 * notification. A field that did not survive is left off the booking entirely,
 * because compose treats a missing field as a line it simply does not print.
 */

const complete = {
  movie: "Materialists",
  format: "IMAX",
  runtimeMinutes: 116,
  date: "Fri, Sep 5",
  time: "7:30 PM",
  theater: "TCL Chinese Theatre",
  address: "6925 Hollywood Blvd, Los Angeles, CA 90028",
  seats: "F4, F5",
};

describe("normalizeBooking", () => {
  it("keeps every field the model filled in", () => {
    expect(normalizeBooking(complete)).toEqual(complete);
  });

  // Workers AI hands back the JSON-schema response as either an object or the
  // string of it, depending on the model.
  it("parses a response the runtime returned as a JSON string", () => {
    expect(normalizeBooking(JSON.stringify(complete))).toEqual(complete);
  });

  it("rejects a string that is not JSON at all", () => {
    expect(normalizeBooking("Sure! Here are the booking details.")).toBeUndefined();
    expect(normalizeBooking("")).toBeUndefined();
    expect(normalizeBooking("{ movie: 'Sinners' }")).toBeUndefined();
  });

  it("rejects a response that is not an object", () => {
    expect(normalizeBooking(null)).toBeUndefined();
    expect(normalizeBooking(undefined)).toBeUndefined();
    expect(normalizeBooking([complete])).toBeUndefined();
    expect(normalizeBooking(42)).toBeUndefined();
    expect(normalizeBooking("null")).toBeUndefined();
  });

  // The film title is the one thing a notification cannot be written without,
  // so its absence fails the whole extraction rather than sending a blank title.
  it("rejects a booking with no film title", () => {
    expect(normalizeBooking({ ...complete, movie: undefined })).toBeUndefined();
    expect(normalizeBooking({ ...complete, movie: "" })).toBeUndefined();
    expect(normalizeBooking({ ...complete, movie: "   " })).toBeUndefined();
    expect(normalizeBooking({ ...complete, movie: "null" })).toBeUndefined();
    expect(normalizeBooking({ ...complete, movie: 7 })).toBeUndefined();
  });

  it("collapses internal whitespace and trims what it keeps", () => {
    expect(normalizeBooking({ movie: "  Dune:   Part\n  Three  ", theater: " Grand\tCinema " }))
      .toEqual({ movie: "Dune: Part Three", theater: "Grand Cinema" });
  });
});

describe("normalizeBooking, when the model answers a field with a non-answer", () => {
  it("leaves the field off rather than printing the word null on a lock screen", () => {
    const booking = normalizeBooking({
      movie: "Sinners",
      format: "null",
      date: "N/A",
      time: "none",
      theater: "unknown",
      address: "-",
      seats: "   ",
    });
    expect(booking).toEqual({ movie: "Sinners" });
    // toEqual ignores keys whose value is undefined, so the absence has to be
    // checked separately: the field must not be on the object at all.
    expect("seats" in booking!).toBe(false);
    expect(Object.keys(booking!)).toEqual(["movie"]);
  });

  it("recognises a non-answer whatever case it arrives in", () => {
    const booking = normalizeBooking({
      movie: "Sinners",
      format: "NULL",
      date: "n/A",
      time: "None",
      theater: "Unknown",
      seats: "N/a",
    });
    expect(booking).toEqual({ movie: "Sinners" });
  });
});

describe("normalizeBooking, reading the runtime", () => {
  const runtime = (runtimeMinutes: unknown) =>
    normalizeBooking({ movie: "Sinners", runtimeMinutes })?.runtimeMinutes;

  it("takes a runtime written as a string", () => {
    expect(runtime("128")).toBe(128);
  });

  it("rounds a fractional runtime", () => {
    expect(runtime(116.4)).toBe(116);
    expect(runtime(116.6)).toBe(117);
  });

  it("drops a runtime that cannot be the length of a film", () => {
    expect(runtime(0)).toBeUndefined();
    expect(runtime(-20)).toBeUndefined();
    expect(runtime(600)).toBeUndefined();
    expect(runtime(6000)).toBeUndefined();
  });

  it("drops a runtime that is not a number", () => {
    expect(runtime("about two hours")).toBeUndefined();
    expect(runtime(null)).toBeUndefined();
    expect(runtime(undefined)).toBeUndefined();
    expect(runtime(NaN)).toBeUndefined();
    expect(normalizeBooking({ movie: "Sinners" })).toEqual({ movie: "Sinners" });
  });
});
