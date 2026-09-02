// What a candidate's turn is MADE OF, sentence by sentence.
//
// utils/dialogueActs.detect answers "is this whole utterance a decline?" by counting the words
// that are not part of the matched trigger. That test is right for a clean turn and wrong for a
// spoken one. Real speech-to-text output from the 2026-08-25 session:
//
//   "Don't you think you have asked me this about previously? I think so I have answered this
//    question. Also talked about this previously. I want to skip this question."
//
// That is unambiguously a decline, and detect() scored it otherWords=29 against a limit of 6, so
// it was recorded as an ANSWER and scored zero. Six more turns in the same interview failed the
// same way: seven zeros in a thirteen-answer mean, on a candidate who had declined seven times.
// The words that defeated the count were not answer content — they were the candidate saying
// "you already asked me this" and "can you repeat that", which are themselves dialogue acts.
//
// So the unit of classification here is the SENTENCE, and the question is not "how many other
// words are there" but "is any part of this turn actually an answer". A turn made entirely of
// acts is the act; a turn with real content in it is an answer, however many acts are stapled to
// it. That is the same shape as dialogueActs.splitTrailingWithdraw, which had to solve this for
// withdrawals first and solved it sentence-wise for the same reason.
//
// WHY NOT A MODEL. Identical to the argument in dialogueActs.js and repeatIntent.js, and it binds
// harder here because the output decides whether an utterance reaches a score. "Why was this
// scored zero?" has to be answerable from a stored sentence and a named rule. A classifier that
// can only say "the model thought it was an answer" is not auditable, and this is precisely the
// decision a candidate would be entitled to challenge.
//
// WHAT IT MUST NEVER DO: turn a real answer into a decline. A missed decline costs the candidate
// one wrongly-scored question. A false decline DELETES an answer they actually gave. The rules
// below are asymmetric on purpose — anything with substantive content in it stays an answer.

const dialogueActs = require("./dialogueActs");
const repeatIntent = require("./repeatIntent");

// ---------------------------------------------------------------------------
// The acts that are not answers
// ---------------------------------------------------------------------------

// "You already asked me this." Its own act, distinct from a decline: the candidate is making a
// claim ABOUT the interview, and the honest response is to check the claim rather than to move on
// as though they had passed. Before this existed the realtime path had the room model improvise a
// reply from two example sentences in its prompt, and in the 2026-08-25 session it told a
// candidate who was verbatim correct that he had only "touched on" the question.
const ALREADY_ANSWERED_TRIGGERS = [
  "you have asked me this",
  "you've asked me this",
  "you asked me this",
  "you already asked me this",
  "you've already asked me this",
  "you have already asked me this",
  "have you asked me this",
  "didn't you ask me this",
  "did you not ask me this",
  "you asked me that",
  "you already asked that",
  "i have answered this question",
  "i've answered this question",
  "i already answered this",
  "i've already answered this",
  "i have already answered this",
  "i already answered that",
  "i answered this already",
  "i answered that already",
  "i already told you",
  "i've already told you",
  "i said that already",
  "i already said that",
  "as i said before",
  "as i mentioned before",
  "as i mentioned earlier",
  "like i said before",
  "i talked about this",
  "i talked about that",
  "talked about this previously",
  "talked about that previously",
  "i covered this already",
  "this is the same question",
  "that's the same question",
  "same question again",
  "you repeated the question",
];

// "How many are left?" "Is this being recorded?" — the candidate asking about the interview
// rather than answering it. Recognised here only so those words cannot be counted as answer
// content; utils/metaAnswers owns what is actually SAID back.
const META_TRIGGERS = [
  "how many questions",
  "how many more",
  "how much longer",
  "how long is this",
  "how long will this",
  "how many are left",
  "questions are left",
  "questions left",
  "are we almost done",
  "how far are we",
  "what happens next",
  "is this being recorded",
  "can i type",
  "taking too much of my time",
  "taking too long",
  "this is taking too much time",
  "i would like to proceed",
  "can we move on",
  "let's move on",
  "next question please",
];

// ---------------------------------------------------------------------------
// Telling meta-conversation apart from evidence
// ---------------------------------------------------------------------------
//
// After the recognised triggers are stripped, whatever is left has to be judged: is this the
// candidate talking about the interview, or is it the thing we are here to measure?
//
// The proxy is vocabulary. A residual clause built entirely from stopwords and words ABOUT the
// interview ("question", "answer", "repeat", "time", "skip") is meta. A clause carrying anything
// else — a tool, a platform, a number, a verb of work — is evidence, and the moment we see one
// the whole turn is an answer and nothing below can take it away.
//
// This is deliberately crude and deliberately generous to the candidate. It is not trying to
// understand the sentence; it is trying to prove a negative, and only a confident negative counts.

