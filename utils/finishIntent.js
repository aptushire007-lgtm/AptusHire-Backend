// "That's my answer" — the candidate saying, in words, that they are done.
//
// The fastest and most reliable end-of-turn signal there is, and the pipeline used to ignore it
// completely: someone who said "yeah, that's it" then sat through three and a half seconds of
// silence waiting for a timer they could not see. Honouring it is what makes the interviewer
// feel like it is listening rather than counting.
//
// Deterministic phrase matching, mirroring utils/repeatIntent.js, for the same reasons: a model
// round-trip mid-turn is slow and non-reproducible, and a model asked "did they mean they were
// finished?" will sometimes say yes while the candidate was still talking — which discards
// evidence. See utils/endpointing.js for the general case; this is the explicit one.
//
// THE SAFETY RULE. A finish phrase is honoured ONLY when it is the tail of what was said and
// there is a real answer in front of it. "That's it" as the whole of a turn is far more likely
// to be a fragment of a sentence still forming ("that's it — the thing that broke was…") than a
// deliberate hand-back, so it is not treated as one.

const TRIGGERS = [
  "that's my answer",
  "that is my answer",
  "that's it from me",
  "that's all from me",
  "that's everything",
  "that's all i have",
  "that's all i've got",
  "that's about it",
  "that's pretty much it",
  "that's it really",
  // The bare forms are the commonest way people actually hand back, so they earn their place —
  // and they are exactly why MIN_ANSWER_WORDS and MAX_TRAILING_WORDS exist. On its own, "that's
  // it" is a fragment of a sentence still forming; at the end of a real answer it is a hand-back.
  "that's it",
  "that's all",
  "that is all",
  "i think that's it",
  "i think that's all",
  "yeah that's it",
  "so yeah that's it",
  "that's my take",
  "i'm done",
  "i am done",
  "i'm finished",
  "i have completed my answer",
  "next question",
  "you can move on",
  "we can move on",
  "ready for the next one",
  // The single bare word. Shortest trigger in the list, so it sorts last and only ever gets a
  // chance when nothing longer above already matched (see the longest-first loop in detect()) —
  // "i'm done" still wins over this for the sentence it's actually in. Guarded by the same
  // MIN_ANSWER_WORDS/MAX_TRAILING_WORDS gate as every other trigger, so "the migration is done, and
  // then we..." still can't fire (too many trailing words); only a real hand-back at the tail of a
  // substantive answer does.
  "done",
];

// A finish phrase only counts when the candidate has actually answered first. Below this many
// words in front of it, the phrase is far more likely to be mid-sentence than a hand-back.
const MIN_ANSWER_WORDS = 12;

// How near the end the phrase has to be. "That's about it" followed by another twenty words was
// not the end of the turn — they carried on. Tight (2, not 4) because the bare forms above match
// mid-sentence uses too: "the second one, that's it exactly, worked best" has three words after
// the phrase and is emphatically not a hand-back. A real one ends the utterance.
const MAX_TRAILING_WORDS = 2;

function wordList(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9']+/g) || [];
}

function toWordRegex(phrase) {
  const words = phrase.toLowerCase().match(/[a-z0-9']+/g) || [];
  if (!words.length) return null;
  const parts = words.map((w) => w.replace(/'/g, "'?"));
  return new RegExp(`\\b${parts.join("[^a-z0-9]+")}\\b[.,;:!?…]*`, "gi");
}

/**
 * Returns { matched, matchedTrigger, honour, answerWords, trailingWords }.
 *
 * `honour` is the decision: the phrase was found, near the end, with a substantive answer in
 * front of it. Callers end the turn on `honour`, never on `matched` alone.
 *
 * The phrase is deliberately NOT stripped from the transcript. Unlike a repeat request — which
 * was never part of the answer and would corrupt it — "that's my answer" is something the
 * candidate genuinely said in the interview, and removing their words to tidy the record is not
 * this system's call to make.
 */
function detect(transcript, { triggers = TRIGGERS, minAnswerWords = MIN_ANSWER_WORDS, maxTrailingWords = MAX_TRAILING_WORDS } = {}) {
  const text = String(transcript == null ? "" : transcript);
  const all = wordList(text);

  let matchedTrigger = null;
  let lastIndex = -1;
  let matchLength = 0;

  // Longest trigger first, so "i think that's it" wins over "that's it".
  for (const trigger of [...triggers].sort((a, b) => String(b).length - String(a).length)) {
    const re = toWordRegex(trigger);
    if (!re) continue;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index >= lastIndex) {
        lastIndex = m.index;
        matchedTrigger = trigger;
        matchLength = m[0].length;
      }
      if (m.index === re.lastIndex) re.lastIndex += 1; // guard against a zero-length match
    }
    if (matchedTrigger) break; // the longest matching trigger is the most complete account
  }

  if (!matchedTrigger) {
    return { matched: false, matchedTrigger: null, honour: false, answerWords: all.length, trailingWords: 0 };
  }

  const before = wordList(text.slice(0, lastIndex));
  const after = wordList(text.slice(lastIndex + matchLength));

  return {
    matched: true,
    matchedTrigger,
    answerWords: before.length,
    trailingWords: after.length,
    honour: before.length >= minAnswerWords && after.length <= maxTrailingWords,
  };
}

// Shipped to the browser with the streaming credential: detection has to be instant so it runs
// client-side, but WHAT counts as "I'm finished" stays server-owned, exactly like the repeat
// triggers and the phrase bank. The client never invents a rule.
function clientPolicy() {
  return {
    finishTriggers: [...TRIGGERS],
    finishMinAnswerWords: Number(process.env.VOICE_FINISH_MIN_ANSWER_WORDS || MIN_ANSWER_WORDS),
    finishMaxTrailingWords: Number(process.env.VOICE_FINISH_MAX_TRAILING_WORDS || MAX_TRAILING_WORDS),
  };
}

module.exports = { TRIGGERS, MIN_ANSWER_WORDS, MAX_TRAILING_WORDS, detect, clientPolicy };
