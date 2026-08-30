import { describe, expect, it } from "vitest";
import {
  readBreakCue,
  readBreakMinutes,
  readCredits,
  readResearch,
  researchFilm,
  researchLines,
} from "../src/research";

/**
 * The research model is the one part of the pipeline that writes prose we then
 * put on a lock screen, so everything it returns is treated as untrusted: a
 * fixed vocabulary for the credits answer, a number for the timing, and a short
 * clause for the scene cue. Anything that does not fit is dropped rather than
 * printed, because a wrong line is worse than a missing one.
 */

describe("readCredits", () => {
  it("accepts the four answers it is allowed to give", () => {
    expect(readCredits("mid")).toBe("mid");
    expect(readCredits("post")).toBe("post");
    expect(readCredits("both")).toBe("both");
    expect(readCredits("none")).toBe("none");
  });

  it("normalises the wordier forms models reach for", () => {
    expect(readCredits("Post-credits")).toBe("post");
    expect(readCredits("mid credits scene")).toBe("mid");
    expect(readCredits("MIDCREDITS")).toBe("mid");
    expect(readCredits("no extra scenes")).toBe("none");
    expect(readCredits("None")).toBe("none");
  });

  it("drops anything outside the vocabulary", () => {
    // The model narrating a scene is exactly the case this guards: the answer
    // is matched against a fixed list, never printed, so a description of what
    // happens after the credits can't reach the notification.
    expect(readCredits("post, where Nick Fury appears")).toBeUndefined();
    expect(readCredits("")).toBeUndefined();
    expect(readCredits(null)).toBeUndefined();
    expect(readCredits(42)).toBeUndefined();
  });
});

describe("readBreakMinutes", () => {
  it("takes a number", () => {
    expect(readBreakMinutes(70)).toBe(70);
  });

  it("takes a number written as a string", () => {
    expect(readBreakMinutes("70")).toBe(70);
    expect(readBreakMinutes("70 minutes in")).toBe(70);
  });

  it("rounds a fractional answer", () => {
    expect(readBreakMinutes(70.4)).toBe(70);
    expect(readBreakMinutes(70.6)).toBe(71);
  });

  it("rejects times that cannot be a real point in a film", () => {
    expect(readBreakMinutes(0)).toBeUndefined();
    expect(readBreakMinutes(-5)).toBeUndefined();
    expect(readBreakMinutes(401)).toBeUndefined();
  });

  it("rejects non-answers", () => {
    expect(readBreakMinutes(null)).toBeUndefined();
    expect(readBreakMinutes("about halfway")).toBeUndefined();
    expect(readBreakMinutes("")).toBeUndefined();
  });
});

describe("readBreakCue", () => {
  it("keeps a short clause that opens with a connective", () => {
    expect(readBreakCue("when the snow appears")).toBe("when the snow appears");
    expect(readBreakCue("during the second car chase")).toBe("during the second car chase");
    expect(readBreakCue("right after the wedding")).toBe("right after the wedding");
    expect(readBreakCue("as the ship lands")).toBe("as the ship lands");
  });

  it("tidies capitalisation, quotes, whitespace and trailing punctuation", () => {
    expect(readBreakCue("When the snow appears.")).toBe("when the snow appears");
    expect(readBreakCue('"when the snow appears"')).toBe("when the snow appears");
    expect(readBreakCue("  when   the  snow appears  ")).toBe("when the snow appears");
  });

  it("drops a cue with no connective, because it will not read as a clause", () => {
    expect(readBreakCue("the snow appears")).toBeUndefined();
    expect(readBreakCue("snow")).toBeUndefined();
  });

  it("drops a cue long enough to be a plot summary", () => {
    // The cue has to be glanceable on a lock screen. Anything this long is the
    // model explaining the story rather than naming a moment.
    expect(
      readBreakCue("when Rey finally reveals that she is Palpatine's granddaughter"),
    ).toBeUndefined();
    expect(readBreakCue("when the first of the three separate flashbacks begins")).toBeUndefined();
  });

  it("drops non-answers", () => {
    expect(readBreakCue(null)).toBeUndefined();
    expect(readBreakCue("")).toBeUndefined();
    expect(readBreakCue(7)).toBeUndefined();
  });
});

