// What does the candidate actually want right now?
//
// THE COMPLAINT THIS ANSWERS. Until now the interviewer understood a fixed list of phrasings and
// nothing else. Say "could you repeat that" and it repeated; say "sorry, I didn't follow that last
// bit" and it recorded confusion as your answer and moved on. That is a command line wearing a
// voice, and every candidate who phrased something the third way discovered the seam.
//
// ---------------------------------------------------------------------------
// WHY A MODEL IS ALLOWED TO DO THIS, WHEN IT IS NOT ALLOWED TO SCORE
// ---------------------------------------------------------------------------
//
// The product rule is that the model never emits the score, because a score is an ASSESSMENT of a
// candidate and has to be reproducible, auditable and defensible. Working out that "sorry, what?"
// means "say it again" is not an assessment. It is CONDUCT — how the interviewer behaves in the
// room — and it never touches a rubric criterion, an answer score, a probe verdict, or a
// recommendation. Nothing downstream of this file can read an intent classification as evidence
// about the candidate.
//
// So the split is: understanding is open-ended, consequences are closed.
//
//   - The model may interpret anything a person might say, with full context.
//   - It may only ever resolve that to one of the ACTIONS below — a closed set defined here.
//   - The words the interviewer says back come from the approved bank (utils/backchannel.js),
//     never from the model.
//   - Every classification is stored with the utterance that produced it, so "why did it do that?"
//     is answerable from the record rather than from what a model felt at the time.
//
// That last property is the one that was actually at risk, and it is preserved: a stored
// {utterance, context, action, model, promptVersion} row reproduces the decision. Competitors who
// hand the whole microphone to a speech-to-speech model cannot produce that row at all.
//
// ---------------------------------------------------------------------------
// TWO TIERS, IN PARALLEL — NOT ONE REPLACING THE OTHER
// ---------------------------------------------------------------------------
//
// Tier 0 is the existing deterministic matchers (repeatIntent, dialogueActs). They answer in zero
// milliseconds, they cover the plain phrasings that make up most of what people actually say, and
// they cost nothing. They are not a legacy path to be removed — a live turn cannot wait on a
// network round-trip for the common case, and a rule that fires identically for every candidate
// forever is a better rule when it applies.
//
// Tier 1 is the semantic classifier (services/intentService.js). It runs ONLY where Tier 0 is
// silent — the tail of unusual, indirect, or context-dependent phrasings — and it is the tier that
// makes the interviewer feel like it understands rather than matches.
//
// This module owns what they share: the action set, the precedence between actions, and the gate
// every Tier-1 answer has to pass before it is allowed to do anything.

const repeatIntent = require("./repeatIntent");
const dialogueActs = require("./dialogueActs");
const finishIntent = require("./finishIntent");
const alreadyAnsweredIntent = require("./alreadyAnsweredIntent");

// ---------------------------------------------------------------------------
// The closed action set
// ---------------------------------------------------------------------------
//
// Adding a row here is a product decision, not a prompt tweak: it widens what the interviewer can
// be made to do by something a candidate says. Every field exists to make one of those
// consequences explicit at the point the action is defined rather than buried in a caller.
//
//   consumesTurn      the utterance was ABOUT the interview, so it is not the candidate's answer
//                     and must not be scored as one. False for answer_continues alone.
//   needsConfirmation never acted on from a single utterance, however confident the reading.
//   reply             which bank in utils/backchannel.js speaks the response. null = the caller
//                     composes from state (meta questions) or says nothing (answer_continues).
//   tier1             may the semantic tier reach this action at all? Set false for anything whose
//                     cost of being wrong is too high to accept from an inferred reading.

