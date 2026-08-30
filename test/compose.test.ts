import { describe, expect, it } from "vitest";
import { composeNotification } from "../src/compose";

/**
 * A lock screen previews roughly four lines of the body before it truncates, so
 * line order is a feature and not a detail. The two research lines are the
 * reason the notification exists, so they go first; the address is the line you
 * can afford to lose.
 */

const booking = {
  movie: "Dune: Part Three",
  time: "7:30 PM",
  date: "Sat, Sep 5",
  theater: "TCL Chinese Theatre",
  seats: "F4, F5",
  address: "6925 Hollywood Blvd, Los Angeles, CA 90028",
};

const research = [
  "\u{1F6BD} Best break: 70 minutes in, when the snow appears",
  "\u{1F3AC} Post-credits scene",
];

describe("composeNotification", () => {
  it("puts the film and the showtime in the title", () => {
    const { title } = composeNotification(booking, research);
    expect(title).toBe("\u{1F37F} Dune: Part Three · 7:30 PM");
  });

  it("leads the body with the research, then the practical details", () => {
    const { body } = composeNotification(booking, research);
    expect(body.split("\n")).toEqual([
      "\u{1F6BD} Best break: 70 minutes in, when the snow appears",
      "\u{1F3AC} Post-credits scene",
      "Sat, Sep 5 · TCL Chinese Theatre · F4, F5",
      "6925 Hollywood Blvd, Los Angeles, CA 90028",
    ]);
  });

  it("still sends the booking when the research turned up nothing", () => {
    const { title, body } = composeNotification(booking, []);
    expect(title).toBe("\u{1F37F} Dune: Part Three · 7:30 PM");
    expect(body.split("\n")).toEqual([
      "Sat, Sep 5 · TCL Chinese Theatre · F4, F5",
      "6925 Hollywood Blvd, Los Angeles, CA 90028",
    ]);
  });

  it("drops fields the email did not carry rather than leaving gaps", () => {
    const { title, body } = composeNotification({ movie: "Sinners", theater: "AMC 16" }, research);
    expect(title).toBe("\u{1F37F} Sinners");
    expect(body.split("\n")).toEqual([...research, "AMC 16"]);
  });

  it("never leaves a separator dangling when one side is missing", () => {
    const { body } = composeNotification({ movie: "Sinners", seats: "A1" }, []);
    expect(body).toBe("A1");
    expect(body).not.toContain("·");
  });

  it("produces a body even when the email gave only a title", () => {
    const { title, body } = composeNotification({ movie: "Sinners" }, []);
    expect(title).toBe("\u{1F37F} Sinners");
    expect(body).toBe("Tickets booked.");
  });

  it("keeps the whole title, because a truncated film name is still readable", () => {
    const long = "Harry Potter and the Chamber of Secrets (2002)";
    expect(composeNotification({ movie: long, time: "6:20 PM" }, []).title)
      .toBe(`\u{1F37F} ${long} · 6:20 PM`);
  });
});

describe("composeNotification, when extraction leaks a non-answer", () => {
  it("treats null, N/A and unknown as missing rather than printing them", () => {
    const { title, body } = composeNotification(
      { movie: "Sinners", time: "null", theater: "N/A", seats: "unknown", address: "  " },
      [],
    );
    expect(title).toBe("\u{1F37F} Sinners");
    expect(body).toBe("Tickets booked.");
  });
});

describe("composeNotification, and the screen format", () => {
  it("names the format, because IMAX and Dolby are different rooms", () => {
    const { body } = composeNotification(
      { movie: "Sinners", format: "IMAX", theater: "AMC Century City", seats: "F4" },
      [],
    );
    expect(body).toBe("AMC Century City · IMAX · F4");
  });

  it("does not repeat a format the cinema name already carries", () => {
    const { body } = composeNotification(
      { movie: "Sinners", format: "IMAX", theater: "AMC Metreon 16 IMAX", seats: "F4" },
      [],
    );
    expect(body).toBe("AMC Metreon 16 IMAX · F4");
  });
});