describe("researchLines", () => {
  const lines = (obj: unknown) => researchLines(JSON.stringify(obj));

  it("puts the time and the cue on one line", () => {
    expect(lines({ creditsScenes: "post", breakStartMinutes: 70, breakCue: "when the snow appears" }))
      .toEqual(["\u{1F6BD} Best break: 70 minutes in, when the snow appears", "\u{1F3AC} Post-credits scene"]);
  });

  it("leads with the break, because that is the line people act on", () => {
    const out = lines({ creditsScenes: "both", breakStartMinutes: 55, breakCue: "during the storm" });
    expect(out[0]).toContain("Best break");
    expect(out[1]).toBe("\u{1F3AC} Mid- and post-credits scenes");
  });

  it("falls back to the time alone when the cue does not survive validation", () => {
    expect(lines({ breakStartMinutes: 70, breakCue: "the snow appears" }))
      .toEqual(["\u{1F6BD} Best break: 70 minutes in"]);
  });

  it("falls back to the cue alone when there is no usable time", () => {
    // A cue on its own is still worth sending. You cannot see a clock in a dark
    // cinema, but you can see the snow.
    expect(lines({ breakStartMinutes: null, breakCue: "when the snow appears" }))
      .toEqual(["\u{1F6BD} Best break: when the snow appears"]);
  });

  it("says minute rather than minutes when there is one of them", () => {
    expect(lines({ breakStartMinutes: 1 })).toEqual(["\u{1F6BD} Best break: 1 minute in"]);
  });

  it("omits the break line when neither half is usable", () => {
    expect(lines({ creditsScenes: "none", breakStartMinutes: null, breakCue: null }))
      .toEqual(["\u{1F3AC} No extra scenes"]);
  });

  it("returns nothing at all when the model gave nothing usable", () => {
    expect(lines({ creditsScenes: "unknown", breakStartMinutes: null })).toEqual([]);
    expect(researchLines("I could not find any information about this film.")).toEqual([]);
    expect(researchLines("")).toEqual([]);
  });

  it("reads JSON out of a fenced or chatty reply", () => {
    const text = 'Here is what I found:\n```json\n{"breakStartMinutes": 70, "breakCue": "when the snow appears"}\n```\nHope that helps!';
    expect(researchLines(text)).toEqual(["\u{1F6BD} Best break: 70 minutes in, when the snow appears"]);
  });
});

describe("readCredits, on the phrasings a model actually uses", () => {
  it("reads every natural way of saying both", () => {
    for (const value of [
      "both",
      "mid and post credits scenes",
      "Mid- and post-credits scenes",
      "mid-credits and post-credits",
      "both mid- and post-credits",
    ]) {
      expect(readCredits(value), value).toBe("both");
    }
  });

  it("does not read a negation as both", () => {
    // "no mid or post credits scenes" contains both words and means neither.
    for (const value of ["no mid or post credits scenes", "neither mid nor post credits"]) {
      expect(readCredits(value), value).not.toBe("both");
    }
  });
});

describe("readBreakCue, against the spoilers that fit in seven words", () => {
  it("drops a cue that gives away a plot beat", () => {
    for (const cue of [
      "after the hero dies in the fire",
      "as the killer is unmasked",
      "when the dog dies",
      "as the twin brother is revealed",
      "during the funeral",
      "once the villain returns",
      "when it turns out he lied",
    ]) {
      expect(readBreakCue(cue), cue).toBeUndefined();
    }
  });

  it("still keeps a cue that only names what is on screen", () => {
    for (const cue of [
      "when the snow appears",
      "during the second car chase",
      "as the ship lands",
      "when the Guardians leave Knowhere",
      "during the Los Alamos construction montage",
    ]) {
      expect(readBreakCue(cue), cue).toBe(cue);
    }
  });
});