const ACTIONS = {
  // The default, and the destination of every uncertainty in this file. If we are not sure what
  // someone meant, they were answering the question — because the alternative is discarding a
  // real answer, which is the one failure that destroys evidence rather than merely annoying
  // someone.
  answer_continues: {
    consumesTurn: false,
    needsConfirmation: false,
    reply: null,
    tier1: true,
  },

  // "Say that again." The candidate did not HEAR it. Replays the identical audio bytes — never a
  // regenerated question, which would quietly hand this candidate a different test.
  repeat: {
    consumesTurn: true,
    needsConfirmation: false,
    reply: "repeat",
    tier1: true,
  },

  // "What do you mean by that?" The candidate HEARD it and did not UNDERSTAND it. Distinct from
  // repeat, and the distinction is the whole point: replaying the same sentence to someone who
  // already heard it is the most machine-like thing an interviewer can do.
  //
  // Answered from the question's pre-approved restatement, frozen alongside the question itself,
  // never improvised live — see services/questionSetService.js. A restatement composed in the
  // moment would mean two candidates were asked measurably different questions.
  clarify: {
    consumesTurn: true,
    needsConfirmation: false,
    reply: "clarify",
    tier1: true,
  },

  // "I don't know" / "can we skip this". A normal, honest move. Excluded from the answer-score
  // mean and reported as declined rather than as a zero.
  decline: {
    consumesTurn: true,
    needsConfirmation: false,
    reply: "decline",
    tier1: true,
  },

  // "Give me a second." Patience, said out loud, so the silence is visibly theirs.
  pause: {
    consumesTurn: true,
    needsConfirmation: false,
    reply: "pause",
    tier1: true,
  },

  // "I already answered that." The candidate believes this question repeats ground already
  // covered — most often said to a follow-up question, since baseline questions rarely feel
  // repetitive. Distinct from decline (not an admission of not knowing) and from repeat/clarify
  // (they are not asking to hear it again — they are saying it need not be asked at all).
  //
  // `reply: null` because whether they are RIGHT is a fact about the transcript, computed in code
  // from the turn record (was the current question authored as a follow-up to their immediately
  // preceding answer?) — never from the candidate's claim or a model's reading of it. See
  // backend/controllers/interviewPortalController.js `voiceIntent` for the composition.
  already_answered: {
    consumesTurn: true,
    needsConfirmation: false,
    reply: null,
    tier1: true,
  },

  // "How many more of these are there?" A question about the process rather than an answer to
  // one. Answerable from session state, and today it is silently transcribed as the candidate's
  // answer — which is both a lost question for them and a corrupted answer for the record.
  meta_question: {
    consumesTurn: true,
    needsConfirmation: false,
    reply: null, // composed from state, see utils/metaAnswers.js
    tier1: true,
  },

  // "I can't hear you" / "my audio has gone." Not a decline, not a repeat: the pipeline is broken
  // and repeating into a dead speaker helps nobody. The room offers the typed path.
  technical_problem: {
    consumesTurn: true,
    needsConfirmation: false,
    reply: "technical",
    tier1: true,
  },

  // "That's my answer" / "I think that covers it" / "yeah, that's the whole of it really."
  //
  // The fastest end-of-turn signal there is. utils/finishIntent matches the plain phrasings; this
  // is the tail it cannot cover, and the tail is large because there are a hundred ways to hand
  // the floor back and a list will always hold about nine of them.
  //
  // GUARDED HARDER THAN ANY OTHER ACTION, because it is the only one that destroys evidence: act
  // on it wrongly and a half-finished answer is submitted as a whole one. So the gate additionally
  // requires a substantial answer already on the record (`minWordsForFinish`) — "that's it" three
  // words into a turn is a sentence still forming, not a hand-back. The deterministic matcher
  // carries the same guard for the same reason.
  finished: {
    consumesTurn: false, // their words ARE the answer; this only ends the turn
    needsConfirmation: false,
    reply: null, // the ordinary acknowledgement covers it
    tier1: true,
  },

  // The one irreversible act. Confirmation is required NO MATTER HOW THE READING WAS REACHED —
  // deterministic or inferred — and that is not a limitation of the classifier. Ending an
  // interview on a single utterance is wrong even when the utterance was understood perfectly,
  // because a candidate who misspoke has no way back. Continuing someone who wanted to stop costs
  // them one more question, which they may decline; stopping someone who did not want to stop
  // costs them the job.
  withdraw: {
    consumesTurn: true,
    needsConfirmation: true,
    reply: "withdraw_confirm",
    tier1: true,
  },
};

const ACTION_NAMES = Object.keys(ACTIONS);

