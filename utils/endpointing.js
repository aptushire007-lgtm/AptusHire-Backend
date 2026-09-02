// When has a candidate finished speaking?
//
// THE PROBLEM THIS REPLACES. Silence was treated as a deadline: the provider reported N ms of
// quiet and the turn ended. N was tuned upward repeatedly (2000 → 3200) because candidates were
// being cut off mid-thought, and every increase bought that at the cost of making the
// interviewer feel slower and more machine-like on the turns where they HAD finished. There is
// no value of N that is right, because the question "are they done?" is not a question about
// duration. A person pausing after "…and then we migrated the whole thing to" is obviously
// mid-sentence after 3 seconds; a person who has just said "…so that's how we fixed it." is
// obviously finished after 700ms.
//
// WHAT THIS DOES INSTEAD. Classify the shape of what they just said, and pick the waiting window
// from that. A transcript trailing on a conjunction, a preposition or a filler is a held floor —
// wait, generously. A transcript ending on a completed clause with falling energy is a released
// floor — respond promptly, the way a person would.
//
// WHY THIS IS CODE AND NOT A MODEL CALL. Three reasons, in order of importance:
//   1. A human responds in ~200ms. There is no model round-trip that fits inside the window this
//      decision has to be made in.
//   2. It has to be reproducible. "It cut me off" is a complaint a candidate can make about a
//      real interview, and the answer has to be derivable from the transcript and the recorded
//      signals, not from what a model felt at the time.
//   3. The failure is asymmetric. Ending a turn early destroys evidence the candidate was in the
//      middle of giving; waiting too long merely feels slow. So every ambiguous case waits.
//
// This module is pure and shared: the browser runs it in real time (it is the only thing that
// knows when the silence started), and the server owns the constants and ships them with the
// streaming credential — same split as utils/backchannel.js and utils/repeatIntent.js.

// ---------------------------------------------------------------------------
// Signal 1: what the transcript trails off on
// ---------------------------------------------------------------------------

// A turn ending on any of these is a sentence in progress. Someone who stops after "because" has
// not finished a thought — they are looking for the next word.
const HOLDING_WORDS = new Set([
  // coordinating / subordinating conjunctions
  "and", "but", "or", "nor", "so", "yet", "because", "since", "although", "though", "while",
  "whereas", "unless", "until", "if", "when", "whenever", "where", "whether", "as",
  // prepositions
  "to", "of", "for", "with", "without", "in", "into", "on", "onto", "at", "by", "from", "about",
  "over", "under", "through", "between", "against", "during", "before", "after", "within",
  // articles / determiners / pronouns that cannot end a clause
  "a", "an", "the", "my", "our", "your", "their", "his", "her", "its", "this", "that", "these",
  "those", "some", "any", "every", "each", "another", "both", "such",
  // auxiliaries and copulas
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "have", "has",
  "had", "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  // connectives that promise more
  "then", "also", "plus", "like", "which", "who", "whom", "whose", "than", "very", "really",
  "quite", "just", "even", "still", "actually", "basically", "essentially",
]);

// Hesitation sounds. Deepgram transcribes these; a turn ending on one is someone thinking, not
// someone finished, and this is the single most common way the old timer cut people off.
const FILLERS = new Set(["um", "uh", "erm", "uhm", "hmm", "mmm", "er", "ah", "eh"]);

// Multi-word tails that hold the floor even though the final token looks harmless.
const HOLDING_PHRASES = [
  "you know", "sort of", "kind of", "i mean", "let me think", "let me see", "hold on",
  "one second", "give me a second", "one moment", "what else", "and then", "so that",
  "such as", "for example", "for instance", "as well as", "which is", "which was",
];

// ---------------------------------------------------------------------------
// Defaults. Every one of these is a duration the candidate experiences, so they are named for
// what they mean rather than tuned as magic numbers.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  // The clause is complete AND the voice fell away. This is the case the old flat timer served
  // worst: an obviously-finished answer sat in silence for over three seconds.
  completeWaitMs: 900,
  // Complete-looking, but the energy says they may still be going (flat or rising) — or the answer
  // is too short to take at its word. Raised from 1800ms: at under two seconds this is the moment a
  // candidate who paused to gather the second half of their answer gets cut off, and the asymmetry
  // note at the top of this file applies with full force — waiting too long merely feels slow,
  // ending too early destroys evidence and the candidate cannot get it back. Three seconds is long
  // enough to be a real pause for breath and still well short of the dead air that reads as a
  // frozen connection.
  ambiguousWaitMs: 3000,
  // Trailing on a conjunction, preposition or filler. They are mid-thought — this is the case
  // worth being generous about, because ending here destroys evidence.
  holdingWaitMs: 4500,
  // Below this many words an answer is treated as ambiguous however it ends: "Yes." is a
  // complete sentence and almost never a complete answer to an interview question.
  minCompleteWords: 8,
};

