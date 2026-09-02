// The interviewer's grounded acknowledgement — proving it listened, without ever rating what it
// heard.
//
// THE PROBLEM THIS SOLVES. utils/backchannel.js gives every candidate the same eight-phrase
// rotation ("Thank you.", "Got it — thank you.") between questions. That is uniform, auditable,
// and — candidates are right about this — indistinguishable from a machine playing a recording.
// A human interviewer says "you mentioned the recruitment platform — what did Node do there?"
// and the interview stops feeling like a form read aloud.
//
// THE TRAP IT REFUSES TO FALL INTO. The obvious way to get that warmth is to let the model react
// to the answer: "yes, that's correct", "you're on the right track", "I understand, thank you for
// explaining your approach". Every one of those is an ASSESSMENT DELIVERED TO THE CANDIDATE with
// no human in the loop, and the differential between them is itself the score. A candidate who
// hears "that's correct" on Q2 and "thank you for explaining your approach" on Q3 has been told
// they got Q3 wrong, and answers Q4 through Q10 as a person who believes they are failing. That
// is not a fairness nicety — it means the instrument measured something different for them than
// for the candidate who happened to open strong, so the two scores are not comparable, which is
// the entire premise of a structured interview. It is also gameable the moment one candidate
// posts the tells, and it is an automated adverse signal in jurisdictions (NYC LL144, EU AI Act
// Annex III) where those have to be defensible.
//
// SO THE TWO THINGS ARE SEPARATED, AND ONLY ONE IS ALLOWED:
//
//   GROUNDING  — naming something the candidate actually said.  ALLOWED. It is a fact about the
//                transcript, verifiable against it, and identical in kind for every candidate:
//                everybody's answer contains something to name.
//   EVALUATION — signalling how good it was.                    FORBIDDEN, by the same rule and
//                the same word list that governs the fixed bank.
//
// HOW THE GUARANTEE IS ENFORCED — code, not prompt discipline. The model proposes a lead-in and
// names the term it grounded on. Then this file checks, deterministically:
//
//   1. The named term is a LITERAL substring of what the candidate actually said. This is
//      utils/spanVerifier's cite-or-abstain rule turned around to point at our own mouth: the
//      interviewer may not attribute a word to a candidate who never said it. Catches the failure
//      that would otherwise be invisible and mortifying — "you mentioned Kubernetes" said to
//      someone who never mentioned Kubernetes.
//   2. Every word of the lead-in passes backchannel.findEvaluativeWord. Same list, checked the
//      same way, so "that's a solid grasp of it" cannot arrive by a new route.
//   3. It is one short sentence, it is not a question, and it makes no claim about the candidate
//      as a person (see PERSONAL_CLAIM_RE). That last one is the subtle one: "it sounds like you
//      have practical experience with it" names a real term, passes a naive word filter, and is
//      still a verdict on the candidate.
//
// ANY check failing ⇒ we ABSTAIN and speak the uniform bank phrase instead. Never "repair" the
// model's sentence: a repaired sentence is one nobody approved, and the fallback is a perfectly
// good thing to say. Degrading to uniform warmth costs a little texture; shipping an unverified
// characterisation of a candidate costs the product's whole claim.
//
// WHAT THIS IS NOT. It is not feedback, not a hint, and not a score. It never says whether the
// answer was right, never supplies a missing piece, and never tells the candidate what a better
// answer would have contained. When an answer is thin, the interview's response is to ASK ABOUT
// THE GAP (a follow-up question — see utils/followUpPrompts.js), never to announce that a gap
// exists. Asking gets the same information and tells the candidate nothing about their standing.

const backchannel = require("./backchannel");

// ---------------------------------------------------------------------------
// Phrase containment
// ---------------------------------------------------------------------------