// Actions the semantic tier is permitted to return. Kept as a derived constant so the schema in
// services/intentService.js and the gate in this file can never drift apart.
const TIER1_ACTIONS = ACTION_NAMES.filter((a) => ACTIONS[a].tier1);

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------
//
// When more than one reading fits, this order decides. It is not arbitrary and it is not the order
// the actions happen to be declared in:
//
//   withdraw first          — the most consequential reading wins, and it costs nothing to be
//                             wrong about because it only ever asks a question.
//   repeat / clarify / pause next
//                           — all three mean "give me another go at this question". They beat
//                             decline deliberately: a decline is counted against evidence
//                             coverage, so reading "sorry, what was that? I'm not sure" as a
//                             decline takes a question away from someone who was still trying.
//   already_answered next   — "you don't need to ask me this" is a different claim from either of
//                             the above (not "give me another go", not "I don't know"), and it
//                             beats decline for the same reason repeat/clarify do: reading it as a
//                             decline counts against evidence coverage for a candidate who
//                             believes — rightly or not, code checks which — that the ground is
//                             already on the record.
//   technical_problem       — before decline for the same reason: a broken microphone is not an
//                             admission of not knowing.
//   decline last            — the reading that costs the candidate something is the reading of
//                             last resort.
//
// `finished` sits at the very end, below even decline: it is the only action that can destroy
// evidence (submitting a half-answer as a whole one), so any other reading that fits is preferred.
//
// meta_question and answer_continues are not in this list: the first is only ever reached by the
// semantic tier, and the second is what you get when nothing else matched.
const PRECEDENCE = [
  "withdraw",
  "repeat",
  "clarify",
  "pause",
  "already_answered",
  "technical_problem",
  "decline",
  "finished",
];

// ---------------------------------------------------------------------------
// WHY THERE IS NO SEMANTIC TIER FOR "yes, end the interview"
// ---------------------------------------------------------------------------
//
// Answering the withdrawal confirmation ("would you like to end the interview here?") is matched
// by a fixed yes/no list (utils/dialogueActs.detectConfirmation) with no model behind it, and that
// looks like the same gap this module exists to close. It is not, and it must stay open.
//
// The asymmetry runs the other way here. An unrecognised reply is treated as "no" and the
// interview continues — so a MISSED yes costs the candidate one more question they can decline,
// or a tap of the End button that needs no words at all. A semantic tier could only change the
// outcome by turning something ambiguous INTO a yes, and the cost of that error is ending an
// interview somebody wanted to keep having. Everywhere else in this file, better understanding
// makes the failure mode smaller. Here it would make it larger, so understanding is not the
// improvement — and "we could infer it" is not a reason to.
const CONFIRM_HAS_NO_SEMANTIC_TIER = true;

// ---------------------------------------------------------------------------
// Tier 0 — the deterministic matchers, composed
// ---------------------------------------------------------------------------

/**
 * Run every deterministic matcher and return the winner under PRECEDENCE.
 *
 * Composing them here rather than in each caller is a correctness fix in its own right: the
 * browser used to run repeatIntent and dialogueActs independently, so which one won when both
 * matched depended on the order the calls happened to be written in. That is exactly the kind of
 * incidental rule this codebase refuses to have.
 *
 * Returns null when no matcher fired — the signal to consult Tier 1.
 */