// ---------------------------------------------------------------------------
// Signal 2: the energy envelope
// ---------------------------------------------------------------------------

// Compares the tail of the RMS-energy samples the client already collects against the stretch
// before it. A speaker finishing a sentence trails off; a speaker pausing mid-thought tends to
// stop abruptly at conversational volume. Best-effort — absent or too-short samples return null
// and the decision falls back to the text alone.
function energyTrend(samples, { tail = 5, window = 15 } = {}) {
  if (!Array.isArray(samples) || samples.length < window) return null;
  const recent = samples.slice(-tail);
  const prior = samples.slice(-window, -tail);
  if (!recent.length || !prior.length) return null;
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
  const a = mean(prior);
  const b = mean(recent);
  if (a <= 0) return null;
  const ratio = b / a;
  if (ratio < 0.6) return "falling";
  if (ratio > 1.25) return "rising";
  return "flat";
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function words(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9']+/g) || [];
}

// Does this transcript trail off mid-thought?
function isHolding(text) {
  const w = words(text);
  if (!w.length) return true; // nothing said yet — never end on this
  const last = w[w.length - 1];
  if (FILLERS.has(last) || HOLDING_WORDS.has(last)) return true;
  const tail = w.slice(-3).join(" ");
  return HOLDING_PHRASES.some((p) => tail.endsWith(p));
}

// Does it end on a completed sentence? Deepgram is asked for punctuation, so terminal
// punctuation is a real signal — but its absence is not evidence of the opposite, since a final
// transcript may simply not have been punctuated yet.
function hasTerminalPunctuation(text) {
  return /[.!?]["')\]]?\s*$/.test(String(text || "").trim());
}

/**
 * How long to keep listening after the provider reports silence.
 *
 * Returns { state, waitMs, reason } where `state` is one of:
 *   "holding"   — mid-thought, wait generously and do not end the turn
 *   "ambiguous" — could go either way, so wait (the asymmetry rule)
 *   "complete"  — finished; respond promptly
 *
 * `reason` is recorded on the turn so "why did it end there?" is answerable later.
 */
function classify(transcript, { energy, policy } = {}) {
  const p = { ...DEFAULTS, ...(policy || {}) };
  const text = String(transcript || "").trim();
  const wordCount = words(text).length;

  if (!text) {
    return { state: "holding", waitMs: p.holdingWaitMs, reason: "nothing_said" };
  }
  if (isHolding(text)) {
    return { state: "holding", waitMs: p.holdingWaitMs, reason: "trails_mid_thought" };
  }
  if (wordCount < p.minCompleteWords) {
    // "Yes." parses as a complete sentence and is almost never a complete answer.
    return { state: "ambiguous", waitMs: p.ambiguousWaitMs, reason: "too_short_to_be_sure" };
  }

  const trend = energyTrend(energy);
  if (hasTerminalPunctuation(text) && trend === "falling") {
    return { state: "complete", waitMs: p.completeWaitMs, reason: "sentence_end_falling_energy" };
  }
  if (hasTerminalPunctuation(text) && trend !== "rising") {
    return { state: "complete", waitMs: p.completeWaitMs, reason: "sentence_end" };
  }
  if (trend === "rising") {
    // Getting louder is someone making a further point, not someone signing off.
    return { state: "holding", waitMs: p.holdingWaitMs, reason: "energy_rising" };
  }
  return { state: "ambiguous", waitMs: p.ambiguousWaitMs, reason: "no_sentence_end" };
}

// Shipped to the browser with the streaming credential. Detection runs client-side because only
// the browser knows in real time when the silence began; the NUMBERS stay server-side so a
// tenant's interview conditions are configured in one place, exactly like backchannel patience.
function clientPolicy() {
  return {
    endpointing: {
      completeWaitMs: Number(process.env.VOICE_ENDPOINT_COMPLETE_MS || DEFAULTS.completeWaitMs),
      ambiguousWaitMs: Number(process.env.VOICE_ENDPOINT_AMBIGUOUS_MS || DEFAULTS.ambiguousWaitMs),
      holdingWaitMs: Number(process.env.VOICE_ENDPOINT_HOLDING_MS || DEFAULTS.holdingWaitMs),
      minCompleteWords: Number(process.env.VOICE_ENDPOINT_MIN_WORDS || DEFAULTS.minCompleteWords),
    },
  };
}

module.exports = {
  classify,
  isHolding,
  hasTerminalPunctuation,
  energyTrend,
  clientPolicy,
  DEFAULTS,
  HOLDING_WORDS,
  FILLERS,
  HOLDING_PHRASES,
};
