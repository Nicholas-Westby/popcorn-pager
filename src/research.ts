/**
 * Turning the research model's answer into the two lines that go on a lock
 * screen.
 *
 * Everything here treats the model's output as untrusted text. The credits
 * answer is matched against a fixed vocabulary and never printed, so a
 * description of the scene can't leak through. The break answer is split into a
 * number and a short clause, each validated on its own, so a plot summary can't
 * arrive in place of a cue. Anything that fails validation is dropped, because
 * a missing line is better than a wrong or spoiling one.
 */

export type CreditsKind = "mid" | "post" | "both" | "none";

const CREDITS_LABELS: Record<CreditsKind, string> = {
  mid: "Mid-credits scene",
  post: "Post-credits scene",
  both: "Mid- and post-credits scenes",
  none: "No extra scenes",
};

/** No film runs long enough for a break outside this window. */
const MIN_BREAK_MINUTES = 1;
const MAX_BREAK_MINUTES = 400;

/**
 * A cue has to be readable at a glance in a dark room, so it is capped hard on
 * both length and word count.
 *
 * Be honest about what this buys: the caps keep a paragraph of plot off the
 * lock screen, but "when the dog dies" is four words and fits. The prompt is
 * the real defence. The deny-list below is a backstop for the phrasings that
 * give a spoiler away in a handful of words.
 */
const MAX_CUE_CHARS = 45;
const MAX_CUE_WORDS = 7;

/**
 * RunPee is the best source for this, and the model reads its pages, so it
 * sometimes answers in RunPee's own vocabulary. "when the third peetime
 * begins" is not a cue anyone can act on.
 */
const SITE_JARGON = /\b(pee ?times?|runpee|peetime)\b/i;

/** A clause cut off mid-phrase reads as broken, so it is dropped instead. */
const DANGLING_END = /\b(to|of|at|in|on|with|and|or|the|a|an|for|from|into|by)$/i;

const SPOILER_WORDS =
  /\b(dies?|died|death|dead|kills?|killed|murder\w*|reveals?|revealed|revelation|betray\w*|twist|survives?|resurrect\w*|unmask\w*|funeral|villain|traitor|turns? out|is actually|final battle|last scene|ending)\b/i;

/**
 * The cue is printed straight after "70 minutes in, ", so it has to be a clause
 * rather than a noun phrase or it reads as gibberish. Requiring one of these
 * openers is a cheap way to check that without trying to parse English.
 */
const CUE_OPENER = /^(?:when|while|during|as|once|(?:right |just )?(?:after|before))\b/;

/**
 * Pulls a JSON object out of model output, ignoring any preamble, trailing
 * chatter, or ```json fences around it. Returns null if there isn't one, which
 * also covers the model refusing or apologising instead of answering.
 */
