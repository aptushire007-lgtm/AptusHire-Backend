// What the interviewer says when a candidate claims "I already answered that."
//
// Same discipline as utils/metaAnswers.js: the sentence is fixed, human-approved, boot-checked
// non-evaluative text — never a model's live composition — because it is a statement about the
// interview's own record, not a reaction to how the candidate is doing.
//
// WHETHER THE CANDIDATE IS RIGHT is a fact about the transcript, decided here in code from the one
// structural signal this codebase already trusts for it: the current question's `kind` field.
// `kind === "follow_up"` means this question was authored FROM the candidate's immediately
// preceding answer (utils/followUpPrompts.js — the room model never invents a follow-up; it is
// always grounded in something the candidate actually said). So when the current question is a
// follow-up, "you covered some of that in your last answer" is verifiably true without needing to
// extract or quote a specific term — no model call, nothing to get wrong.
//
// A baseline (non-follow-up) question is never derived from an earlier answer this way, so a claim
// of "I already answered this" against one is met honestly: nothing is on record for it yet.

const { findEvaluativeWord } = require("./backchannel");

const FOUND = "You did cover some of that in your last answer — this one's checking something a " +
  "bit more specific, so add anything you can, or just say if that covers it.";

const NOT_FOUND = "I don't have anything on record for this one yet — go ahead whenever you're ready.";

// Boot-checked exactly like metaAnswers' bank: these are spoken mid-interview, so neither may ever
// carry evaluative language, however that crept in during an edit.
for (const [name, text] of [["FOUND", FOUND], ["NOT_FOUND", NOT_FOUND]]) {
  const offender = findEvaluativeWord(text);
  if (offender) {
    throw new Error(
      `[alreadyAnsweredResponder] ${name} contains evaluative language ("${offender}"). ` +
        "This reply states a fact about the transcript; it must never rate the candidate."
    );
  }
}

/**
 * Decide what the interviewer says in response to an already_answered claim.
 *
 * @param {{ kind?: string }} currentQuestionTurn  the question turn in flight when the claim was made
 * @returns {{ text: string, found: boolean }}
 */
function respond(currentQuestionTurn) {
  const found = currentQuestionTurn?.kind === "follow_up";
  return { text: found ? FOUND : NOT_FOUND, found };
}

module.exports = { FOUND, NOT_FOUND, respond };
