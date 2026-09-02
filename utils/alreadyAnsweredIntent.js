// "I already answered that." — detecting a candidate pointing out that a question (usually a
// follow-up) repeats ground they believe they already covered.
//
// Deterministic phrase matching, same reasoning as utils/repeatIntent.js: an LLM round-trip in the
// middle of a live turn is slow and non-reproducible, and a model asked "are they saying they
// already answered this?" will sometimes read a real answer that happens to reference something
// said earlier ("like I mentioned, we also...") as a refusal to answer — discarding evidence is the
// worse failure, so the plain phrasings are matched here for free and instantly, and only the tail
// goes to the semantic tier (services/intentService.js) via conversationIntent.js.
//
// WHAT THIS IS NOT ALLOWED TO DO: decide whether the candidate is RIGHT. Whether the ground was
// genuinely already covered is a fact about the transcript, computed in code from the turn record
// (see services/aiInterviewService.js / backend/controllers/interviewPortalController.js —
// `kind === "follow_up"` is the only structural signal trusted for this), never inferred from the
// candidate's own claim or a model's reading of it.

// Word sequences that mean "I've already given you this". Matched as word sequences, not
// substrings, so "already answered" does not fire inside "I've already answered similar questions
// at other companies" (a claim about their history, not about this interview).
const TRIGGERS = [
  "i already answered that",
  "i already answered this",
  "already answered that",
  "i already told you",
  "i already said that",
  "i said that already",
  "i just told you that",
  "i just said that",
  "like i said",
  "like i mentioned",
  "as i said",
  "as i mentioned",
  "as i said before",
  "as i mentioned before",
  "we already covered this",
  "we already covered that",
  "already covered that",
  "already covered this",
  "you already asked me this",
  "you already asked me that",
  "you asked me this already",
  "you asked me that already",
  "asked and answered",
  "i've already answered this",
  "i've already answered that",
  "didn't i already answer that",
  "didn't i already say that",
];

// Same floor as repeatIntent: past this many leftover words, the candidate is mid-answer and
// happens to have referenced something they said before — that is evidence, not a request to skip
// ahead, and discarding it is the worse error.
const MAX_CARRY_WORDS = 8;

function toWordRegex(phrase) {
  const words = phrase.toLowerCase().match(/[a-z0-9']+/g) || [];
  if (!words.length) return null;
  const parts = words.map((w) => w.replace(/'/g, "'?"));
  return new RegExp(`\\b${parts.join("[^a-z0-9]+")}\\b[.,;:!?…]*`, "gi");
}

function wordCount(text) {
  return (String(text || "").match(/[A-Za-z0-9']+/g) || []).length;
}

// Returns { matched, matchedTrigger, remainder, remainderWords } — same shape as
// repeatIntent.detect, for the same reason: conversationIntent.detectDeterministic composes both
// through one code path.
function detect(transcript, triggers = TRIGGERS) {
  const original = String(transcript == null ? "" : transcript);
  let text = original;
  let matchedTrigger = null;

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

function shouldHonour(transcript, { maxCarryWords = MAX_CARRY_WORDS, triggers } = {}) {
  const d = detect(transcript, triggers);
  return { ...d, honour: d.matched && d.remainderWords <= maxCarryWords };
}

// Shipped to the browser alongside repeatTriggers — Tier 0 runs client-side for the same
// zero-latency reason.
function clientPolicy() {
  return {
    alreadyAnsweredTriggers: [...TRIGGERS],
    alreadyAnsweredMaxCarryWords: Number(process.env.VOICE_ALREADY_ANSWERED_MAX_CARRY_WORDS || MAX_CARRY_WORDS),
  };
}

module.exports = {
  TRIGGERS,
  MAX_CARRY_WORDS,
  detect,
  shouldHonour,
  clientPolicy,
};
