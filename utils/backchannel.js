// The interviewer's non-evaluative speech — the small conversational moves that make a spoken
// interview feel like a conversation instead of a form read aloud.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: the persona is a RENDERER, not an AUTHOR. The
// interviewer's questions are compiled from the versioned RoleRubric and the candidate's claim
// probes (services/aiInterviewService) — that is the test instrument, and it stays
// byte-for-byte auditable. Everything in this file is the wrapper's small talk: a fixed,
// human-approved bank of speech acts that say nothing whatsoever about the candidate.
//
// Why a fixed bank instead of letting a model improvise warmth:
//   - A warm, chatty model drifts toward the questions you cannot legally ask — family, age,
//     health, visa status — because that is what human small talk is made of. Competitors who
//     hand the whole interview to a speech-to-speech model have no defence when a candidate
//     says "the AI asked me about my kids".
//   - "What did the interviewer say?" becomes answerable from a constant, which is what lets
//     code verify that nothing off-script was spoken.
//   - Every candidate hears phrasing drawn from the same list, so interviewer warmth is a
//     constant of the test conditions rather than a per-candidate variable.
//
// Backchannels are NOT turns. They are never pushed into aiInterview.turns, never added to
// askedQuestions, never scored, and never shown to a reviewer as interviewer questions. They
// are recorded on aiInterview.backchannels purely so the real conditions of the interview are
// reconstructible.

// ---------------------------------------------------------------------------
// The bank
// ---------------------------------------------------------------------------