// Stored WITHOUT apostrophes and compared against a stripped form of each word, because
// speech-to-text is inconsistent about them and "didn't" falling outside this set was enough to
// make a clause of pure filler read as evidence.
const STOPWORDS = new Set([
  "a", "able", "about", "actually", "again", "all", "also", "am", "an", "and", "any", "anything",
  "are", "arent", "as", "at", "back", "be", "because", "been", "being", "but", "by", "can",
  "cannot", "cant", "could", "couldnt", "did", "didnt", "do", "does", "doesnt", "doing", "don",
  "dont", "down", "for", "from", "get", "give", "go", "going", "good", "got", "had", "has", "hasnt",
  "have", "havent", "he", "her", "here", "hers", "him", "his", "how", "i", "id", "if", "ill", "im",
  "in", "into", "is", "isnt", "it", "its", "ive", "just", "know", "let", "lets", "like", "little",
  "lot", "make", "many", "may", "maybe", "me", "mean", "might", "mine", "more", "most", "much",
  "must", "my", "no", "not", "now", "of", "off", "oh", "ok", "okay", "on", "once", "one", "only",
  "or", "other", "our", "out", "over", "own", "please", "put", "really", "right", "said", "same",
  "say", "see", "shall", "she", "should", "shouldnt", "so", "some", "something", "sorry", "still",
  "such", "sure", "take", "taking", "talk", "talking", "tell", "than", "thank", "thanks", "that",
  "thats", "the", "their", "them", "then", "there", "these", "they", "theyre", "thing", "things",
  "think", "this", "those", "though", "through", "to", "too", "try", "um", "uh", "under", "up",
  "us", "use", "used", "very", "want", "was", "wasnt", "way", "we", "well", "were", "what", "when",
  "where", "whether", "which", "while", "who", "why", "will", "with", "wont", "would", "wouldnt",
  "yeah", "yes", "yet", "you", "youre", "youve", "your", "yours",
]);

// Words that are ABOUT the interview. Present in the residual, they are still not evidence.
const META_LEXICON = new Set([
  "answer", "answered", "answers", "ask", "asked", "asking", "before", "catch", "clear", "done",
  "earlier", "end", "explain", "finish", "hear", "heard", "interview", "left", "long", "longer",
  "mentioned", "minute", "minutes", "moment", "move", "next", "pardon", "pass", "past", "previous",
  "previously", "proceed", "question", "questions", "recall", "record", "recorded", "repeat",
  "repeated", "second", "seconds", "skip", "skipped", "start", "stop", "talked", "time", "understand",
  "understood", "wait",
]);

// A sentence this short cannot carry evidence, whatever is in it: "Okay." "That's it." "On."
const FILLER_MAX_WORDS = 3;

// How much unrecognised meta-conversation may sit in a turn before we stop trying to read it as a
// pure act. Not a limit on evidence — a single evidence word ends the question immediately,
// regardless of this number. This only bounds how much ASR debris we will look past.
const MAX_RESIDUAL_WORDS = 24;

function words(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9']+/g) || [];
}

// Split on sentence punctuation, and also on the run-on boundaries speech-to-text produces when it
// declines to punctuate at all ("...skip this Actually, not able to no"). Without the second rule
// a whole turn arrives as one sentence and sentence-level classification buys nothing.
function sentencesOf(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return [];
  return raw
    .split(/(?<=[.!?…])\s+/)
    .flatMap((s) => s.split(/\s+(?=Actually,|But then,|And then,)/i))
    .map((s) => s.trim())
    .filter(Boolean);
}