function detectDeterministic(transcript, opts = {}) {
  const text = String(transcript == null ? "" : transcript);
  if (!text.trim()) return null;

  const hits = {};

  const rep = repeatIntent.shouldRepeat(text, {
    maxCarryWords: opts.repeatMaxCarryWords,
    triggers: opts.repeatTriggers,
  });
  if (rep.honour) {
    hits.repeat = {
      action: "repeat",
      matchedTrigger: rep.matchedTrigger,
      // What they said that was NOT the request, kept as the start of their answer.
      residue: rep.remainder,
    };
  }

  const act = dialogueActs.detect(text, { limits: opts.actLimits });
  if (act.honour && ACTIONS[act.act]) {
    hits[act.act] = { action: act.act, matchedTrigger: act.matchedTrigger, residue: "" };
  }

  const already = alreadyAnsweredIntent.shouldHonour(text, {
    maxCarryWords: opts.alreadyAnsweredMaxCarryWords,
    triggers: opts.alreadyAnsweredTriggers,
  });
  if (already.honour) {
    hits.already_answered = {
      action: "already_answered",
      matchedTrigger: already.matchedTrigger,
      residue: already.remainder,
    };
  }

  // "That's my answer." Composed in here for the same reason as the other two: it used to be
  // checked separately, at a different point in the browser's handler, so which reading won when
  // it and a decline both matched came down to statement order. Running it through PRECEDENCE
  // puts it last, below everything — ending a turn is the only one of these that can submit a
  // half-answer as a whole one.
  const fin = finishIntent.detect(text, {
    triggers: opts.finishTriggers,
    minAnswerWords: opts.finishMinAnswerWords,
    maxTrailingWords: opts.finishMaxTrailingWords,
  });
  if (fin.honour) {
    hits.finished = { action: "finished", matchedTrigger: fin.matchedTrigger, residue: "" };
  }

  for (const name of PRECEDENCE) {
    if (hits[name]) {
      return {
        ...hits[name],
        tier: 0,
        confidence: 1,
        needsConfirmation: ACTIONS[name].needsConfirmation,
        consumesTurn: ACTIONS[name].consumesTurn,
        reason: `matched "${hits[name].matchedTrigger}"`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 1 — the gate every inferred reading has to pass
// ---------------------------------------------------------------------------

// Below this the reading is not acted on. A model that is unsure what someone meant is describing
// a candidate who was probably just talking, and the safe destination for "probably just talking"
// is their answer.
const MIN_CONFIDENCE = 0.7;

// An utterance longer than this is an answer, whatever else it contains. The same reasoning as
// dialogueActs' maxOtherWords, applied to the semantic tier, and it is doing more work here
// because the classifier has no equivalent of "the trigger was the whole of what they said":
// somebody thirty words into describing an outage is not asking us to repeat anything, however
// much hedging language they used along the way.
const MAX_META_WORDS = 25;

// How much answer has to already exist before "I think that's it" is allowed to end the turn.
// Matches utils/finishIntent's own floor: below this, a complete-sounding utterance is far more
// likely to be a sentence still forming than a deliberate hand-back, and acting on it submits a
// half-answer as a whole one — the only failure in this module that destroys evidence.
const MIN_WORDS_FOR_FINISH = 12;

// The longest utterance worth spending a classification on. Past this it is an answer whatever it
// contains, and the call is pure cost on the hottest path in the interview.
const MAX_UTTERANCE_WORDS = 45;

function wordCount(text) {
  return (String(text || "").match(/[A-Za-z0-9']+/g) || []).length;
}

/**
 * Validate and gate a raw classifier result before anything acts on it.
 *
 * Everything that fails ANY check becomes answer_continues rather than an error: a classifier
 * that returns nonsense must degrade to "they were answering the question", never to a thrown
 * exception in the middle of somebody's interview.
 *
 * Returns the same shape as detectDeterministic, plus `tier: 1`.
 */
function gateSemantic(
  raw,
  transcript,
  {
    minConfidence = MIN_CONFIDENCE,
    maxMetaWords = MAX_META_WORDS,
    minWordsForFinish = MIN_WORDS_FOR_FINISH,
    // How much answer this candidate has already given this turn. Only `finished` reads it.
    answerWords = 0,
  } = {}
) {
  const fallback = (reason) => ({
    action: "answer_continues",
    tier: 1,
    confidence: Number(raw?.confidence) || 0,
    needsConfirmation: false,
    consumesTurn: false,
    residue: "",
    matchedTrigger: null,
    reason,
  });

  if (!raw || typeof raw !== "object") return fallback("no_classification");

  const action = String(raw.action || "");
  if (!ACTIONS[action]) return fallback(`unknown_action:${action || "none"}`);
  if (!ACTIONS[action].tier1) return fallback(`action_not_available_to_tier1:${action}`);
  if (action === "answer_continues") return fallback("classified_as_answer");

  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < minConfidence) {
    return fallback(`below_confidence:${Number.isFinite(confidence) ? confidence : "none"}`);
  }

  // The length guard, applied AFTER the action check so a long utterance that the classifier read
  // as an answer never even reaches it.
  //
  // `finished` is exempt: "and that's basically the whole of how we did it, so yeah, that's me" is
  // a hand-back, and it is long precisely BECAUSE they were finishing an answer. Every other
  // action here means "I am not answering", which is a claim a long utterance contradicts.
  if (action !== "finished" && wordCount(transcript) > maxMetaWords) {
    return fallback("too_long_to_be_about_the_interview");
  }

  // Ending a turn is the one action that can destroy evidence. It is allowed only once there is a
  // real answer to end — otherwise "yeah, that's it" three words in submits a sentence that was
  // still forming as somebody's complete response.
  if (action === "finished" && answerWords < minWordsForFinish) {
    return fallback(`too_early_to_be_finished:${answerWords}`);
  }

  return {
    action,
    tier: 1,
    confidence,
    needsConfirmation: ACTIONS[action].needsConfirmation,
    consumesTurn: ACTIONS[action].consumesTurn,
    // The classifier may name which part of the utterance was not about the interview, so a
    // half-answer is not thrown away. Never trusted as a rewrite: it has to be a literal substring
    // of what was actually said, verified here, exactly as answer quotes are verified elsewhere.
    residue: literalResidue(raw.residue, transcript),
    matchedTrigger: null,
    // What the model says it understood. Stored on the session, shown to a human reviewing the
    // interview, and never read by any scoring path.
    reason: String(raw.reason || "").slice(0, 300),
    // Only meaningful for meta_question — which of the answerable process questions this was.
    metaTopic: raw.metaTopic ? String(raw.metaTopic).slice(0, 60) : null,
  };
}

// A residue the model invented is worse than no residue: it would put words into the candidate's
// answer that the candidate never said. So it is kept only when it appears verbatim in the
// transcript, the same rule span-verified evidence lives under everywhere else in this codebase.
function literalResidue(residue, transcript) {
  const r = String(residue == null ? "" : residue).trim();
  if (!r) return "";
  return String(transcript || "").toLowerCase().includes(r.toLowerCase()) ? r : "";
}

// ---------------------------------------------------------------------------
// Client policy
// ---------------------------------------------------------------------------

// Shipped to the browser with the streaming credential alongside the other policies. The browser
// runs Tier 0 locally (it must — a live turn cannot wait on the network for the common case) and
// calls the server for Tier 1 only when Tier 0 is silent.
function clientPolicy() {
  return {
    ...alreadyAnsweredIntent.clientPolicy(),
    intent: {
      actions: ACTION_NAMES,
      precedence: [...PRECEDENCE],
      // Whether the browser may consult the semantic tier at all. Off makes the interviewer
      // behave exactly as it did before this module existed — the rollback path.
      semanticEnabled: process.env.VOICE_SEMANTIC_INTENT !== "false",
      minConfidence: Number(process.env.VOICE_INTENT_MIN_CONFIDENCE || MIN_CONFIDENCE),
      maxMetaWords: Number(process.env.VOICE_INTENT_MAX_META_WORDS || MAX_META_WORDS),
      minWordsForFinish: Number(process.env.VOICE_INTENT_MIN_WORDS_FOR_FINISH || MIN_WORDS_FOR_FINISH),
      // The ceiling on spending a model call at all, which is NOT the same number as maxMetaWords.
      // "Every action except finished means 'I am not answering'" is why maxMetaWords is low — a
      // long utterance contradicts that claim. But a hand-back is long precisely BECAUSE they were
      // finishing ("...and that's basically the whole of how we did it, so yeah, that's me"), so
      // refusing to classify it at 25 words would make `finished` unreachable for the phrasings
      // people actually use. This is the cost guard; maxMetaWords stays the correctness guard.
      maxUtteranceWords: Number(process.env.VOICE_INTENT_MAX_UTTERANCE_WORDS || MAX_UTTERANCE_WORDS),
      // Tier 1 is consulted on the INTERIM transcript so the reply is ready before the candidate
      // has finished — but not on the first syllable, or every answer would trigger a lookup.
      // Below this many words there is not enough to classify; past maxMetaWords it is an answer.
      minWordsForLookup: Number(process.env.VOICE_INTENT_MIN_WORDS || 2),
      // A semantic lookup that has not answered within this long is abandoned and the utterance is
      // treated as an answer. The interview never waits on this path: a slow classifier must
      // degrade to the old behaviour, not to a stalled turn.
      timeoutMs: Number(process.env.VOICE_INTENT_TIMEOUT_MS || 1200),
    },
  };
}

module.exports = {
  ACTIONS,
  ACTION_NAMES,
  TIER1_ACTIONS,
  PRECEDENCE,
  MIN_CONFIDENCE,
  MAX_META_WORDS,
  MIN_WORDS_FOR_FINISH,
  MAX_UTTERANCE_WORDS,
  CONFIRM_HAS_NO_SEMANTIC_TIER,
  detectDeterministic,
  gateSemantic,
  literalResidue,
  clientPolicy,
};