const BANK = {
  // Silence handling — the candidate has stopped speaking but has not finished thinking.
  // Ordered gentlest-first: an offer of time, then a lighter-touch "still here".
  reassure: [
    "Take your time — I'm here.",
    "No rush at all. I'm still here whenever you're ready.",
    "Whenever you're ready — take the time you need.",
  ],
  // Spoken before re-reading a question the candidate asked us to repeat.
  repeat: ["Of course — here it is again.", "No problem. Let me read that again."],
  // Spoken after an answer lands, while the next question is being prepared. Fills the dead
  // air that otherwise makes the interviewer feel like a machine between turns.
  //
  // Warmer than a bare "Thank you." — candidates report the old wording as talking into a void —
  // but still saying NOTHING about the answer. Note what is deliberately absent: no "that's
  // helpful", no "well answered", no "you sound experienced". Warmth here is UNIFORM (the same
  // rotation for every candidate at the same turn index, see phraseFor) which is what keeps it a
  // constant of the test conditions. Warmth that varied with how well someone answered would be
  // differential encouragement — a bias vector, a contamination of the measurement, and an
  // assessment delivered to the candidate with no human in the loop.
  // `{name}` is the candidate's first name, substituted per session (see `render`). A phrase that
  // needs a name is DROPPED entirely when we don't have one, rather than rendered with a hole in
  // it — half the bank is nameless for exactly that reason.
  //
  // Using someone's name is the cheapest warmth available and the most conspicuous when absent:
  // the interviewer greeted them by name and said goodbye by name, and for the twenty minutes in
  // between never used it once. It is also, unlike everything the evaluative-word list forbids, a
  // CONSTANT of the candidate rather than a function of their answer — which is the whole test
  // for whether warmth is allowed here. It cannot vary with how well they are doing, because it
  // does not depend on how well they are doing.
  //
  // Widened from four phrases to eight for the same reason. At four, a candidate hears each one
  // twice in an eight-question interview, in the same order, which is the specific texture that
  // reads as a machine playing a recording.
  acknowledge: [
    "Thank you.",
    "Got it — thank you.",
    "Thank you, {name}.",
    "Thank you, I've noted that.",
    "Understood — thank you.",
    "Thanks, {name} — I've got that down.",
    "Okay, thank you.",
    "Thanks. Let me move on to the next one.",
  ],

  // Spoken before a question that does NOT follow from the answer just given.
  //
  // The interview alternates: a recruiter-approved question, then an adaptive follow-up on what
  // the candidate actually said, then the next approved question. The follow-ups feel like a
  // conversation because they are one. The approved questions land cold — verbatim, by design,
  // with no bridge from what was just discussed — and that abrupt gear-change every other turn is
  // most of what makes the interview feel like a form being read out.
  //
  // A human interviewer says "let me move to a different area" and it costs nothing. So does
  // this. Note what it does NOT do: it never characterises the previous answer ("that's helpful,
  // let me move on"), because that is an assessment. It only signals a change of subject, which
  // is a fact about the interview and identical for every candidate.
  bridge: [
    "Let me move us on to a different area.",
    "Changing tack a little.",
    "Let me ask you about something else now.",
    "Moving on to a different part of the role.",
  ],
  // Spoken when the candidate has gone quiet and we believe the answer is finished, BEFORE
  // treating it as finished. Candidates consistently report being cut off mid-thought; this
  // makes the end of a turn their decision rather than a timer's, and it costs ~3 seconds
  // instead of the fixed minute-long wait that would otherwise be needed to feel unhurried.
  confirm: ["Anything you'd like to add?", "Is there anything else you'd like to add?"],

  // ---- Dialogue acts (utils/dialogueActs.js) -------------------------------
  //
  // The interviewer's reply when the candidate says something ABOUT the interview rather than
  // answering it. These are the phrases that decide whether "I don't know" feels like a normal
  // moment in a conversation or like a scoring event, so the wording is load-bearing.

  // "I don't know" / "can we skip this". Acknowledge, don't dwell, move on.
  //
  // Note how hard these work to say NOTHING about the decline. No "that's okay" (which implies it
  // might not have been), no "don't worry", no "no problem at all, plenty of people find that
  // one hard" — reassurance calibrated to the answer is differential encouragement, the exact
  // thing the acknowledge bank above exists to avoid. A decline is a normal turn and gets the
  // same flat, uniform courtesy every other turn gets.
  decline: [
    "That's no problem — let's move on.",
    "Understood. Let's move on to the next one.",
    "No problem at all — I'll move us on.",
  ],

  // Asked before ANY withdrawal takes effect. The one irreversible action in the interview is
  // never taken on a single utterance — see the asymmetry note in utils/dialogueActs.js. The
  // phrasing states both options plainly, because a candidate who triggered this by accident
  // needs to know that saying nothing keeps them in the interview.
  withdraw_confirm: [
    "Just to confirm — would you like to end the interview here? Say yes to finish now, or just carry on and we'll keep going.",
  ],

  // They said no, or said nothing recognisable. Back to the interview with no fuss and, in
  // particular, no comment on the fact that it happened.
  withdraw_cancel: ["No problem — let's carry on then.", "Understood — let's carry on."],

  // "Give me a second." Patience, said out loud, so the candidate knows the silence is theirs.
  pause: [
    "Of course — take the time you need.",
    "No problem. Just let me know when you're ready.",
  ],

  // "What do you mean by that?" — spoken BEFORE the question's pre-approved restatement.
  //
  // Distinct from the `repeat` preamble on purpose, and the distinction is the point of the whole
  // clarify path: someone who did not hear us wants the same sentence again, and someone who did
  // not understand us is not helped by it. What follows this preamble is the restatement frozen
  // alongside the question itself — never something composed in the moment, which would mean two
  // candidates were asked measurably different questions.
  clarify: [
    "Of course — let me put that a different way.",
    "Sure — here's another way of asking it.",
  ],

  // The audio is broken. Not a decline and not a repeat: reading the question again into a dead
  // speaker helps nobody, so this names the problem and points at the path that still works.
  // Deliberately says the typed answer is assessed the same way — a candidate who believes
  // speaking is the graded path will fight a failing microphone instead of switching, and every
  // part of that outcome is worse for both sides.
  technical: [
    "It sounds like the audio isn't coming through properly. You can switch to typing your answer at any point — typed answers are assessed the same way.",
  ],
};