// Does anything survive that is neither a stopword nor a word about the interview?
function carriesEvidence(text) {
  return words(text).some((w) => {
    const bare = w.replace(/'/g, "");
    return bare.length > 1 && !STOPWORDS.has(bare) && !META_LEXICON.has(bare);
  });
}

function matchLongestTrigger(text, triggers) {
  let best = null;
  for (const trigger of triggers) {
    const w = String(trigger).toLowerCase().match(/[a-z0-9']+/g) || [];
    if (!w.length) continue;
    const re = new RegExp(`\\b${w.map((x) => x.replace(/'/g, "'?")).join("[^a-z0-9]+")}\\b`, "i");
    if (!re.test(text)) continue;
    if (!best || trigger.length > best.length) best = trigger;
  }
  return best;
}

// Strip every recognised trigger of a kind, leaving what the candidate said around it.
function stripTriggers(text, triggers) {
  let out = String(text || "");
  for (const trigger of [...triggers].sort((a, b) => String(b).length - String(a).length)) {
    const w = String(trigger).toLowerCase().match(/[a-z0-9']+/g) || [];
    if (!w.length) continue;
    const re = new RegExp(`\\b${w.map((x) => x.replace(/'/g, "'?")).join("[^a-z0-9]+")}\\b`, "gi");
    out = out.replace(re, " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Sentence classification
// ---------------------------------------------------------------------------

/**
 * What one sentence is: "filler" | "decline" | "repeat" | "already_answered" | "meta" | "content".
 *
 * Order matters. A sentence is tested against the most consequential reading first, and the
 * per-sentence residual rule from dialogueActs still applies inside each one — so a decline
 * trigger buried in a sentence that goes on to say something real is not a decline.
 */
function classifySentence(sentence, { declineMaxOtherWords } = {}) {
  const text = String(sentence || "").trim();
  const all = words(text);
  if (!all.length) return { text, kind: "filler", trigger: null };

  // Acts are tested BEFORE the filler length check, because the shortest utterances in the whole
  // corpus are acts: "I don't know." is three words, and so is "Can you repeat?". Screening on
  // length first would bury both as filler and lose the two most important signals there are.
  const max = Number.isFinite(declineMaxOtherWords)
    ? declineMaxOtherWords
    : dialogueActs.ACTS.decline.maxOtherWords;

  const decline = matchLongestTrigger(text, dialogueActs.ACTS.decline.triggers);
  if (decline) {
    const residual = stripTriggers(text, dialogueActs.ACTS.decline.triggers);
    if (!carriesEvidence(residual) || words(residual).length <= max) {
      return { text, kind: "decline", trigger: decline };
    }
  }

  const already = matchLongestTrigger(text, ALREADY_ANSWERED_TRIGGERS);
  if (already) {
    const residual = stripTriggers(text, ALREADY_ANSWERED_TRIGGERS);
    if (!carriesEvidence(residual)) return { text, kind: "already_answered", trigger: already };
  }

  const repeat = repeatIntent.shouldRepeat(text);
  if (repeat.honour) return { text, kind: "repeat", trigger: repeat.matchedTrigger };

  const meta = matchLongestTrigger(text, META_TRIGGERS);
  if (meta) {
    const residual = stripTriggers(text, META_TRIGGERS);
    if (!carriesEvidence(residual)) return { text, kind: "meta", trigger: meta };
  }

  if (all.length <= FILLER_MAX_WORDS && !carriesEvidence(text)) {
    return { text, kind: "filler", trigger: null };
  }

  // Nothing recognised it. If it carries no evidence vocabulary it is unrecognised meta-talk or
  // transcription debris; if it does, it is the candidate answering and that settles the turn.
  return { text, kind: carriesEvidence(text) ? "content" : "residual", trigger: null };
}

// Which reading wins when a turn contains several. A decline outranks a repeat request because it
// is terminal for that question: a candidate who asked twice to hear it again and then said they
// would skip it has skipped it, and replaying the question a third time answers the wrong part of
// what they said. Withdrawal outranks everything and is not decided here — dialogueActs owns it,
// because it needs a spoken confirmation before anything happens.
const ACT_PRIORITY = ["decline", "already_answered", "repeat", "meta"];

/**
 * Read a candidate turn.
 *
 * Returns:
 *   act            — "decline" | "already_answered" | "repeat" | "meta" | null
 *   honour         — whether `act` should be acted on. False whenever the turn carries evidence.
 *   isAnswer       — the turn contains something to score
 *   contentText    — the sentences that carry evidence, joined; the answer with the acts removed
 *   sentences      — every sentence and its kind, for the audit trail
 *   contains       — which act kinds appeared anywhere, honoured or not
 *
 * `honour: false` with a non-null `act` means "they said this, and they also answered" — the
 * answer wins, exactly as dialogueActs.detect intends.
 */
function classify(transcript, opts = {}) {
  const text = String(transcript == null ? "" : transcript).trim();
  const empty = {
    act: null, honour: false, isAnswer: false, contentText: "", contentWords: 0,
    residualWords: 0, sentences: [], contains: {}, matchedTrigger: null,
  };
  if (!text) return empty;

  const sentences = sentencesOf(text).map((s) => classifySentence(s, opts));
  const contains = {};
  for (const s of sentences) contains[s.kind] = (contains[s.kind] || 0) + 1;

  const contentSentences = sentences.filter((s) => s.kind === "content");
  const contentText = contentSentences.map((s) => s.text).join(" ").trim();
  const contentWords = words(contentText).length;
  const residualWords = sentences
    .filter((s) => s.kind === "residual")
    .reduce((n, s) => n + words(s.text).length, 0);

  const act = ACT_PRIORITY.find((k) => contains[k]) || null;
  const maxResidual = Number.isFinite(opts.maxResidualWords)
    ? opts.maxResidualWords
    : MAX_RESIDUAL_WORDS;

  // The turn is the act only when nothing in it was an answer. One content sentence is enough to
  // make it an answer — see the asymmetry note at the top of this file.
  const honour = Boolean(act) && contentWords === 0 && residualWords <= maxResidual;

  return {
    act: honour ? act : null,
    honour,
    isAnswer: contentWords > 0,
    contentText,
    contentWords,
    residualWords,
    sentences,
    contains,
    matchedTrigger: honour ? (sentences.find((s) => s.kind === act) || {}).trigger || null : null,
    // Kept even when not honoured, so a caller can see the candidate ALSO said one of these.
    detectedAct: act,
  };
}

module.exports = {
  ALREADY_ANSWERED_TRIGGERS,
  META_TRIGGERS,
  FILLER_MAX_WORDS,
  MAX_RESIDUAL_WORDS,
  ACT_PRIORITY,
  sentencesOf,
  carriesEvidence,
  classifySentence,
  classify,
};