export function parseResearchJson(text: string): Record<string, unknown> | null {
  if (!text) return null;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Matches the credits answer against the four values it is allowed to give.
 * Punctuation and the wordier phrasings are normalised away first, so "Post-
 * credits scene" counts as "post", but anything with extra content attached
 * ("post, where Nick Fury appears") fails and is dropped.
 */
export function readCredits(value: unknown): CreditsKind | undefined {
  const letters = String(value ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!letters) return undefined;

  // "mid and post credits scenes", "mid- and post-credits", "both mid and
  // post" all mean the same thing. A leading negation is excluded, so "no mid
  // or post credits scenes" is not read as both.
  if (!/^(no|not|none|neither|without)/.test(letters)) {
    if (letters.includes("mid") && letters.includes("post")) return "both";
  }

  const key = letters
    .replace(/^(mid|post)credits?(scenes?)?$/, "$1")
    .replace(/^(no|none)(extra)?(scenes?)?$/, "none");

  return key in CREDITS_LABELS ? (key as CreditsKind) : undefined;
}

/** How many minutes into the film the break starts, or nothing if unusable. */
export function readBreakMinutes(value: unknown): number | undefined {
  let raw: number;

  if (typeof value === "number") {
    raw = value;
  } else if (typeof value === "string") {
    // Models sometimes answer "70 minutes in" despite being asked for a number.
    const match = /^\s*(\d+(?:\.\d+)?)/.exec(value);
    if (!match) return undefined;
    raw = Number(match[1]);
  } else {
    return undefined;
  }

  if (!Number.isFinite(raw)) return undefined;
  const minutes = Math.round(raw);
  if (minutes < MIN_BREAK_MINUTES || minutes > MAX_BREAK_MINUTES) return undefined;
  return minutes;
}

/** Why a cue the model offered did not make it onto the notification. */
export type CueRejection =
  | "missing"
  | "too long"
  | "too many words"
  | "spoiler"
  | "site jargon"
  | "cut off"
  | "not a clause";

export interface CueCheck {
  /** The cue, when it survived. */
  cue?: string;
  /** Why it did not, when it did not. */
  rejected?: CueRejection;
  /** What the model actually said, so a wrong rejection is visible. */
  raw?: string;
}

/**
 * The short clause naming what is on screen when the break starts, or the
 * reason there isn't one.
 *
 * The reason matters as much as the cue. Without it, "the model said nothing"
 * and "we threw away something perfectly good" look identical from the outside,
 * and the second is a bug you would never find.
 */
export function checkBreakCue(value: unknown): CueCheck {
  if (typeof value !== "string") return { rejected: "missing" };

  const cue = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/[.!;:,]+$/, "")
    .trim();

  if (!cue) return { rejected: "missing" };

  const raw = cue;
  if (cue.length > MAX_CUE_CHARS) return { rejected: "too long", raw };
  if (cue.split(" ").length > MAX_CUE_WORDS) return { rejected: "too many words", raw };
  if (SPOILER_WORDS.test(cue)) return { rejected: "spoiler", raw };
  if (SITE_JARGON.test(cue)) return { rejected: "site jargon", raw };
  if (DANGLING_END.test(cue)) return { rejected: "cut off", raw };

  const lowered = cue.charAt(0).toLowerCase() + cue.slice(1);
  if (!CUE_OPENER.test(lowered)) return { rejected: "not a clause", raw };
  return { cue: lowered };
}

export function readBreakCue(value: unknown): string | undefined {
  return checkBreakCue(value).cue;
}

export interface Research {
  lines: string[];
  /** Present when the model offered a cue that did not survive validation. */
  cue?: CueCheck;
}

/**
 * The research half of the notification body, most useful line first.
 *
 * The break comes before the credits because it is the line you act on during
 * the film, and a lock screen only previews the first few lines.
 */
export function readResearch(text: string): Research {
  const data = parseResearchJson(text);
  if (!data) return { lines: [] };

  const lines: string[] = [];

  const minutes = readBreakMinutes(data.breakStartMinutes);
  const check = checkBreakCue(data.breakCue);
  const timing = minutes === undefined
    ? undefined
    : `${minutes} ${minutes === 1 ? "minute" : "minutes"} in`;
  const best = [timing, check.cue].filter(Boolean).join(", ");
  if (best) lines.push(`\u{1F6BD} Best break: ${best}`);

  const credits = readCredits(data.creditsScenes);
  if (credits) lines.push(`\u{1F3AC} ${CREDITS_LABELS[credits]}`);

  return { lines, ...(check.rejected ? { cue: check } : {}) };
}

/** Just the lines. Everything that only renders uses this. */
export function researchLines(text: string): string[] {
  return readResearch(text).lines;
}

// ---------------------------------------------------------------------------
// The research call itself
// ---------------------------------------------------------------------------

/**
 * Claude with the server-side web search tool, reached through Cloudflare AI
 * Gateway. This is the half of the job the email cannot answer: it needs a
 * model that can search, read, and refuse to guess.
 *
 * Going through the gateway keeps the whole thing inside one Cloudflare
 * account. There is no second provider to sign up with and no API key to
 * manage; the inference is billed against credits on the account, and the
 * gateway creates itself on the first request. Without credits, research
 * quietly returns nothing and the notification still goes out with the booking
 * details, which is most of the value.
 */
const MODEL = "anthropic/claude-sonnet-4.6";
const SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 4 } as const;

/** A long search turn can pause and ask to be continued. */
const MAX_CONTINUATIONS = 2;