const KINDS = Object.keys(BANK);

// ---------------------------------------------------------------------------
// The non-evaluative guarantee
// ---------------------------------------------------------------------------

// Words that would turn a backchannel into feedback. A backchannel may acknowledge that the
// candidate spoke; it must never signal how well they did. Differential encouragement is both
// a bias vector (warmth lands unevenly across candidates) and a contamination of the
// measurement itself — praise changes what a candidate says next, so an interview that praises
// some answers and not others is no longer measuring the same thing for everyone.
const EVALUATIVE_WORDS = [
  "great", "good", "excellent", "perfect", "interesting", "impressive", "nice", "well done",
  "exactly", "right", "correct", "wrong", "strong", "weak", "brilliant", "amazing", "wow",
  "love", "clever", "smart", "poor", "unfortunately", "concerning",
  // Added after a candidate asked for exactly this ("Well answered — you seem very experienced
  // on this project"). It is the most natural-sounding request in the world and it is an
  // assessment delivered to the candidate mid-interview with no human in the loop: it varies
  // with the answer, it changes what they say next, and it contradicts the report if they are
  // later rejected. Warmth ships as UNIFORM phrasing instead (see the acknowledge bank).
  // "helpful" is here for the same reason — "that's helpful" sounds harmless and still rates
  // the answer.
  "well answered", "helpful", "experienced", "thorough", "solid", "detailed", "insightful",
  "thoughtful", "compelling",
];

