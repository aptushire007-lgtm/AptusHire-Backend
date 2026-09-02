// The loop that turns "the model had to read this" into "the rules already cover it".
//
// See models/IntentPhrase.js for why this exists. This file owns the two halves:
//
//   recordMiss()        — every semantic-tier reading is a phrasing the deterministic tier missed,
//                         so it is counted here.
//   approvedTriggers()  — the approved ones are merged into the trigger lists shipped to the
//                         browser, where they become 0 ms deterministic matches.
//
// Neither half may ever fail an interview: a miss that is not recorded costs a data point, and a
// merge that fails costs the tenant's own vocabulary for one turn. Both are swallowed and logged.

const IntentPhrase = require("../models/IntentPhrase");
const conversationIntent = require("../utils/conversationIntent");

// A phrasing shorter than this is not a phrase, it is a word — and a single word promoted to a
// deterministic trigger will fire inside ordinary answers for the rest of the tenant's life.
// "sure", "sorry", "okay" are all things the model may legitimately read as a request in context,
// and all things that appear constantly in real answers with no such meaning. Context is exactly
// what the deterministic tier does not have, so anything that needs it stays with the model.
const MIN_TRIGGER_WORDS = 2;
const MAX_TRIGGER_WORDS = 8;

// Beyond this many rows per tenant we stop proposing new ones. A runaway (a broken classifier, or
// one candidate saying something unusual a hundred different ways) must not grow the collection
// without bound, and a review queue nobody can get to the bottom of is a review queue nobody uses.
const MAX_PROPOSED_PER_COMPANY = 200;