// Deliberately NOT utils/spanVerifier.locateQuote, which is case-SENSITIVE.
//
// That is correct where it lives: a résumé claim's span is evidence, and evidence is verbatim. Here
// the question is only "is this the candidate's own wording rather than something we invented", and
// case is pure noise — a lead-in capitalises its first word, so a model echoing "about two thousand
// leads" as "Two thousand a week, okay." would be rejected for the capital T alone and the
// interviewer would silently fall back to the bank. Loosening case cannot let through a term the
// candidate never said; it only stops discarding ones they did.
//
// Word-edge guarded on both sides, like locateQuote, so a short term ("Go") can never match inside
// a longer word ("Google"), and whitespace-tolerant because speech transcripts are inconsistent
// about it.
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPhrase(haystack, phrase) {
  const trimmed = String(phrase || "").trim();
  if (!trimmed) return false;
  const parts = trimmed.split(/\s+/).map(escapeRegex);
  if (!parts.length || parts[0] === "") return false;
  const prefix = /^[A-Za-z0-9]/.test(trimmed) ? "(?<![A-Za-z0-9])" : "";
  const suffix = /[A-Za-z0-9]$/.test(trimmed) ? "(?![A-Za-z0-9])" : "";
  return new RegExp(prefix + parts.join("\\s+") + suffix, "i").test(String(haystack || ""));
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

// One spoken sentence. The lead-in exists to bridge into the next question, not to become a turn
// of its own — anything longer is the interviewer talking about the candidate's answer, which is
// the thing it is not allowed to do.
const MAX_LEAD_IN_WORDS = 26;

// What we actually steer the model toward, as opposed to the hard ceiling above. Real
// acknowledgements between questions are four to eight words — "Okay, the Mumbai launch." A
// grammatical twenty-word sentence is the single clearest tell that a machine is talking, because
// people do not build complete sentences to acknowledge something; they drop a fragment and move on.
const TARGET_LEAD_IN_WORDS = 12;

// ---------------------------------------------------------------------------
// Sounding like a person
// ---------------------------------------------------------------------------
//
// The verification rules above decide what is SAFE to say. They are silent about what is NATURAL,
// and the first version of this feature showed why that gap matters: every check passed and the
// interviewer still said "You mentioned the X." eight times in a row. Each one was individually
// fine and the sequence was unmistakably a machine — a new robotic tell replacing the old one.
//
// Three things make the difference, and none of them touch the safety properties:
//
//   1. THE SHAPE VARIES. People acknowledge the same way twice by accident, never by pattern. So
//      the frame rotates: sometimes a bare echo of the thing, sometimes a marker then the thing,
//      sometimes naming that they raised it.
//   2. SOMETIMES NOTHING IS SAID. Acknowledging every single answer is itself the tell — a human
//      interviewer sometimes just asks the next question. One slot in the rotation is silent.
//   3. IT IS A FRAGMENT, NOT A SENTENCE. "The queue, okay." is what people say. "You mentioned
//      that you used a queue." is what a form says.
//
// WHY ROTATION AND NOT A MODEL CHOICE. Variety has to come from something that CANNOT correlate
// with how the candidate is doing. If the model picked the shape, it would pick warmer shapes for
// answers it liked — differential warmth, arriving by the one route the word list cannot see. The
// index is the turn number, so two candidates at question four get the same shape, and the variety
// is a constant of the test conditions rather than a per-candidate variable. Exactly the argument
// utils/backchannel.phraseFor makes for rotating the fixed bank.

const SHAPES = [
  {
    key: "echo",
    // The commonest human move by a wide margin: repeat the salient fragment and stop.
    hint: 'Say the thing back as a bare fragment, then stop. Examples: "The Mumbai launch, okay." / "Two thousand a day."',
  },
  {
    key: "marker",
    hint: 'Open with a neutral marker, then the thing. Examples: "Okay — so, the Mumbai launch." / "Alright, the queue."',
  },
  {
    key: "mentioned",
    hint: 'Name that they raised it. Examples: "You mentioned the Mumbai launch." / "You talked about the queue there."',
  },
  {
    key: "locate",
    hint: 'Locate it in their work. Examples: "So that was on the Mumbai launch." / "That was the queue side of it."',
  },
  {
    key: "note",
    hint: 'Register it plainly. Examples: "Okay, the Mumbai launch — noted." / "Got it, the queue."',
  },
  {
    // Varies WHAT is echoed rather than the frame around it. A second plain "echo" slot made the
    // same fragment come back three times in eight turns; steering to the number or the proper noun
    // instead gives the interviewer something different to latch onto, which is what actually reads
    // as having listened.
    key: "detail",
    hint:
      'Pick out the single most concrete detail — a number, a proper noun, a named system — and say ' +
      'just that back. Examples: "Two thousand a week." / "On Meta, okay."',
  },
  {
    // Silent. Not a failure and not a fallback — a deliberate slot, because an interviewer that
    // responds to all eight answers sounds more mechanical than one that sometimes just carries on.
    key: "silent",
    hint: null,
  },
];

// Which shape this turn uses. Deterministic in the turn index, so it is reproducible from stored
// state and identical across candidates at the same point in the interview.
function shapeFor(index) {
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return SHAPES[i % SHAPES.length];
}

// A grounded term has to be substantial enough to be worth naming and specific enough that
// finding it in the transcript means something. "it" appears in every answer ever given.
const MIN_TERM_CHARS = 3;
const MAX_TERM_WORDS = 6;

// Terms too generic to count as evidence of listening. Naming one of these is worse than the
// uniform bank phrase: it has the FORM of "I was paying attention" with none of the substance,
// which is precisely the tone candidates describe as uncanny.
const GENERIC_TERMS = new Set([
  "it", "that", "this", "they", "them", "the project", "the work", "my work", "the team",
  "the company", "the role", "the job", "experience", "project", "projects", "work", "team",
  "thing", "things", "stuff", "code", "coding", "development", "technology", "tech", "tool",
  "tools", "system", "systems", "process", "task", "tasks", "job", "role", "yes", "no",
]);

// Claims about the PERSON rather than the transcript. Each of these can be built entirely from
// non-evaluative words and is still a verdict, which is why the word list alone cannot catch them.
//
// "It sounds like you have practical experience working with it" was in the original spec for this
// feature and is the exact sentence this pattern exists to reject: no forbidden word in it, a real
// grounded term beside it, and it tells the candidate the interviewer has concluded something
// about their competence.
const PERSONAL_CLAIM_RE = [
  // "you clearly / obviously / evidently ..."
  /\byou\s+(?:clearly|obviously|evidently|certainly|definitely|really)\b/i,
  // "it sounds like you ...", "it seems you ...", "that suggests you ..."
  /\b(?:sounds?|seems?|appears?|suggests?|indicates?)\s+(?:like\s+|as though\s+|that\s+)?you\b/i,
  // "you seem / appear / come across ..."
  /\byou\s+(?:seem|appear|sound|come across)\b/i,
  // "the way you explained ..." — a comment on the explaining, i.e. on the answer's quality.
  /\bthe way you\s+(?:explained|described|answered|put|handled)\b/i,
  // "you have (hands-on|practical|deep|extensive) ..." — an attribution of competence.
  /\byou(?:'ve| have)\s+(?:got\s+)?(?:a\s+)?(?:lot of\s+|plenty of\s+)?(?:hands[- ]on|practical|real|deep|strong|extensive|solid|genuine)\b/i,
  // "you've clearly worked with ..." — same attribution, verb form.
  /\byou(?:'ve| have)\s+(?:clearly|obviously|evidently|definitely|certainly)\s+\w+/i,
  // Second-person judgements of correctness that dodge the word list ("you're on the right
  // track", "you're spot on", "you've got the idea").
  /\byou(?:'re| are)\s+(?:on|almost|nearly|spot|quite|absolutely)\b/i,
  /\byou(?:'ve| have)\s+got\s+(?:the|it)\b/i,
];

// Phrases that reveal the interviewer is holding a verdict, without naming the candidate.
// "Not quite", "fair enough", "makes sense" — all rate the answer.
const VERDICT_RE = [
  /\bnot\s+quite\b/i,
  /\b(?:fair|good)\s+enough\b/i,
  /\bmakes?\s+sense\b/i,
  /\bi\s+see\s+what\s+you\s+mean\b/i,
  /\bthat(?:'s| is)\s+(?:about|roughly)\s*(?:it|right)\b/i,
  /\bas\s+(?:i|we)\s+(?:would\s+)?expect(?:ed)?\b/i,
  // "you're right" / "you are correct" are caught by the word list, but "right" as a bare
  // affirmation ("Right — so, ...") reads as agreement and therefore as assessment.
  /^\s*(?:right|correct|exactly|indeed)\b/i,
  // Thanking the candidate for the MANNER of their answer rather than for answering.
  //
  // "Thank you for explaining your approach" was proposed as the response to an INCORRECT answer,
  // and it is the most dangerous sentence in this whole feature precisely because it looks like
  // the safest: no forbidden word, no claim about the person, warm and professional. What makes it
  // unusable is that it is RESERVED for wrong answers. Candidates compare notes; within one hiring
  // cycle this exact phrase means "you got that one wrong", at which point it is a covert score
  // disclosure — demoralising for the candidate who recognises it, invisible to the one who does
  // not, and gameable by anyone who has read about it. A phrase that says nothing to some
  // candidates and "you failed" to others is not neutral, and it is worse than the bank phrase it
  // would replace.
  //
  // Note the deliberate width: it catches the whole "thanks for {explaining,walking me through,
  // talking me through,sharing,clarifying} …" family, not just the requested wording, because the
  // problem is the construction rather than the sentence. Plain "thank you" is untouched — that is
  // in the approved bank and thanks them for ANSWERING, which every candidate did.
  /\b(?:thank(?:s| you)|appreciate)\b[^.!?]*\b(?:for\s+)?(?:explain(?:ing)?|walking|talking|going through|sharing|clarif\w+|elaborat\w+|describing|outlining)\b/i,
  /\b(?:for|on)\s+(?:your|that|the)\s+(?:approach|explanation|answer|response|reasoning|thinking)\b/i,
];

// Protected-characteristic vocabulary. A lead-in is model-generated text spoken to a candidate, so
// it gets the same refusal surface the question path has: even grounded on something the candidate
// volunteered, the interviewer does not repeat it back and invite more.
const PROTECTED_RE =
  /\b(?:age|aged|married|marriage|marital|spouse|wife|husband|children|kids|pregnan\w*|family|religio\w*|church|mosque|temple|caste|ethnic\w*|race|racial|nationalit\w*|visa|immigration|citizenship|disab\w*|illness|health|medical|diagnos\w*|orientation|gay|lesbian|politic\w*|union)\b/i;

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function wordCount(text) {
  return (String(text || "").match(/[A-Za-z0-9']+/g) || []).length;
}

function normalizeTerm(term) {
  return String(term || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^["'`]+/, "")
    .replace(/["'`.,;:!?]+$/, "");
}

// Is `term` something the candidate actually said? Whitespace-tolerant and word-edge guarded via
// spanVerifier.locateQuote — the same routine that decides whether a résumé claim is citable, so
// the interviewer's own speech is held to the standard the product sells.
function termIsGrounded(term, answerText) {
  const clean = normalizeTerm(term);
  if (clean.length < MIN_TERM_CHARS) return false;
  if (wordCount(clean) > MAX_TERM_WORDS) return false;
  if (GENERIC_TERMS.has(clean.toLowerCase())) return false;
  return containsPhrase(answerText, clean);
}

// Does the lead-in actually contain the term it claims to have grounded on? A model that names
// "Kubernetes" in the term field and says "thanks for talking me through the migration" has
// grounded nothing — the check above would pass and the candidate would hear a generic phrase
// with an audit trail claiming otherwise.
function leadInNamesTerm(leadIn, term) {
  return containsPhrase(leadIn, normalizeTerm(term));
}

// Every reason a lead-in can be rejected, as a named string. Returned rather than thrown, and
// recorded on the turn: "how often did we fall back, and why" is the metric that tells us whether
// this feature is working, and a silent fallback would make it unanswerable.
function rejectionFor(leadIn, term, answerText) {
  const text = String(leadIn || "").trim();
  if (!text) return "empty";
  if (wordCount(text) > MAX_LEAD_IN_WORDS) return "too_long";
  // A lead-in that asks something would collide with the authored question arriving right after
  // it — two questions in one breath, one of them unapproved.
  if (text.includes("?")) return "contains_question";
  if (/[\n\r]/.test(text) || /^[-*•]/.test(text)) return "not_speech";

  const evaluative = backchannel.findEvaluativeWord(text);
  if (evaluative) return "evaluative:" + evaluative;
  if (PERSONAL_CLAIM_RE.some((re) => re.test(text))) return "claims_about_candidate";
  if (VERDICT_RE.some((re) => re.test(text))) return "verdict";
  if (PROTECTED_RE.test(text)) return "protected_characteristic";

  if (!termIsGrounded(term, answerText)) return "term_not_in_answer";
  if (!leadInNamesTerm(text, term)) return "term_absent_from_lead_in";
  return null;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Decide what the interviewer says between an answer and the next question.
 *
 * Returns { text, grounded, term, rejection, source } — always speakable. `grounded: false` means
 * we abstained and `text` is the uniform bank phrase, which is a correct and complete outcome,
 * not a degraded one.
 *
 * @param {object} proposal   { leadIn, term } from the model, or null when no call was made.
 * @param {string} answerText the candidate's VERBATIM transcript — never the model's rendering of
 *                            it, or "grounded in what they said" becomes "grounded in what a model
 *                            remembered them saying".
 * @param {object} opts       { index, firstName } for the fallback rotation.
 */
// Returns the acknowledgement ALONE. Joining it to a change-of-subject phrase is a separate step
// (bridgeInto), done by the caller once it knows which question is actually coming next — a bridge
// fused in here would announce a change of subject before a direct follow-up, which is worse than
// no bridge at all.
function decide(proposal, answerText, { index = 0, firstName = "" } = {}) {
  const shape = shapeFor(index);

  // The silent slot. Nothing is said about the answer this turn and the next question simply
  // follows, which is what a human interviewer does perhaps one turn in six.
  if (shape.key === "silent") {
    return { text: "", grounded: false, term: "", rejection: "shape_silent", source: "silent", shape: shape.key };
  }

  const fallback = backchannel.phraseFor("acknowledge", index, { firstName });

  if (!proposal || typeof proposal !== "object") {
    return { text: fallback, grounded: false, term: "", rejection: "no_proposal", source: "bank", shape: shape.key };
  }

  const term = normalizeTerm(proposal.term);
  const leadIn = String(proposal.leadIn || "").trim();
  const rejection = rejectionFor(leadIn, term, answerText);

  if (rejection) {
    return { text: fallback, grounded: false, term: "", rejection, source: "bank", shape: shape.key };
  }
  return { text: leadIn, grounded: true, term, rejection: null, source: "grounded", shape: shape.key };
}

// ---------------------------------------------------------------------------
// One utterance, not three
// ---------------------------------------------------------------------------

// Join the acknowledgement to the change-of-subject phrase that follows it, when one is due.
//
// This is the least obvious and possibly largest source of the machine feel, and it is not about
// wording at all. The acknowledgement, the bridge and the question used to be three SEPARATE
// speech calls, so the candidate heard three utterances with a synthesis gap between each:
//
//   "You mentioned the Mumbai launch."  <pause>  "Let me move us on to a different area."  <pause>
//   "Tell me about a time when…"
//
// Nobody talks with a beat of silence between every clause. Fusing them means one synthesis call
// and one continuous line, which is most of what "sounds human" actually is — pacing, not vocabulary.
//
// Both halves are already-approved text: the acknowledgement has passed every check in this file,
// and `bridge` comes from the fixed boot-checked bank (utils/backchannel BANK.bridge). Joining two
// approved strings composes their guarantees rather than weakening either, and the joined string is
// what gets stored on the turn — so utils/speechAuthorization authorises exactly what was said.
function bridgeInto(leadIn, bridge) {
  const a = String(leadIn || "").trim();
  const b = String(bridge || "").trim();
  if (!a) return b;
  if (!b) return a;
  // A fragment shape ("The Mumbai launch, okay") may not carry terminal punctuation, and running it
  // straight into the bridge would read as one garbled sentence to the speech engine.
  const joined = /[.!?…]$/.test(a) ? a : a + ".";
  return joined + " " + b;
}

module.exports = {
  containsPhrase,
  MAX_LEAD_IN_WORDS,
  TARGET_LEAD_IN_WORDS,
  SHAPES,
  shapeFor,
  bridgeInto,
  MIN_TERM_CHARS,
  MAX_TERM_WORDS,
  GENERIC_TERMS,
  PERSONAL_CLAIM_RE,
  VERDICT_RE,
  PROTECTED_RE,
  normalizeTerm,
  termIsGrounded,
  leadInNamesTerm,
  rejectionFor,
  decide,
};