function findEvaluativeWord(phrase) {
  const lower = String(phrase || "").toLowerCase();
  return (
    EVALUATIVE_WORDS.find((w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`).test(lower)) || null
  );
}

// Checked at require time, not only in tests: the bank is a static constant, so a phrase that
// smuggles in evaluative language is a programming error. Failing at boot means it is caught on
// deploy, never discovered later in a live candidate's interview.
for (const [kind, phrases] of Object.entries(BANK)) {
  for (const phrase of phrases) {
    const offender = findEvaluativeWord(phrase);
    if (offender) {
      throw new Error(
        `[backchannel] "${phrase}" (${kind}) contains evaluative language ("${offender}"). ` +
          "Backchannels acknowledge that the candidate spoke; they never signal how well."
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering — the one variable the bank is allowed to carry
// ---------------------------------------------------------------------------

// `{name}` is the candidate's first name and it is the ONLY substitution this bank will ever
// take. The rule it has to satisfy: a variable is permissible here if it cannot vary with how
// the candidate is doing. A name is fixed for the whole interview before a word is spoken; a
// score, a topic, or a characterisation of the last answer is not, and none of those may be
// added to this mechanism however natural the resulting sentence sounds.
//
// No name (an application with no name on it, a single-token name we can't split) ⇒ the phrase is
// DROPPED, not rendered with a gap. "Thank you, ." is worse than "Thank you."
function firstNameOf(nameish) {
  const first = String(nameish || "").trim().split(/\s+/)[0] || "";
  // Guard against a "name" that is punctuation, an email fragment, or a single initial — all of
  // which appear in real applications and none of which anyone wants said aloud to them.
  return /^[\p{L}][\p{L}'-]{1,}$/u.test(first) ? first : "";
}

function render(phrase, firstName) {
  const text = String(phrase || "");
  if (!text.includes("{name}")) return text;
  if (!firstName) return null;
  return text.replace(/\{name\}/g, firstName);
}

function phrases(kind, { firstName = "" } = {}) {
  return (BANK[kind] || []).map((p) => render(p, firstName)).filter(Boolean);
}

function allPhrases({ firstName = "" } = {}) {
  return KINDS.flatMap((k) => phrases(k, { firstName }));
}

// Deterministic rotation rather than a random pick: varied enough not to sound robotic, and
// reproducible from the index alone when reconstructing what a candidate heard.
function phraseFor(kind, index, { firstName = "" } = {}) {
  const list = phrases(kind, { firstName });
  if (!list.length) return "";
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return list[i % list.length];
}

// Is this exactly something the bank permits for THIS candidate?
//
// Note the "for this candidate": a session with no name on it cannot authorise "Thank you,
// Priya." The check is per-session rather than global on purpose — a global one would let any
// session speak any other session's rendered phrases, which is a small hole in a mechanism whose
// entire value is that it has none.
function isBankPhrase(phrase, { firstName = "" } = {}) {
  return allPhrases({ firstName }).includes(String(phrase || ""));
}

// ---------------------------------------------------------------------------
// Echo removal — our voice must never be scored as the candidate's
// ---------------------------------------------------------------------------

// A backchannel is spoken while the microphone is open. The client pauses capture around
// playback, but that has a race (audio already in flight) and browsers vary, so this is the
// server-side backstop: if the interviewer's own words landed in the candidate's transcript,
// strip them before anything reads that transcript as evidence.
//
// `spoken` is the client's report of which backchannels played during this turn, and it is
// intersected with the bank first. That intersection is what makes trusting the client safe:
// the worst a lying client can do is delete a content-free phrase from its own answer, and a
// candidate whose turn had no backchannel never has their own words touched.
function toWordRegex(phrase) {
  const words = String(phrase || "").toLowerCase().match(/[a-z0-9']+/g) || [];
  if (!words.length) return null;
  // Apostrophes are optional because transcription is inconsistent about them ("I'm" / "im"),
  // and any run of non-alphanumerics counts as the gap between words, since the spoken form
  // will not carry our written punctuation.
  const parts = words.map((w) => w.replace(/'/g, "'?"));
  // Trailing sentence punctuation is consumed with the phrase. Without this, stripping "Thank
  // you." out of "That's the whole design. Thank you." leaves the phrase's own full stop behind
  // as a stray "..". Punctuation only, never whitespace, so the words either side stay separated.
  return new RegExp(`\\b${parts.join("[^a-z0-9]+")}\\b[.,;:!?…]*`, "gi");
}

function stripEcho(transcript, spoken, { firstName = "" } = {}) {
  const original = String(transcript == null ? "" : transcript);
  const claimed = (Array.isArray(spoken) ? spoken : [])
    .map((s) => (typeof s === "string" ? s : s?.phrase))
    .filter((p) => isBankPhrase(p, { firstName }));
  if (!claimed.length) return { text: original, removed: [] };

  let text = original;
  const removed = [];
  for (const phrase of [...new Set(claimed)]) {
    const re = toWordRegex(phrase);
    if (!re) continue;
    const next = text.replace(re, " ");
    if (next !== text) {
      removed.push(phrase);
      text = next;
    }
  }
  // Tidy the seams left behind, without touching the candidate's own punctuation elsewhere.
  text = text.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
  return { text, removed };
}

// ---------------------------------------------------------------------------
// Client policy
// ---------------------------------------------------------------------------

// Timing policy handed to the browser with the streaming credential. The browser owns the
// silence detection (it is the only place that knows in real time), but not the numbers or the
// words — those stay server-side so a tenant's interview conditions are configured in one place.
function clientPolicy({ firstName = "" } = {}) {
  return {
    reassurances: phrases("reassure", { firstName }),
    acknowledgements: phrases("acknowledge", { firstName }),
    repeatPreambles: phrases("repeat", { firstName }),
    confirmations: phrases("confirm", { firstName }),
    // Spoken before a question that does not follow from the last answer. The browser is told
    // WHICH questions those are by the server (publicState.currentQuestionBridges) — it has no
    // way to know on its own that a question came from the approved set rather than the adaptive
    // engine, and guessing would put a change-of-subject in front of a direct follow-up.
    bridges: phrases("bridge", { firstName }),
    // Replies to the dialogue acts (utils/dialogueActs.js). Sent with the same guarantee as
    // everything else here: the browser decides WHEN one is due, never WHAT it says.
    declineReplies: phrases("decline", { firstName }),
    withdrawConfirmations: phrases("withdraw_confirm", { firstName }),
    withdrawCancellations: phrases("withdraw_cancel", { firstName }),
    pauseReplies: phrases("pause", { firstName }),
    clarifyPreambles: phrases("clarify", { firstName }),
    technicalReplies: phrases("technical", { firstName }),
    // How long the candidate has to answer "anything you'd like to add?" before the turn really
    // ends. Long enough to draw breath and start a sentence — any new speech cancels the ending
    // outright and hands the floor straight back.
    confirmGraceMs: Number(process.env.VOICE_CONFIRM_GRACE_MS || 5000),
    // How many times one turn may be reassured before silence is finally taken as "finished".
    // Beyond this, more reassurance stops being supportive and starts being a loop.
    maxReassurancesPerTurn: Number(process.env.VOICE_MAX_REASSURANCES || 2),
    // Silence after the candidate HAS spoken and then stopped. Long, because the candidate has
    // just been told to take their time — a 4s window would make that offer a lie.
    postReassuranceGraceMs: Number(process.env.VOICE_POST_REASSURANCE_GRACE_MS || 9000),
    // Silence after the question, before the candidate has said anything at all. This is the
    // moment the old pipeline handled worst: it waited forever in total silence.
    initialSilenceMs: Number(process.env.VOICE_INITIAL_SILENCE_MS || 6000),

    // ---- When the interviewer is confident the answer is over --------------
    //
    // Every turn used to run the same sequence regardless of what the candidate had actually
    // done: reassure, reassure, "anything you'd like to add?", five seconds, submit. After a
    // clean, complete, substantial answer that is roughly EIGHT AND A HALF SECONDS of tail —
    // on every single question — and the worst of it lands as the interviewer offering time to
    // someone who finished talking half a minute ago. Nothing reads more like a machine.
    //
    // The patience was well built and aimed at the wrong thing: it treated "I am not certain
    // you are finished" as "you need encouragement". So the ladder is now chosen by how much
    // doubt there actually is (see useVoiceInterview.handleSilence):
    //
    //   holding / nothing said yet   → reassure. This is what reassurance is for.
    //   ambiguous + a real answer    → no reassurance; offer the check-in once, then end.
    //   complete  + a real answer    → end. No check-in, no countdown, just the acknowledgement.
    //
    // Cutting the check-in on the confident path is only safe because of something that did not
    // exist when it was written: the candidate can now talk over the next question on any
    // device (utils/echoAlignment.js). "Oh, one more thing" said a second too late used to be
    // lost; today it interrupts. Barge-in is a strictly better safety net than a five-second
    // silence, because the candidate can hear that it worked.

    // How many words make an answer substantial enough to be taken at its word when it sounds
    // finished. Below this, a "complete"-sounding utterance is far more likely to be an opening
    // sentence than a whole answer, and the check-in is still offered.
    settledMinWords: Number(process.env.VOICE_SETTLED_MIN_WORDS || 12),
    // Grace on the confident path. Short on purpose: by the time this is armed the provider has
    // already reported ~1s of silence and the endpointing classifier has waited its own
    // completeWaitMs on top, so this only has to cover a trailing transcript still in flight.
    settledGraceMs: Number(process.env.VOICE_SETTLED_GRACE_MS || 600),
    // Grace on the doubtful path, after the check-in has been offered and answered with silence.
    endingGraceMs: Number(process.env.VOICE_ENDING_GRACE_MS || 4000),
  };
}

module.exports = {
  BANK,
  KINDS,
  EVALUATIVE_WORDS,
  findEvaluativeWord,
  firstNameOf,
  render,
  phrases,
  allPhrases,
  phraseFor,
  isBankPhrase,
  stripEcho,
  clientPolicy,
};