const PROMPT = (movie: string, runtime: number | undefined) =>
  `Search the web for the film "${movie}"${runtime ? ` (runtime ${runtime} min)` : ""}.

Then reply with ONLY a JSON object. No preamble, no explanation, no markdown fences, no URLs.

{"creditsScenes": "...", "breakStartMinutes": 0, "breakCue": "..."}

creditsScenes: exactly one of "mid", "post", "both" or "none". Nothing else, and never describe what happens in a scene. Use null if no source says.

breakStartMinutes: a whole number of minutes from the start of the film, marking the best moment to step out. RunPee tracks this specifically, so search for it by name. If no source covers this film, estimate from the runtime. Never null.

breakCue: a short clause naming what is visibly on screen at that moment, so the break can be recognised by looking up rather than by checking a clock. Begin it with "when", "during", "after", "as" or "once". Six words at most. Name only a setting, an object or an image. Never a plot event, never a character's fate, and never anything that would spoil the film. Never use a review site's own vocabulary, "peetime" for instance; describe the scene itself. For example: "when the snow appears", "during the second car chase", "as the ship lands". Use null if you cannot name one without spoiling something.`;

interface ResearchEnv {
  AI?: Ai;
}

/**
 * The Ai binding's types only know Cloudflare's own model catalogue, but the
 * binding forwards any `author/model` string to AI Gateway at runtime.
 */
type GatewayRun = (model: string, input: unknown, options?: unknown) => Promise<unknown>;

interface Reply {
  content?: unknown;
  stop_reason?: string;
  usage?: { server_tool_use?: { web_search_requests?: number } };
}

/**
 * The two research lines, or none of them. Enrichment is optional by design: a
 * failure here still leaves you with a notification saying where and when the
 * film is.
 */
export async function researchFilm(
  env: ResearchEnv,
  movie: string,
  runtimeMinutes?: number,
): Promise<string[]> {
  if (!env.AI) {
    console.warn({ event: "research_skipped", reason: "no AI binding" });
    return [];
  }

  try {
    const messages: unknown[] = [{ role: "user", content: PROMPT(movie, runtimeMinutes) }];
    let searches = 0;

    for (let turn = 0; turn <= MAX_CONTINUATIONS; turn += 1) {
      // Cast the binding, not the method. Pulling `run` out on its own detaches
      // it from `this`, and the binding uses private fields, so it throws.
      const ai = env.AI as unknown as { run: GatewayRun };
      const reply = (await ai.run(
        MODEL,
        { max_tokens: 1000, messages, tools: [SEARCH_TOOL] },
        { gateway: { id: "default" } },
      )) as Reply;

      searches += reply.usage?.server_tool_use?.web_search_requests ?? 0;

      // A paused turn is continued by handing the assistant's own message back
      // unchanged. Without this the answer is silently truncated.
      if (reply.stop_reason === "pause_turn" && turn < MAX_CONTINUATIONS) {
        messages.push({ role: "assistant", content: reply.content });
        continue;
      }

      const research = readResearch(finalText(reply.content));
      console.log({
        event: "research",
        movie,
        searches,
        lines: research.lines.length,
        // Why a cue was dropped, so "the model said nothing" and "we threw away
        // something good" stop looking the same. The text itself is withheld
        // when the reason was a spoiler, since printing it into the log would
        // defeat the point of dropping it.
        cue_rejected: research.cue?.rejected,
        cue: research.cue?.rejected === "spoiler" ? undefined : research.cue?.raw,
      });
      return research.lines;
    }

    return [];
  } catch (err) {
    console.error({ event: "research_failed", error: String(err) });
    return [];
  }
}

/**
 * The model's answer, out of a response that also carries its search queries
 * and their results.
 *
 * Text blocks are tried newest first and the first one holding a JSON object
 * wins. Picking by content rather than by position keeps this working whichever
 * version of the search tool is in play, since newer ones nest extra blocks in
 * between.
 */
function finalText(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const texts = (content as { type?: string; text?: string }[])
    .filter(block => block?.type === "text")
    .map(block => String(block.text ?? ""));

  for (let i = texts.length - 1; i >= 0; i -= 1) {
    if (parseResearchJson(texts[i]!)) return texts[i]!;
  }
  return texts.join("\n");
}