// Same normalisation the trigger matchers use, so what is stored is what will be matched.
function normalise(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text) {
  return (String(text || "").match(/[a-z0-9']+/gi) || []).length;
}

/**
 * Is this phrasing worth putting in front of a human at all?
 *
 * Returns the normalised phrase, or "" to drop it. Deliberately strict: the cost of a bad row is
 * a recruiter's attention, and the cost of a bad APPROVAL is a rule that misreads real answers for
 * every candidate afterwards. Filtering hard here is the cheapest place to prevent the second.
 */
function promotable(utterance) {
  const phrase = normalise(utterance);
  const words = wordCount(phrase);
  if (words < MIN_TRIGGER_WORDS || words > MAX_TRIGGER_WORDS) return "";
  // A phrase that is only filler will match the filler inside every hesitant answer.
  if (/^(um|uh|erm|hmm|er|ah|eh|like|so|well|okay|yeah|yes|no)(\s+(um|uh|erm|hmm|er|ah|eh|like|so|well|okay|yeah|yes|no))*$/.test(phrase)) {
    return "";
  }
  return phrase;
}

/**
 * Record that the semantic tier had to read this utterance.
 *
 * Called after every Tier-1 classification that resolved to a real action. Never called for
 * `answer_continues` — "they were answering" is the default and needs no trigger.
 *
 * Fire-and-forget by contract: the caller must not await this in a way that can delay a turn, and
 * every failure is swallowed. A missing data point is not worth a second of a live interview.
 */
async function recordMiss({ company, action, utterance, confidence } = {}) {
  try {
    if (!company || !action) return null;
    if (action === "answer_continues") return null;
    if (!IntentPhrase.PROMOTABLE_ACTIONS.includes(action)) return null;

    const phrase = promotable(utterance);
    if (!phrase) return null;

    const existing = await IntentPhrase.findOne({ company, action, phrase });
    if (existing) {
      // A rejected phrase stays rejected. A human already looked at this exact wording and said
      // no; re-proposing it every time it recurs would make the review queue an argument.
      if (existing.status === "rejected") return null;
      existing.occurrences += 1;
      existing.lastSeenAt = new Date();
      if (Number.isFinite(confidence)) {
        const n = existing.occurrences;
        const prev = Number.isFinite(existing.meanConfidence) ? existing.meanConfidence : confidence;
        existing.meanConfidence = prev + (confidence - prev) / n;
      }
      await existing.save();
      return existing;
    }

    const proposedCount = await IntentPhrase.countDocuments({ company, status: "proposed" });
    if (proposedCount >= MAX_PROPOSED_PER_COMPANY) return null;

    return await IntentPhrase.create({
      company,
      action,
      phrase,
      example: String(utterance || "").slice(0, 200),
      meanConfidence: Number.isFinite(confidence) ? confidence : undefined,
    });
  } catch (err) {
    // Including the duplicate-key race between the findOne and the create above, which is a
    // perfectly ordinary outcome when two candidates say the same thing at the same moment.
    if (err?.code !== 11000) {
      console.error("[intentPhrase] could not record a missed phrasing:", err.message);
    }
    return null;
  }
}

/**
 * The tenant's approved phrasings, grouped by action, ready to merge into the trigger lists.
 *
 * Returns {} on any failure — the interviewer then understands exactly what the built-in lists
 * cover, which is the behaviour it had before this feature existed.
 */
async function approvedTriggers(companyId) {
  try {
    if (!companyId) return {};
    const rows = await IntentPhrase.find({ company: companyId, status: "approved" })
      .select("action phrase")
      .lean();
    const out = {};
    for (const r of rows) {
      if (!out[r.action]) out[r.action] = [];
      out[r.action].push(r.phrase);
    }
    return out;
  } catch (err) {
    console.error("[intentPhrase] could not load approved phrasings:", err.message);
    return {};
  }
}

/**
 * Merge a tenant's approved phrasings into the conversational policy's trigger lists.
 *
 * Additive only. A tenant can teach the interviewer new ways to say something; it can never
 * REMOVE a built-in trigger, because that would let a tenant configure away a candidate's ability
 * to ask for a repeat or to stop the interview.
 */
function mergeIntoPolicy(policy, approved) {
  if (!approved || !Object.keys(approved).length) return policy;
  const add = (list, extra) => [...new Set([...(list || []), ...(extra || [])])];
  return {
    ...policy,
    repeatTriggers: add(policy.repeatTriggers, approved.repeat),
    finishTriggers: add(policy.finishTriggers, approved.finished),
    alreadyAnsweredTriggers: add(policy.alreadyAnsweredTriggers, approved.already_answered),
    dialogueActs: {
      ...policy.dialogueActs,
      declineTriggers: add(policy.dialogueActs?.declineTriggers, approved.decline),
      pauseTriggers: add(policy.dialogueActs?.pauseTriggers, approved.pause),
      withdrawTriggers: add(policy.dialogueActs?.withdrawTriggers, approved.withdraw),
    },
  };
}

// ---------------------------------------------------------------------------
// Review (recruiter-facing)
// ---------------------------------------------------------------------------

// Worth a recruiter's attention: seen enough times to be vocabulary rather than a one-off.
const REVIEW_MIN_OCCURRENCES = Number(process.env.VOICE_INTENT_PROMOTE_MIN_SEEN || 3);

async function listForCompany(companyId, { status = "proposed", minOccurrences } = {}) {
  const floor = Number.isFinite(minOccurrences) ? minOccurrences : status === "proposed" ? REVIEW_MIN_OCCURRENCES : 0;
  return IntentPhrase.find({ company: companyId, status, occurrences: { $gte: floor } })
    .sort({ occurrences: -1, lastSeenAt: -1 })
    .limit(100)
    .lean();
}

async function decide(id, companyId, status, user) {
  if (!["approved", "rejected"].includes(status)) {
    throw Object.assign(new Error("status must be approved or rejected"), { status: 400 });
  }
  const doc = await IntentPhrase.findOne({ _id: id, company: companyId });
  if (!doc) throw Object.assign(new Error("Phrase not found"), { status: 404 });
  // Re-checked at approval, not only at proposal: the guard that matters is the one standing
  // between a phrase and becoming a live rule, and thresholds can change between the two.
  if (status === "approved" && !promotable(doc.phrase)) {
    throw Object.assign(
      new Error("This phrasing is too short or too generic to be a reliable trigger — it would fire inside ordinary answers"),
      { status: 400 }
    );
  }
  doc.status = status;
  doc.decidedBy = { user: user?._id, at: new Date() };
  await doc.save();
  return doc;
}

module.exports = {
  recordMiss,
  approvedTriggers,
  mergeIntoPolicy,
  listForCompany,
  decide,
  normalise,
  promotable,
  MIN_TRIGGER_WORDS,
  MAX_TRIGGER_WORDS,
  REVIEW_MIN_OCCURRENCES,
  PROMOTABLE_ACTIONS: IntentPhrase.PROMOTABLE_ACTIONS,
  // Exported so a caller can state which actions the loop covers without importing the model.
  ACTIONS: conversationIntent.ACTION_NAMES,
};