describe("researchFilm, against the gateway", () => {
  /** Stands in for the AI binding, which is a real method using private fields. */
  function stubAi(...replies: unknown[]) {
    const calls: string[] = [];
    const ai = {
      run(this: unknown, model: string) {
        if (this !== ai) throw new TypeError("detached from its binding");
        calls.push(model);
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return Promise.resolve(reply ?? { content: [] });
      },
    };
    return { ai, calls };
  }

  const reply = (content: unknown, stop_reason?: string) => ({ content, stop_reason });

  it("reads the answer out of a response full of search results", async () => {
    const { ai, calls } = stubAi(
      reply([
        { type: "text", text: "I'll look that up." },
        { type: "server_tool_use", name: "web_search", input: { query: "runpee dune" } },
        { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "x" }] },
        {
          type: "text",
          text: '{"creditsScenes":"post","breakStartMinutes":70,"breakCue":"when the snow appears"}',
        },
      ]),
    );

    expect(await researchFilm({ AI: ai } as never, "Dune")).toEqual([
      "\u{1F6BD} Best break: 70 minutes in, when the snow appears",
      "\u{1F3AC} Post-credits scene",
    ]);
    expect(calls).toEqual(["anthropic/claude-sonnet-4.6"]);
  });

  it("continues a turn the model paused, rather than truncating the answer", async () => {
    // A long search turn stops with pause_turn and has to be handed back.
    // Without that the answer is silently cut short and the symptom is just
    // that no research lines arrive.
    const { ai, calls } = stubAi(
      reply([{ type: "text", text: "still searching" }], "pause_turn"),
      reply([{ type: "text", text: '{"breakStartMinutes":42}' }], "end_turn"),
    );

    expect(await researchFilm({ AI: ai } as never, "Dune")).toEqual([
      "\u{1F6BD} Best break: 42 minutes in",
    ]);
    expect(calls).toHaveLength(2);
  });

  it("gives up rather than looping when the model keeps pausing", async () => {
    const { ai, calls } = stubAi(
      reply([{ type: "text", text: "..." }], "pause_turn"),
      reply([{ type: "text", text: "..." }], "pause_turn"),
      reply([{ type: "text", text: "..." }], "pause_turn"),
      reply([{ type: "text", text: "..." }], "pause_turn"),
    );

    expect(await researchFilm({ AI: ai } as never, "Dune")).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it("returns nothing rather than throwing when the gateway fails", async () => {
    // No credits on the account looks exactly like this.
    const { ai } = stubAi(new Error("no credits available"));
    expect(await researchFilm({ AI: ai } as never, "Dune")).toEqual([]);
  });

  it("does nothing at all when there is no AI binding", async () => {
    expect(await researchFilm({}, "Dune")).toEqual([]);
  });
});

describe("readResearch, on why a cue was dropped", () => {
  // Without a reason, "the model said nothing" and "we threw away something
  // good" look the same from the outside, and the second is unfindable.
  const research = (cue: unknown) =>
    readResearch(JSON.stringify({ breakStartMinutes: 70, breakCue: cue }));

  it("names the rule that rejected it, and quotes what the model said", () => {
    const cases: [unknown, string][] = [
      ["the snow appears", "not a clause"],
      ["when the camera pans to", "cut off"],
      ["when the third peetime begins", "site jargon"],
      ["when Rey finally reveals that she is Palpatine's granddaughter", "too long"],
      ["when a man in a hat sits down", "too many words"],
      [null, "missing"],
    ];
    for (const [cue, reason] of cases) {
      expect(research(cue).cue?.rejected, String(cue)).toBe(reason);
    }
    expect(research("the snow appears").cue?.raw).toBe("the snow appears");
  });

  it("withholds the text when the reason was a spoiler", () => {
    // Printing it into the log would defeat the point of dropping it.
    const out = research("when the dog dies");
    expect(out.cue?.rejected).toBe("spoiler");
    expect(out.cue?.raw).toBe("when the dog dies");
    expect(out.lines).toEqual(["\u{1F6BD} Best break: 70 minutes in"]);
  });

  it("says nothing at all when the cue was fine", () => {
    expect(research("when the snow appears").cue).toBeUndefined();
  });
});
