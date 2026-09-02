// Recruiter review of the phrasings the interviewer's rules did not cover.
//
// See models/IntentPhrase.js. The short version: every time the semantic tier has to read an
// utterance, that is a phrasing the deterministic trigger lists missed — and the ones that keep
// recurring are this tenant's actual vocabulary. Approving one turns it into an instant rule.
//
// Approval is a human act on purpose. A counter reaching three is evidence that a phrase matters;
// it is not evidence that the reading was right, and nothing here promotes itself.

const intentPhraseService = require("../services/intentPhraseService");

// What a recruiter is deciding about, said plainly. The action names are internal identifiers and
// mean nothing to the person reviewing them.
const ACTION_LABEL = {
  repeat: "asking to hear the question again",
  clarify: "saying they did not understand the question",
  decline: "declining to answer a question",
  pause: "asking for a moment to think",
  meta_question: "asking about the interview itself",
  technical_problem: "reporting that something is broken",
  withdraw: "asking to stop the interview",
  finished: "saying they have finished their answer",
};

async function listIntentPhrases(req, res) {
  const status = ["proposed", "approved", "rejected"].includes(req.query.status) ? req.query.status : "proposed";
  const rows = await intentPhraseService.listForCompany(req.user.company, { status });
  res.json({
    status,
    // Stated so the screen can explain why a phrase seen twice is not listed yet, rather than
    // leaving a recruiter wondering where something they remember hearing went.
    minOccurrences: intentPhraseService.REVIEW_MIN_OCCURRENCES,
    phrases: rows.map((r) => ({
      id: r._id,
      action: r.action,
      actionLabel: ACTION_LABEL[r.action] || r.action,
      phrase: r.phrase,
      example: r.example,
      occurrences: r.occurrences,
      meanConfidence: r.meanConfidence,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
    })),
  });
}

async function decideIntentPhrase(req, res) {
  const doc = await intentPhraseService.decide(req.params.id, req.user.company, req.body?.status, req.user);
  res.json({
    id: doc._id,
    action: doc.action,
    actionLabel: ACTION_LABEL[doc.action] || doc.action,
    phrase: doc.phrase,
    status: doc.status,
  });
}

module.exports = { listIntentPhrases, decideIntentPhrase, ACTION_LABEL };
