// "Sorry, could you repeat that?" — detecting a candidate asking to hear the question again.
//
// Deterministic phrase matching, no model. Two reasons that is the right call here and not
// laziness: an LLM round-trip in the middle of a live turn is both slow and non-reproducible, and
// more importantly a model asked "did they want a repeat?" will sometimes decide yes when the
// candidate was actually answering — silently discarding part of an answer is a far worse failure
// than missing an unusual phrasing of the request.
//
// THE BIAS TRAP THIS FILE EXISTS TO AVOID:
//   How often a candidate asks for a repeat correlates with accent, hearing, whether English is
//   their first language, and the quality of their internet connection. It correlates only weakly,
//   if at all, with whether they can do the job. So the count is recorded as a CONDITION of the
//   interview — visible to a human reviewing it — and is structurally excluded from every score.
//   It must never reach answerScore, deliveryScore, or the evaluation. See test 4.x.
//
// What a repeat is NOT allowed to do: change the question. The repeat replays the same authored
// text — in fact the same audio bytes — so a candidate who asks twice hears exactly what every
// other candidate heard once. Re-generating the question on a repeat would quietly hand the
// candidate a different test.

// Word sequences that mean "I did not get that". Matched as word sequences, not substrings, so
// "repeat that" does not fire on "we had to repeat that migration".
const TRIGGERS = [
  "repeat that",
  "repeat the question",
  "repeat it",
  "say that again",
  "say it again",
  "come again",
  "one more time",
  "what was the question",
  "what was that",
  "i didn't catch that",
  "i didn't hear that",
  "i didn't get that",
  "i couldn't hear you",
  "i missed that",
  "could you repeat",
  "can you repeat",
  "please repeat",
  "sorry what",
  "pardon",
];

// A repeat request is only honoured while the candidate has not yet given substance. Past this
// many leftover words, we assume they are mid-answer and happen to have said something that looks
// like a request — and we leave their answer alone. Discarding a real answer to be helpful is the
// worse error.
const MAX_CARRY_WORDS = 6;

// How many times one question may be repeated. Beyond this the candidate is better served by the
// type-to-answer path than by hearing the same sentence a fifth time.
const MAX_REPEATS_PER_QUESTION = 3;

function toWordRegex(phrase) {
  const words = phrase.toLowerCase().match(/[a-z0-9']+/g) || [];
  if (!words.length) return null;
  const parts = words.map((w) => w.replace(/'/g, "'?"));
  return new RegExp(`\\b${parts.join("[^a-z0-9]+")}\\b[.,;:!?…]*`, "gi");
}

function wordCount(text) {
  return (String(text || "").match(/[A-Za-z0-9']+/g) || []).length;
}

// Returns { matched, matchedTrigger, remainder, remainderWords }.
//
// `remainder` is the transcript with the request removed — what the candidate said that was NOT
// the request. The caller keeps it as the start of their answer, so "um, sorry, could you repeat
// that" does not silently become the answer to the question.
function detect(transcript, triggers = TRIGGERS) {
  const original = String(transcript == null ? "" : transcript);
  let text = original;
  let matchedTrigger = null;

  // Longest trigger first. Order matters because each match is removed from the working text
  // before the next is tried: matching "repeat that" first would leave a dangling "could you"
  // behind to be prepended to the candidate's eventual answer. The longest phrase that fits is
  // the most complete account of what they said.
  const ordered = [...triggers].sort((a, b) => String(b).length - String(a).length);
  for (const trigger of ordered) {
    const re = toWordRegex(trigger);
    if (!re) continue;
    const next = text.replace(re, " ");
    if (next !== text) {
      if (!matchedTrigger || trigger.length > matchedTrigger.length) matchedTrigger = trigger;
      text = next;
    }
  }

  const remainder = text.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
  return {
    matched: Boolean(matchedTrigger),
    matchedTrigger,
    remainder,
    remainderWords: wordCount(remainder),
  };
}

// Should this transcript be treated as a request to hear the question again?
function shouldRepeat(transcript, { maxCarryWords = MAX_CARRY_WORDS, triggers } = {}) {
  const d = detect(transcript, triggers);
  return { ...d, honour: d.matched && d.remainderWords <= maxCarryWords };
}

// Shipped to the browser with the streaming credential: detection has to happen in real time, so
// it happens client-side, but WHAT counts as a request and how many repeats are allowed stay
// server-owned and configurable in one place.
function clientPolicy() {
  return {
    repeatTriggers: [...TRIGGERS],
    maxRepeatsPerQuestion: Number(process.env.VOICE_MAX_REPEATS_PER_QUESTION || MAX_REPEATS_PER_QUESTION),
    repeatMaxCarryWords: Number(process.env.VOICE_REPEAT_MAX_CARRY_WORDS || MAX_CARRY_WORDS),
  };
}

module.exports = {
  TRIGGERS,
  MAX_CARRY_WORDS,
  MAX_REPEATS_PER_QUESTION,
  detect,
  shouldRepeat,
  clientPolicy,
};
