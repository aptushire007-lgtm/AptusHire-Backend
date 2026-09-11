// AI Interview Engine orchestration (Module 9, text-first). Drives a turn-based
// adaptive interview: load context → plan → ask → score+adapt → next → evaluate.
//
// Hardening (W3/W4):
//   - Per-tenant config (model/temperature/budget) from CompanySettings.
//   - Every LLM call is metered (usageService) for cost attribution + audit.
//   - The external LLM is used ONLY when: a key is configured, the candidate consented
//     (if the tenant requires it), and the tenant is under budget. Otherwise the local
//     deterministic engine runs — no PII leaves the system and no spend is incurred.
//   - The final evaluation runs OFF the candidate's request path (detached), so the last
//     answer submission returns immediately.
//   - The deterministic fallback NEVER emits an adverse recommendation (routes to "review").
//   - Evaluation is bias-blinded (no candidate name) and carries full provenance.

const Candidate = require("../models/Candidate");
const CompanySettings = require("../models/CompanySettings");
const llm = require("./llmService");
const { resolveRole } = require("../config/models");
const usageService = require("./usageService");
const tenantContext = require("../utils/tenantContext");
const { runInBackground } = require("../utils/backgroundTasks");
const { getFinalizationQueue } = require("../queues/finalizationQueue");
const livekit = require("./livekitService");
const { applyTransition } = require("./pipelineService");
const { notifyAdmin } = require("./notificationService");
const { audioQuality } = require("../utils/prosody");
const communication = require("../utils/communication");
const insights = require("../utils/interviewInsights");
const { INSIGHTS_SYSTEM, insightsPrompt } = require("../utils/insightPrompts");
const RoleRubric = require("../models/RoleRubric");
const { isResponsive, wordCount } = require("../utils/interviewReportEngine");
const {
  PROMPT_VERSION,
  INTERVIEWER_SYSTEM,
  interviewerSystemFor,
  buildContext,
  PLAN_SCHEMA,
  planPrompt,
  QUESTION_SCHEMA,
  questionPrompt,
  ANSWER_SCORE_SCHEMA,
  answerScorePrompt,
  EVALUATION_SCHEMA,
  evaluationPrompt,
  COMMUNICATION_SYSTEM,
  communicationPrompt,
} = require("../utils/interviewPrompts");

const probeService = require("./probeService");
const backchannel = require("../utils/backchannel");
const dialogueActs = require("../utils/dialogueActs");
const turnComposition = require("../utils/turnComposition");
const alreadyAnsweredResponder = require("../utils/alreadyAnsweredResponder");
const groundedAck = require("../utils/groundedAck");
const followUpPrompts = require("../utils/followUpPrompts");
const closingQuestions = require("../utils/closingQuestions");
const namePronunciation = require("../utils/namePronunciation");
const questionSimilarity = require("../utils/questionSimilarity");
const resumeAnchors = require("../utils/resumeAnchors");
const difficultyLadder = require("../utils/difficultyLadder");
const personaService = require("./personaService");
const questionSetService = require("./questionSetService");

const PROVIDER = "openrouter";
const MAX_ANSWER_CHARS = 4000;

// §3.4: whether the next question may be generated CONCURRENTLY with the reflect call rather than
// after it (see advance()). Off by default — reflect() decides whether the next turn is a follow-up
// BEFORE the speculative question resolves, so a speculatively-generated question is frequently
// thrown away (see the `wasted` drain below), and worse, the candidate's next question was being
// chosen without reflect's follow-up decision already made, which is the exact "not picking up the
// conversation before the next question" defect. §3.3's transcript windowing is the real latency
// fix; this is opt-in per tenant on top of it, not a default trade against correctness.
const SPECULATIVE_QUESTION_ENABLED = process.env.INTERVIEW_SPECULATIVE_QUESTION === "1";

// Phase 8.3 — the closing condition is CODE, not the model: an interview may
// end early only when every claim-probe is covered AND the minimum length is
// reached. maxQuestions stays the hard ceiling (enforced in submitAnswer).
function closingAllowed(ai) {
  const uncovered = (ai.probes || []).filter((p) => p.status === "pending");
  // An approved question the candidate was never asked means this interview did not run the
  // instrument the recruiter approved. The model may propose closing; it cannot close over an
  // uncovered approved question any more than it can over an uncovered claim-probe.
  const unasked = (ai.mustAsk || []).filter((q) => q.status === "pending");
  // Résumé anchors are required coverage on exactly the same footing (utils/resumeAnchors). An
  // interview that closed without asking about the candidate's own document is the complaint this
  // whole mechanism exists to answer, so "we ran out of interesting things to say" is not a reason
  // the model gets to end on.
  const unanchored = pendingAnchors(ai);
  return (
    uncovered.length === 0 &&
    unasked.length === 0 &&
    unanchored.length === 0 &&
    ai.questionCount >= (ai.minQuestions || 1)
  );
}

function pendingProbes(ai) {
  return (ai.probes || []).filter((p) => p.status === "pending");
}

function pendingAnchors(ai) {
  return (ai.resumeAnchors || []).filter((a) => a.status === "pending");
}

// Mark the résumé anchor a just-pushed question turn addresses. Validated the same way
// markProbeAsked's caller validates a probe: the stamped id must name a real pending anchor AND
// the question must actually mention it (resumeAnchors.questionCoversAnchor). A stamp the question
// does not honour is a FALSE COVERAGE CLAIM — the session would report "we asked about their
// Kubernetes experience" on the strength of a question about something else, which is worse than
// reporting no coverage at all because it looks equally trustworthy.
function markAnchorAsked(ai, anchorId, questionText) {
  if (!anchorId) return false;
  const anchor = (ai.resumeAnchors || []).find((a) => a.id === anchorId && a.status === "pending");
  if (!anchor) return false;
  if (!resumeAnchors.questionCoversAnchor(questionText, anchor)) return false;
  anchor.status = "asked";
  anchor.turnIndex = ai.turns.length - 1;
  anchor.askedAt = new Date();
  return true;
}

// An anchor is only COVERED once the candidate has actually answered the question that asked it.
// Asked-but-unanswered (the interview ended, they declined, the audio failed) stays "asked", so
// the report can tell the difference between a topic that was explored and one that was merely
// raised. Declines deliberately do not count: a candidate who could not speak to a résumé topic
// leaves it uncovered, which is honest and is not by itself adverse.
// `answerIndex` is passed rather than the turn object BECAUSE MONGOOSE RECASTS ON PUSH: a plain
// object handed to DocumentArray.push() is converted into a subdocument, so the caller's reference
// is not the element that ended up in the array and `turns.indexOf(answerTurn)` returns -1. That
// failed silently in the worst way — -1 is less than every anchor's turnIndex, so nothing was ever
// marked covered and the report simply understated what the interview had done.
function markAnchorsCovered(ai, answerIndex, { declined = false } = {}) {
  if (declined || !Number.isInteger(answerIndex) || answerIndex < 0) return;
  for (const anchor of ai.resumeAnchors || []) {
    if (anchor.status !== "asked") continue;
    if (anchor.turnIndex == null) continue;
    if (answerIndex <= anchor.turnIndex) continue;
    anchor.status = "covered";
  }
}

// ---- Guarding what a probe actually asks -----------------------------------
//
// questionPrompt (utils/interviewPrompts.js) tells the model it may ask a pending probe "using
// the suggested wording or a natural, equally neutral variant" and to stamp the matching probeId.
// Nothing downstream ever checked that the two still agreed — markProbeAsked only validates that
// the id belongs to a real pending probe, never that the question it was stamped on is still
// asking about the same claim. Observed live: the model tagged a real pending probeId (verifying
// a résumé claim about English/Hindi fluency) onto a question it had actually written about an
// unrelated competency ("teamwork in a multidisciplinary setting") — and the verdict step later
// read the candidate's answer to THAT question as evidence for or against the fluency claim. A
// "contradicted" verdict produced this way is not wrong about what was said, it is wrong about
// what it was said IN ANSWER TO, which is worse: it looks exactly as auditable as a real one.
//
// This is a coarse, deliberately generous check — the point is to catch wholesale topic drift,
// not to police light, natural rewording. When in doubt it falls back to the probe's own
// pre-approved wording, which is always a safe, correct question to ask; the worst a false
// positive costs is a slightly less personalised transition.
const ALIGNMENT_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "that", "this", "these", "those", "your", "you", "how",
  "what", "when", "where", "which", "who", "whom", "would", "could", "can", "did", "does", "have",
  "has", "had", "was", "were", "are", "is", "about", "into", "onto", "from", "with", "there",
  "their", "them", "then", "than", "some", "any", "very", "just", "like", "tell", "describe",
  "explain", "share", "give", "situation",
]);

function significantWords(text) {
  return (String(text || "").toLowerCase().match(/[a-z0-9']+/g) || []).filter(
    (w) => w.length >= 4 && !ALIGNMENT_STOPWORDS.has(w)
  );
}

// What fraction of the probe's own significant words actually show up in the question the model
// wrote. A natural rewording still shares most of its content words; a question about a different
// competency entirely shares almost none.
const PROBE_ALIGNMENT_MIN_SHARE = 0.25;

function questionCoversProbe(generatedQuestion, probe) {
  const target = significantWords(probe?.question);
  if (!target.length) return true; // nothing distinctive to check against — nothing to fail on
  const haystack = new Set(significantWords(generatedQuestion));
  const shared = target.filter((w) => haystack.has(w)).length;
  return shared / target.length >= PROBE_ALIGNMENT_MIN_SHARE;
}

// Mark the probe a just-pushed question turn addresses (validated: only a
// pending probe's id counts — the model can't invent coverage).
// How much of a question has to have been spoken for it to count as asked. A candidate who cut in
// on the last few words heard the question; one who cut in on the opening clause did not. The
// number is deliberately a constant in code rather than a model judgement — whether a probe was
// covered decides whether an interview may end, and that must be reproducible.
const DELIVERY_COVERAGE_MIN = 0.7;

function probeUncoveredByInterruption(questionTurn) {
  if (!questionTurn?.probeId) return false;
  const total = String(questionTurn.text || "").length;
  if (!total) return true;
  const spoken = Number(questionTurn.interruptedAtChar);
  if (!Number.isFinite(spoken)) return true; // interrupted, but we don't know where — assume not heard
  return spoken / total < DELIVERY_COVERAGE_MIN;
}

function markProbeAsked(ai, probeId) {
  if (!probeId) return;
  const probe = (ai.probes || []).find((p) => p.claimId === probeId && p.status === "pending");
  if (!probe) return;
  probe.status = "asked";
  probe.turnIndex = ai.turns.length - 1; // the question turn just pushed
  probe.askedAt = new Date();
}

// ---- Recruiter-approved must-ask questions (models/QuestionSet.js) ----------
//
// Required coverage in the same sense as claim-probes, with one difference that is the whole
// point of the feature: these are delivered VERBATIM by code. The model is never asked to
// produce them and never given the chance to reword one — a paraphrase is a different question,
// and "every candidate for this role was asked the same thing" stops being true the moment one
// candidate gets the recruiter's wording and the next gets the model's.

function pendingMustAsk(ai) {
  return (ai.mustAsk || []).filter((q) => q.status === "pending");
}

// Everything a newly generated question must not resemble: what has already been asked, AND the
// recruiter-approved questions still queued to be asked verbatim later.
//
// The forward half is the part that was missing. An approved question is delivered by code, word
// for word, at the turn the schedule reaches it — so a model that asks its own version first has
// not saved a turn, it has guaranteed a duplicate. The candidate hears the same question twice and
// the second one is the one that counts, which reads as nothing having listened the first time.
function forbiddenQuestionTexts(ai) {
  const asked = Array.isArray(ai.askedQuestions) ? ai.askedQuestions : [];
  return asked.concat(pendingMustAsk(ai).map((q) => q.text).filter(Boolean));
}

// An approved question whose ground has already been covered by a question actually asked.
//
// Returns the matching asked text, or null. Deliberately uses the SAME comparison as the repeat
// guard rather than an exact-string test: the pre-emption that caused this was word-for-word once
// and reworded twice, and only one of those three would have been caught by equality.
function mustAskAlreadyCovered(ai, must) {
  const dup = questionSimilarity.findDuplicate(
    must.text,
    (Array.isArray(ai.askedQuestions) ? ai.askedQuestions : [])
  );
  return dup.duplicate ? { matched: dup.matched, reason: dup.reason } : null;
}

function markMustAskAsked(ai, questionId) {
  if (!questionId) return;
  const q = (ai.mustAsk || []).find((m) => m.questionId === questionId && m.status === "pending");
  if (!q) return;
  q.status = "asked";
  q.turnIndex = ai.turns.length - 1; // the question turn just pushed
  q.askedAt = new Date();
}

// Same rule as a probe: a question the candidate talked over was not really asked.
function mustAskUncoveredByInterruption(questionTurn) {
  if (!questionTurn?.mustAskId) return false;
  const total = String(questionTurn.text || "").length;
  if (!total) return true;
  const spoken = Number(questionTurn.interruptedAtChar);
  if (!Number.isFinite(spoken)) return true;
  return spoken / total < DELIVERY_COVERAGE_MIN;
}

// Which approved question to deliver next, or null to hand the turn to the adaptive engine.
//
// The cadence alternates — approved question, then one adaptive follow-up on whatever the
// candidate just said, then the next approved question. That is what keeps the set from being a
// form read end to end: the recruiter's questions anchor the comparison, the follow-ups do the
// actual probing. When the remaining budget no longer covers what still has to be asked, the
// alternation stops and coverage wins: an approved question is the part that must not be
// dropped.
function chooseMustAsk(ai) {
  // Anything whose ground a question actually asked has already covered is retired here rather
  // than read out again. WHY IT IS RETIRED AND NOT SKIPPED: an approved question that stays
  // `pending` forever would make the interview look incomplete to reviewRequiredReason and to the
  // coverage numbers on the report, when in fact the candidate answered it — they simply answered
  // the model's copy of it. The record says which turn covered it, so "was q2 asked?" stays
  // answerable and stays honest about how.
  for (const q of pendingMustAsk(ai)) {
    const covered = mustAskAlreadyCovered(ai, q);
    if (!covered) continue;
    q.status = "asked";
    q.preEmpted = true;
    q.askedAt = new Date();
    const idx = (ai.turns || []).findIndex(
      (t) => t.role === "ai" && String(t.text || "") === String(covered.matched || "")
    );
    if (idx >= 0) q.turnIndex = idx;
    console.warn(
      `[aiInterview] approved question ${q.questionId} was already covered by an earlier question ` +
        `(${covered.reason}) — retiring it instead of asking it again: "${q.text}" ≈ "${covered.matched}"`
    );
  }

  const pending = pendingMustAsk(ai);
  if (!pending.length) return null;

  const remaining = (ai.maxQuestions || 0) - (ai.questionCount || 0);
  const reserved = pending.length + pendingProbes(ai).length;
  if (remaining <= reserved) return pending[0];

  const lastQuestion = [...(ai.turns || [])].reverse().find((t) => t.role === "ai" && t.kind === "question");
  if (lastQuestion?.mustAskId) return null; // the last turn was an approved one — follow up on it
  return pending[0];
}

function clampScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return undefined;
  return Math.max(0, Math.min(100, Math.round(v)));
}

// Whether a model-supplied number is usable AS a score, which is a different question from what
// clampScore answers. clampScore is for per-answer numbers, where an out-of-range value is a
// sloppy reading of one answer and squashing it into the scale costs almost nothing.
//
// The final evaluation is not that. Its overallScore is the one model-supplied number that reaches
// a hiring decision unmediated — interviewReportEngine.computeVerdict thresholds it straight into
// ADVANCE / CLEAR_REJECT · confidence High. Clamping there would be worse than useless: a provider
// returning -50 or 5000 has not scored the candidate low or high, it has failed to answer, and
// clamping turns that failure into a confident automated rejection of a real person.
//
// So this is a validity test, not a repair. Out of range means malformed, and malformed is handled
// the way every other malformed LLM response in this file is handled — degrade to the deterministic
// fallback, which never emits an adverse recommendation.
const SCORE_FIELDS = ["overallScore", "communication", "technicalKnowledge", "problemSolving"];

// Deliberately `typeof === "number"` rather than a Number() coercion. `Number(null)` is 0, and 0
// is a perfectly legal score — so a coercing check silently turns a MISSING evaluation into the
// lowest possible one, which computeVerdict reads as CLEAR_REJECT · confidence High. Same trap for
// `""`. A string "82" is rejected for the same reason: the schema asks for an integer, so anything
// else is the provider not answering, and every coercion here is one more way an absence becomes a
// rejection.
function usableAsScore(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
}

// ---- How much of the instrument actually produced evidence -----------------
//
// A declined question ("I don't know") is asked-but-unanswered. It is deliberately NOT scored
// zero — see the `declined` field on models/InterviewSession.js for why conflating a candid
// decline with a wrong answer is both unfair and self-defeating. But excluding it silently would
// be its own lie: a mean over the two questions someone answered would read exactly like a mean
// over eight, and would flatter the candidate who declined most.
//
// So it is excluded from the mean AND counted, and the count travels with the score everywhere
// the score goes. That is the whole resolution: neither number is fabricated, and a human can
// see what the number is actually over.
function coverageStats(ai) {
  const answers = (ai.turns || []).filter((t) => t.role === "candidate" && t.kind === "answer");
  const declined = answers.filter((t) => t.declined).length;
  return {
    asked: ai.questionCount || 0,
    answered: answers.length - declined,
    declined,
    // Of those declines, how many were an ABSENCE rather than an act — nothing captured, cause
    // unknown (handleNoResponse). Reported separately because "the candidate told us they couldn't
    // answer" and "we have no recording of this question" are different findings, and only the
    // first is about the candidate. Both stay out of the score either way.
    noResponse: answers.filter((t) => t.declineAct === "no_response").length,
    // Did this interview actually engage the candidate's résumé, and by which mechanism?
    //
    // Rule 5, at the place it matters most. "The interview asked about their background" was
    // previously unanswerable from the record: an interview that verified three résumé claims and
    // one that never mentioned the document produced identical-looking sessions. These four
    // numbers make the difference legible on the report, in the API, and in a discrimination
    // claim — including the case where BOTH are zero, which must never be quietly rendered as a
    // complete interview.
    resume: {
      probesAsked: (ai.probes || []).filter((p) => p.status !== "pending").length,
      probesTotal: (ai.probes || []).length,
      anchorsCovered: (ai.resumeAnchors || []).filter((a) => a.status === "covered").length,
      anchorsTotal: (ai.resumeAnchors || []).length,
      // Why there were no claim-probes, when there were none (probeService). "no_assessment" is
      // by far the commonest and means the job has no approved RoleRubric.
      probeEngineReason: ai.probeEngineReason || "",
      // The honest headline: did the document get referenced at all?
      grounded:
        (ai.probes || []).some((p) => p.status !== "pending") ||
        (ai.resumeAnchors || []).some((a) => a.status !== "pending"),
    },
  };
}

// ONE FURTHER OPPORTUNITY ON A NON-ANSWER.
//
// THE FAILURE THIS FIXES. A four-word reply was recorded as the answer and the interview moved
// straight on. A human interviewer does not do that — they leave a beat and say "anything else?"
// — and the gap mattered most for the candidates least likely to volunteer more: someone
// interviewing in a second language, someone nervous, someone who did not realise how much detail
// was wanted. The interview then scored them on a reply they were never given the chance to
// finish.
//
// WHY THE TRIGGER IS WORD COUNT AND NOT QUALITY. This is the same line utils/groundedAck draws.
// A nudge fired because a model judged an answer weak would be a covert score disclosure — the
// candidate learns their standing from whether they get asked twice — and it would vary the
// instrument by how well someone was doing, which destroys comparability. Word count is
// CONTENT-BLIND: it says nothing about whether the answer was right, only that there is very
// little of it to assess, which is a fact about the recording rather than about the person.
//
// WHY ONCE. Twice is pressure, and pressure is not a measurement. If they have nothing more to
// add, that is a real answer and the interview accepts it and moves on.
const NUDGE_MIN_WORDS = Number(process.env.INTERVIEW_NUDGE_MIN_WORDS || 12);

// Fixed wording, no variation, no name, no reference to the answer. Every candidate who crosses
// the threshold hears exactly this — which is what stops the nudge itself becoming a signal.
// Phrased as an invitation, never as a verdict: it does not say the answer was short, incomplete,
// or in need of improvement, because saying any of that is telling them how they are doing.
const NUDGE_PHRASE = "Would you like to add anything more to that?";

/**
 * Should the interview offer one further opportunity on the answer just recorded?
 *
 * Pure and content-blind. Returns the question turn to mark, or null.
 */
function nudgeTargetFor(ai) {
  const turns = ai.turns || [];
  const answer = [...turns].reverse().find((t) => t.role === "candidate");
  // Only a real, attempted answer to a real question. A decline is an answer and is respected as
  // one — asking a candidate who has just said they cannot answer whether they would like to add
  // anything is the single most tone-deaf thing available here.
  if (!answer || answer.kind !== "answer" || answer.declined) return null;
  if (wordCount(answer.text) >= NUDGE_MIN_WORDS) return null;

  const answerIndex = turns.lastIndexOf(answer);
  const question = [...turns.slice(0, answerIndex)].reverse().find((t) => t.role === "ai");
  if (!question) return null;
  // The closing sequence is SHORT BY DESIGN (utils/closingQuestions marks its closers "easy") and
  // the warmup is not part of the instrument. Nudging on either would be the interview arguing
  // with its own script.
  if (!ASKABLE_KINDS.has(question.kind) || question.kind === "warmup") return null;
  if (closingQuestions.CLOSING_KINDS.has(question.kind)) return null;
  if (question.nudged) return null;
  return question;
}

// An absence longer than this is reported to a human. Not because it is suspicious — the
// overwhelmingly likely cause is a phone losing signal — but because a gap this long means part of
// the interview happened under conditions nobody observed, and an automated recommendation should
// not be the last word on a session with a hole in it. Deliberately a constant, so it is the same
// for every candidate and can be stated without reading a config.
const NOTABLE_ABSENCE_MS = 45_000;

/**
 * Record that the candidate left the room, came back, or never came back.
 *
 * Realtime only, called by the worker through the portal. Appends to an audit list and nothing
 * else: it touches no score, no status and no pipeline stage. See InterviewSession.presence for
 * why treating a disconnection as a signal about the candidate would be a disparate-impact machine.
 */
async function recordPresence(session, { event, awayMs } = {}) {
  const ai = session.aiInterview;
  if (!ai) return null;
  if (!["left", "rejoined", "abandoned"].includes(event)) {
    throw Object.assign(new Error("Unknown presence event"), { status: 400 });
  }
  ai.presence = ai.presence || [];
  ai.presence.push({
    event,
    at: new Date(),
    ...(Number.isFinite(awayMs) && awayMs >= 0 ? { awayMs: Math.round(awayMs) } : {}),
    turnIndex: Math.max(0, (ai.turns || []).length - 1),
  });
  await session.save();
  console.info(
    `[aiInterview] presence: candidate ${event}` +
      (Number.isFinite(awayMs) ? ` after ${Math.round(awayMs / 1000)}s away` : "") +
      ` (session ${session._id})`
  );
  return { recorded: true, event };
}

// The longest single absence recorded on this session, in ms. Zero when the candidate never
// dropped, which is the ordinary case.
function longestAbsenceMs(ai) {
  return (ai?.presence || []).reduce((max, p) => Math.max(max, Number(p.awayMs) || 0), 0);
}

// Beyond this share of declined questions, there is not enough demonstrated evidence for an
// automated recommendation to mean anything. Deliberately a constant in code rather than a model
// judgement or a tenant setting: "was there enough evidence to decide?" is the question an
// automated hiring decision is most likely to be challenged on, and the answer has to be the same
// for every candidate and stateable without reading a config.
const MAX_DECLINE_SHARE = 0.5;

// Whether CODE overrules the model's recommendation and routes to a human, and why.
//
// This is rule 6 (every automated adverse action needs a human) applied at the point it actually
// bites. A model handed a two-turn transcript will still confidently return "no_hire" — it has no
// way to know that the transcript is short because the candidate withdrew rather than because
// they failed. That distinction is not the model's to make, so it is not asked to.
function reviewRequiredReason(ai) {
  // The interviewer broke its own rules and we stopped it. Whatever is in this transcript, it was
  // not produced under the conditions the instrument specifies, so no automated conclusion may be
  // drawn from it — in either direction. This is checked FIRST because it is the one case where
  // the defect is ours rather than anything about the candidate.
  if (ai.status === "halted") {
    return (
      "the interview was stopped automatically because the AI interviewer went outside its approved " +
      "script, so this transcript was not produced under the conditions the assessment requires. " +
      "This is a fault on our side and must not count against the candidate"
    );
  }
  if (ai.status === "ended_early") {
    return "the candidate chose to end the interview before it finished, so most of the instrument was never run";
  }
  // Distinct from halted above: THIS one is about the candidate's own proctoring signals, not a
  // fault on our side — so the framing must not borrow halted's "must not count against them"
  // language. It is still neutral, not accusatory: the flags are advisory evidence for a human to
  // weigh alongside the partial transcript, never a verdict this code is entitled to reach itself.
  if (ai.status === "integrity_terminated") {
    return (
      "the interview was ended automatically after repeated proctoring integrity signals, so it did not run " +
      "to completion. A human must review the transcript and the flagged signals before any decision is made"
    );
  }
  // The link expired with the interview still open. A candidate who gave up and a voice pipeline
  // that failed them produce the IDENTICAL record here, and that is not a distinction this system
  // can make — so no automated conclusion may be drawn in either direction. The partial answers
  // below are scored so the recruiter can read what exists, never so a machine can decide on it.
  if (ai.status === "abandoned") {
    return (
      "the interview was left unfinished and its link expired before the candidate returned, so most " +
      "of the instrument was never run. Whether they stopped or something on our side failed them is " +
      "not knowable from this record — a human must review it, and it must not count against them"
    );
  }
  // A question where nothing was captured at all. Checked BEFORE the decline share, and with no
  // threshold, because it is a different kind of fact: a decline is evidence (the candidate told
  // us something), whereas this is a hole where evidence should be, and we cannot say whose fault
  // the hole is. A dead microphone and a candidate sitting silent produce identical records.
  //
  // Guessing costs asymmetrically — guess "they declined" and a candidate is marked down for our
  // audio failing — so it is not guessed. One occurrence is enough: a person looks.
  const noResponse = (ai.turns || []).filter((t) => t.declineAct === "no_response" && t.kind === "answer").length;
  if (noResponse > 0) {
    return (
      `no answer was captured at all for ${noResponse} question${noResponse === 1 ? "" : "s"} — this looks ` +
      `identical whether the candidate stayed silent or their microphone failed, and that is not a ` +
      `distinction this system can make. It must be checked by a person before any decision`
    );
  }
  const c = coverageStats(ai);
  if (c.asked > 0 && c.declined / c.asked > MAX_DECLINE_SHARE) {
    return `the candidate declined ${c.declined} of ${c.asked} questions, leaving too little demonstrated evidence to support an automated recommendation`;
  }
  // Part of this interview happened while the candidate was not connected. Almost always a phone
  // losing signal, occasionally something else — and this system has no way to tell which, so it
  // does not try. It says what it observed and hands the session to a person.
  const away = longestAbsenceMs(ai);
  if (away >= NOTABLE_ABSENCE_MS) {
    return (
      `the candidate's connection dropped mid-interview and was gone for about ` +
      `${Math.round(away / 1000)} seconds. A dropped phone connection and a candidate stepping away ` +
      `look identical from here, so this is not a judgement about them — it means part of the ` +
      `interview ran under conditions nobody observed, and a person should look before any decision`
    );
  }
  return null;
}

async function loadRefs(session) {
  const candidate = await Candidate.findById(session.candidate).populate("job");
  if (!candidate) throw Object.assign(new Error("Candidate not found for interview"), { status: 404 });
  const job = candidate.job;
  if (!job) throw Object.assign(new Error("Job not found for interview"), { status: 404 });
  return { candidate, job };
}

function loadSettings(companyId) {
  return CompanySettings.findOne({ company: companyId }).select("ai compliance");
}

// The approved rubric for this role, or null. Read only for its `spokenCommunication`
// declaration — whether this role assesses how clearly a candidate explained things, and the
// written reason a human gave for that. A lookup failure means NOT assessed, which is the safe
// direction: the feature is off unless someone positively declared it on.
async function loadRubric(session, job) {
  try {
    return await RoleRubric.findOne({ company: session.company, job: job._id, status: "approved" })
      .sort({ version: -1 })
      .lean();
  } catch (err) {
    console.error("[aiInterview] rubric lookup failed; spoken communication stays unassessed:", err.message);
    return null;
  }
}

// Whether the external LLM may process this candidate's data. Consent is required by
// default; a tenant can waive the requirement via compliance.aiConsentRequired=false.
function consentOk(candidate, settings) {
  const required = settings?.compliance?.aiConsentRequired !== false;
  if (!required) return true;
  return Boolean(candidate?.consent?.aiProcessing);
}

// Gate: is the real AI engine allowed for this call right now?
async function aiUsable(session, candidate, settings) {
  if (!llm.isEnabled()) return false;
  if (!consentOk(candidate, settings)) return false;
  try {
    if (await usageService.isOverBudget(session.company, settings?.ai)) {
      console.warn(`[aiInterview] company ${session.company} over LLM budget — using fallback`);
      return false;
    }
  } catch (err) {
    // Metering failure must not block interviews — fail open on the budget check.
    console.error("[aiInterview] budget check failed, proceeding:", err.message);
  }
  return true;
}

// ---- Deterministic fallbacks (no key / no consent / over budget) ----
function fallbackPlan(job) {
  const years = job.minExperienceYears || 0;
  const difficulty = years >= 5 ? "hard" : years >= 2 ? "medium" : "easy";
  const topics = job.requiredSkills && job.requiredSkills.length ? job.requiredSkills.slice(0, 6) : ["fundamentals", "projects", "problem solving"];
  return {
    role: job.title,
    difficultyEstimate: difficulty,
    topics,
    focusAreas: (job.requiredSkills || []).slice(0, 3),
    summary: `Screening interview for ${job.title}, targeting ${difficulty} difficulty.`,
  };
}

const GENERIC_QUESTIONS = [
  "Tell me about a project you're most proud of and your specific role in it.",
  "Walk me through the architecture of one system you built. What were the main trade-offs?",
  "How do you approach debugging a problem you've never seen before?",
  "Describe a time you had to learn a new technology quickly. How did you do it?",
  "What does 'good code' mean to you, and how do you make sure your work meets that bar?",
  "Tell me about a technical decision you disagreed with. How did you handle it?",
  "How would you go about improving the performance of a slow API endpoint?",
  "Describe how you'd design data storage for a feature with heavy read traffic.",
];

// Content-blind completeness heuristic (word count only) — this is NOT a judgement of
// correctness, only of whether the candidate engaged with the question at all. A
// non-responsive answer (too short / filler — see interviewReportEngine.isResponsive)
// must score near zero: it must never look like a borderline "review" score.
function fallbackAnswerScore(text) {
  const words = wordCount(text);
  if (!isResponsive(text)) return Math.min(15, words * 2);
  return Math.min(90, 20 + words * 2);
}

function fallbackQuestion({ ai, job }) {
  const asked = new Set(ai.askedQuestions);
  const lastAnswer = [...ai.turns].reverse().find((t) => t.role === "candidate");
  const answerScore = lastAnswer ? fallbackAnswerScore(lastAnswer.text) : 0;

  // Claim-probes are required coverage even on the deterministic path — their
  // questions were generated (and neutrality-checked) up front, so the fallback
  // can ask them verbatim.
  const probe = pendingProbes(ai).find((p) => !asked.has(p.question));
  if (probe) {
    return { answerScore, difficulty: ai.currentDifficulty, topic: "resume claims", question: probe.question, probeId: probe.claimId, anchorId: "", isClosing: false };
  }

  // Résumé anchors are required coverage on the deterministic path too. Unlike a probe there is
  // no pre-generated wording, so the question is composed from a fixed template — plain, neutral,
  // and asking what they DID rather than whether they "have experience", which invites a yes.
  const anchor = pendingAnchors(ai).find((a) => !asked.has(anchorFallbackQuestion(a)));
  if (anchor) {
    return {
      answerScore,
      difficulty: ai.currentDifficulty,
      topic: "résumé",
      question: anchorFallbackQuestion(anchor),
      probeId: "",
      anchorId: anchor.id,
      isClosing: false,
    };
  }

  const skillQs = (job.requiredSkills || []).map(
    (s) => `Can you explain how you've used ${s} in practice, and a limitation you ran into with it?`
  );
  const pool = [...skillQs, ...GENERIC_QUESTIONS];
  const question = pool.find((q) => !asked.has(q)) || GENERIC_QUESTIONS[ai.questionCount % GENERIC_QUESTIONS.length];

  return { answerScore, difficulty: ai.currentDifficulty, topic: "general", question, probeId: "", anchorId: "", isClosing: false };
}

// The deterministic wording for an anchor. A template rather than a model call because this path
// exists precisely for when there is no model — and because a fixed phrasing is one fewer thing
// that can vary between two candidates asked about the same kind of claim.
function anchorFallbackQuestion(anchor) {
  const focus = anchor.focus && anchor.focus.toLowerCase() !== anchor.term.toLowerCase() ? anchor.focus : "";
  if (anchor.kind && anchor.kind.startsWith("project")) {
    return focus
      ? `Your résumé lists ${anchor.term}. What did you build with ${focus} on it, and what was the hardest part?`
      : `Your résumé lists ${anchor.term}. What did you build there, and what was the hardest part?`;
  }
  if (anchor.kind && anchor.kind.startsWith("experience")) {
    return focus
      ? `At ${anchor.term}, what did you actually work on with ${focus}?`
      : `At ${anchor.term}, what were you responsible for day to day?`;
  }
  return `Your résumé lists ${anchor.term}. Tell me about the last thing you used it for and what you had to work out.`;
}

// The fallback must NEVER produce an adverse hiring decision — it routes to human review.
// Phase 9.2: unscored answers are EXCLUDED from the mean instead of being
// backfilled with a fabricated 55; with nothing scored the overall is null and
// the report honestly says "not measured".
function fallbackEvaluation(ai) {
  const scored = ai.turns
    .filter((t) => t.role === "candidate" && typeof t.answerScore === "number")
    .map((t) => t.answerScore);
  const overall = scored.length ? Math.round(scored.reduce((s, v) => s + v, 0) / scored.length) : null;
  return {
    overallScore: overall,
    // The heuristic only measures answer completeness, never per-competency depth —
    // leaving these unset (rather than copying `overall` into all three) means the
    // report correctly shows "not measured" instead of three identical fake scores.
    communication: undefined,
    technicalKnowledge: undefined,
    problemSolving: undefined,
    strengths: [],
    weaknesses: [],
    missingSkills: [],
    recommendation: "review", // never strong_hire/hire/maybe/no_hire from a heuristic
    summary:
      "Automated evaluation is unavailable (AI provider not configured, consent not given, or budget exhausted). " +
      (scored.length
        ? "These indicative scores come from answer-completeness heuristics and must NOT drive a hiring decision — a human should review the transcript."
        : "No answers were scored, so nothing here is measured — a human must review the transcript directly."),
    generatedBy: "fallback",
    provider: null,
    model: null,
    promptVersion: null,
  };
}

// ---- The opening (authored in code, never by the model) ----
//
// Candidates were previously dropped straight into question one. Nobody was greeted by name,
// nobody was told how long it would take, and nobody was told they could ask for a question to
// be repeated — an affordance the portal has always had and never mentioned. That is most of
// what makes a spoken interview feel like a form being read at you, and none of it needs a
// model: it is the same for every candidate for a role, so it is a constant, written here.

// A voice question plus its answer runs roughly two minutes. Rounded up to the nearest five so
// it reads as the estimate it is rather than as a promise we then break.
// Rounded to the nearest five minutes, and it has to cover everything the candidate will actually
// be asked — not just the approved budget.
//
// A candidate told "about twenty minutes" who is still answering questions at thirty-five has been
// misled about the one fact they may have scheduled their day around, and the interview turns into
// a thing they are trying to get out of. So the estimate includes the code-authored closing
// sequence and an allowance for the adaptive follow-ups: follow-ups are narrow single-point
// questions and answer faster than a competency question, hence the lighter weight.
function estimatedMinutes(maxQuestions, { closingCount = 0, followUpAllowance = 0 } = {}) {
  const weighted = maxQuestions * 2 + closingCount * 2 + followUpAllowance * 1;
  return Math.max(5, Math.ceil(weighted / 5) * 5);
}

function openingScript({ candidate, job, persona, maxQuestions, assessesCommunication = false }) {
  const first = String(candidate?.basicDetails?.name || "").trim().split(/\s+/)[0] || "there";
  const interviewer = String(persona?.name || "").trim() || "your interviewer";
  const role = job?.title ? ` for the ${job.title} role` : "";
  // Told before a single question is asked, and told plainly — including the part candidates most
  // need to hear, which is that thinking aloud and saying "I'm not sure" are not penalised. A
  // candidate assessed on how clearly they explain things, who is not told, cannot adjust; and an
  // assessment somebody was never informed of is one that cannot be defended for a moment.
  const communicationNotice = assessesCommunication
    ? " One more thing worth knowing: for this role, how clearly you explain things is part of what's " +
      "looked at, alongside what you say. That means being specific and easy to follow — not " +
      "speaking quickly or smoothly. Thinking out loud is fine, pausing is fine, and saying you're " +
      "not sure about something counts in your favour rather than against you."
    : "";
  // The whole shape of the interview, so the quoted length and question count are the real ones.
  const closingCount = closingQuestions.closingSequence({ seed: 0 }).length;
  const followUpAllowance = followUpPrompts.MAX_FOLLOW_UPS;
  // "Around N" is honest about a number that genuinely varies with how many follow-ups the
  // candidate's own answers earn — so it quotes the ceiling rather than the floor. A candidate who
  // is asked fewer than they were promised is relieved; one asked more feels misled.
  const questionsQuoted = maxQuestions + closingCount + followUpAllowance;
  return {
    intro:
      `Hi ${first} — my name is ${interviewer}, and I'll be running your interview${role} today. ` +
      `Here's how this will go. I'll start by asking you to introduce yourself, and then I'll ask you up to ` +
      `${questionsQuoted} questions covering your background and your experience — some of them follow-ups on ` +
      `whatever you tell me, so the exact number depends on our conversation. It usually takes about ` +
      `${estimatedMinutes(maxQuestions, { closingCount, followUpAllowance })} minutes in total. ` +
      `There's no rush on any of it — take the time you need to think before you answer, and if you'd like me ` +
      `to repeat a question at any point, just ask.` +
      communicationNotice,
    warmup: WARMUP_QUESTION,
  };
}

// The opening self-introduction. A constant, not a template — it depends on nothing about the
// candidate, the job or the persona, which is what lets the name-pronunciation path deliver it
// without rebuilding the opening script.
const WARMUP_QUESTION =
  "So, whenever you're ready — could you start with a short introduction? " +
  "Just who you are, and what you've been working on recently.";

// ---- "How do you say your name?" (LEGACY — the ask is retired) ---------------
//
// Nothing inserts a name_check turn any more (owner decision 2026-08-18, see beginInterview).
// This handler stays so a session that was mid-name-check when the ask was retired still
// completes correctly, and so stored respellings on old sessions keep rendering.
//
// The candidate's answer to the name check. Their pronunciation is stored as a RENDERING
// PARAMETER (utils/namePronunciation.js): applied between the approved text and the speech engine
// exactly as utils/speakable expands "K8s", never scored, and structurally excluded from every
// evaluation path. The turn is recorded so the transcript is a complete account of what was said.
//
// Then the warmup is delivered and the interview proceeds as it always did. Failure to understand
// the answer is not a failure of anything: the name is spoken as written, which is the behaviour
// that shipped before this feature.
async function recordNamePronunciation(session, text) {
  const ai = session.aiInterview;
  ai.turns.push({ role: "candidate", kind: "name_answer", text, inputMode: ai.modality === "voice" ? "voice" : "text" });

  const attempts = (ai.namePronunciation?.attempts || 0) + 1;
  const parsed = namePronunciation.fromSelfReport(text, ai.candidateFirstName);
  ai.namePronunciation = {
    respelling: parsed?.respelling || "",
    source: parsed?.source || undefined,
    attempts,
    distance: parsed?.plausibility?.distance,
    allowed: parsed?.plausibility?.allowed,
  };

  // One retry, and only when we genuinely could not make it out — never to "check" an answer we
  // did understand, which would ask a candidate to justify the pronunciation of their own name.
  if (!parsed && attempts < namePronunciation.MAX_ATTEMPTS) {
    ai.turns.push({
      role: "ai",
      kind: "name_check",
      text: "Sorry — I didn't quite catch that. Could you say your name once more for me?",
    });
    await session.save();
    return publicState(session);
  }

  ai.turns.push({ role: "ai", kind: "warmup", text: WARMUP_QUESTION });
  ai.askedQuestions.push(WARMUP_QUESTION);
  await session.save();
  return publicState(session);
}

function closingScript(candidate) {
  const first = String(candidate?.basicDetails?.name || "").trim().split(/\s+/)[0];
  return (
    `That's everything I wanted to cover${first ? `, ${first}` : ""} — thank you for taking the time today. ` +
    `Your answers have been recorded, and the team will be in touch about the next steps. All the best.`
  );
}

// The closing when the candidate ended it themselves. Authored here, in code, for the same reason
// as every other spoken turn — and this one carries a promise, so its wording is not the model's
// to improvise.
//
// What it deliberately does NOT do: express regret, ask why, or offer to continue. Any of those
// would be pressure applied at the exact moment someone has said they want to stop, and the whole
// value of the exit is that it is honoured without negotiation. It also does not imply the
// application is over — ending an interview is the candidate's decision about this session, and
// what happens to their application is the hiring team's, not this machine's, to announce.
function withdrawalScript(candidate) {
  const first = String(candidate?.basicDetails?.name || "").trim().split(/\s+/)[0];
  return (
    `Understood${first ? `, ${first}` : ""} — we'll stop here. Thank you for the time you've given today. ` +
    `Everything you've said so far has been recorded and will go to the hiring team along with your ` +
    `application, and a person will review it. Nothing further is needed from you. All the best.`
  );
}

// ---- LLM steps (metered, with graceful fallback) ----
async function makePlan({ session, candidate, job, settings, context, useAi }) {
  if (!useAi) return { plan: fallbackPlan(job), engine: "fallback" };
  const t0 = Date.now();
  try {
    // Model comes from the registry (never a bare string in business logic) with
    // the tenant's CompanySettings override applied — Phase 2.5.
    const resolved = resolveRole("interview", settings);
    const { data, usage, model, cached } = await llm.generateJSON({
      system: INTERVIEWER_SYSTEM,
      prompt: planPrompt(context),
      schema: PLAN_SCHEMA,
      maxTokens: 640,
      model: resolved.model,
      temperature: settings?.ai?.temperature,
      promptVersion: PROMPT_VERSION,
    });
    await usageService.recordUsage({ company: session.company, session: session._id, candidate: candidate._id, kind: "plan", provider: PROVIDER, model, usage, latencyMs: Date.now() - t0, engine: "ai", promptVersion: PROMPT_VERSION, cached });
    return { plan: data, engine: "ai" };
  } catch (err) {
    console.error(`[aiInterview] plan generation failed, using fallback (${err.code || "no code"}): ${err.message}`);
    return { plan: fallbackPlan(job), engine: "fallback" };
  }
}

async function nextQuestion({ session, candidate, job, settings, ai, context, useAi }) {
  if (!useAi) return { ...fallbackQuestion({ ai, job }), engine: "fallback", model: null, latencyMs: 0 };

  // ONE generation attempt. Split out from the repeat guard below so the retry is a plain second
  // call carrying one extra instruction, rather than a second code path that could drift from
  // this one. `rejected` is null on the first attempt.
  async function attempt(rejected) {
    const t0 = Date.now();
    const resolved = resolveRole("interview", settings);
    const { data, usage, model, cached } = await llm.generateJSON({
      // Role-aware: for a marketing or operations role, an interviewer prompt that calls itself
      // "technical" reaches for competencies the rubric never asked about.
      system: interviewerSystemFor(job),
      prompt: questionPrompt({
        context,
        plan: ai.plan || {},
        turns: ai.turns,
        currentDifficulty: ai.currentDifficulty,
        askedQuestions: ai.askedQuestions,
        questionCount: ai.questionCount,
        minQuestions: ai.minQuestions,
        maxQuestions: ai.maxQuestions,
        probes: pendingProbes(ai),
        mustAsk: pendingMustAsk(ai),
        anchors: pendingAnchors(ai),
        rejected,
      }),
      schema: QUESTION_SCHEMA,
      maxTokens: 512,
      model: resolved.model,
      temperature: settings?.ai?.temperature,
      promptVersion: PROMPT_VERSION,
    });
    const latencyMs = Date.now() - t0;
    await usageService.recordUsage({ company: session.company, session: session._id, candidate: candidate._id, kind: "question", provider: PROVIDER, model, usage, latencyMs, engine: "ai", promptVersion: PROMPT_VERSION, cached });
    if (data.probeId) {
      const probe = pendingProbes(ai).find((p) => p.claimId === data.probeId);
      if (probe && !questionCoversProbe(data.question, probe)) {
        console.warn(
          `[aiInterview] generated question for probe ${data.probeId} drifted off its claim ` +
            `(session ${session._id}) — asking the probe's own wording instead`
        );
        data.question = probe.question;
        data.topic = "resume claims";
      }
    }
    // An anchor has no approved wording to fall back to (unlike a probe), so a stamp the question
    // does not honour is simply DROPPED rather than corrected. The anchor stays pending and gets
    // asked properly on a later turn — the one thing that must not happen is marking it covered.
    if (data.anchorId) {
      const anchor = pendingAnchors(ai).find((a) => a.id === data.anchorId);
      if (!anchor || !resumeAnchors.questionCoversAnchor(data.question, anchor)) {
        console.warn(
          `[aiInterview] question stamped anchor ${data.anchorId} but does not name it ` +
            `(session ${session._id}) — leaving the anchor uncovered`
        );
        data.anchorId = "";
      } else {
        data.topic = data.topic || "résumé";
      }
    }
    return { ...data, engine: "ai", model, latencyMs };
  }

  const t0 = Date.now();
  try {
    let result = await attempt(null);

    // THE REPEAT GUARD (utils/questionSimilarity).
    //
    // Until this existed the only thing stopping the interview asking the same question twice was
    // the prompt's own "Never repeat an already-asked question" — and a prompt is a request, not a
    // guarantee. A candidate hearing the same question again is the loudest possible signal that
    // nothing is listening, and it puts two scores for one competency into the evaluation.
    //
    // A question stamped with a probeId is EXEMPT. Claim-probes are required coverage: dropping
    // one because it resembles something already asked would silently shorten the instrument, and
    // "we skipped verifying that résumé claim because it looked familiar" is not a decision this
    // code gets to make on its own. It is logged instead, so a reviewer can see it happened.
    //
    // THE GUARD LOOKS FORWARD AS WELL AS BACK (see forbiddenQuestionTexts). Comparing only against
    // what has already been asked left the commonest repeat in the system wide open: the model
    // asking a recruiter-approved question BEFORE the code delivers it. utils/interviewPrompts
    // hands it the pending approved questions as text and tells it not to ask them, and in the
    // 2026-08-25 session it asked three of them anyway — one word for word — after which the
    // approved copy arrived verbatim a few turns later and was heard as a repeat, because it was
    // one. A prompt instruction was the only thing standing there; now it is a comparison.
    let dup = questionSimilarity.findDuplicate(result.question, forbiddenQuestionTexts(ai));
    if (dup.duplicate && result.probeId) {
      console.warn(
        `[aiInterview] probe ${result.probeId} resembles an already-asked question (session ${session._id}); ` +
          `asking it anyway — required coverage is not skippable`
      );
    } else if (dup.duplicate) {
      console.warn(
        `[aiInterview] rejected a repeat question (session ${session._id}, ${dup.reason}): ` +
          `"${result.question}" ≈ "${dup.matched}" — regenerating`
      );
      const retry = await attempt({ question: result.question, matched: dup.matched });
      const retryDup = questionSimilarity.findDuplicate(retry.question, forbiddenQuestionTexts(ai));
      if (!retryDup.duplicate) {
        result = retry;
      } else {
        // Twice in a row means the model is out of material on this candidate, not that it
        // misunderstood. The deterministic pool cannot repeat itself — it filters on the same
        // asked-list in code — so it is the correct thing to fall through to, and the engine is
        // recorded as "fallback" so the record shows a question this model did not choose.
        console.warn(
          `[aiInterview] regenerated question was also a repeat (session ${session._id}) — ` +
            `using the deterministic pool instead`
        );
        result = { ...fallbackQuestion({ ai, job }), answerScore: retry.answerScore, engine: "fallback", model: null, latencyMs: Date.now() - t0 };
      }
    }
    return result;
  } catch (err) {
    console.error(`[aiInterview] question generation failed, using fallback (${err.code || "no code"}): ${err.message}`);
    return { ...fallbackQuestion({ ai, job }), engine: "fallback", model: null, latencyMs: Date.now() - t0 };
  }
}

// Phase 9.1 — score any candidate answer that never got an answerScore. The
// hard-stop closing path returns before the next-question call (the only path
// that used to assign scores), so the FINAL answer of every full-length
// interview was historically unscored. Runs at finalisation, bias-blinded.
async function scoreUnscoredAnswers({ session, candidate, job, settings, ai, useAi }) {
  const blindContext = buildContext(candidate, job, { blind: true });
  for (let i = 0; i < ai.turns.length; i += 1) {
    const turn = ai.turns[i];
    if (turn.role !== "candidate" || typeof turn.answerScore === "number") continue;
    // ONLY a real answer is scored, and the test is positive on purpose. It used to exclude the
    // opening self-introduction by name (`kind === "warmup_answer"`), which meant every candidate
    // turn kind added afterwards was scored by default until someone remembered to exclude it —
    // and the first one added, `meta_question`, is a candidate asking "how many more are there?".
    // Scoring that against the question it interrupted is exactly the failure the kind exists to
    // prevent. Inverting the test makes silence the safe answer: a new kind is not part of the
    // instrument until it is deliberately made part of it.
    if (turn.kind !== "answer") continue;
    // A decline is not a wrong answer and must never be scored as one. Without this the whole
    // point of the decline path evaporates at finalisation: every "I don't know" would arrive
    // here unscored, get sent to the scoring prompt like any other answer, and come back as the
    // near-zero it structurally has to be — putting the fabricated number back into the mean by
    // the back door. It stays unscored and is reported as declined instead (coverageStats).
    if (turn.declined) continue;
    const questionTurn = [...ai.turns.slice(0, i)].reverse().find((t) => t.role === "ai" && t.kind === "question");
    if (!questionTurn) continue;

    if (!useAi) {
      turn.answerScore = fallbackAnswerScore(turn.text);
      continue;
    }
    const t0 = Date.now();
    try {
      const resolved = resolveRole("interview", settings);
      const { data, usage, model, cached } = await llm.generateJSON({
        system: INTERVIEWER_SYSTEM,
        prompt: answerScorePrompt({ context: blindContext, question: questionTurn.text, answer: turn.text }),
        schema: ANSWER_SCORE_SCHEMA,
        maxTokens: 128,
        model: resolved.model,
        temperature: settings?.ai?.temperature,
        promptVersion: PROMPT_VERSION,
      });
      await usageService.recordUsage({ company: session.company, session: session._id, candidate: candidate._id, kind: "evaluation", provider: PROVIDER, model, usage, latencyMs: Date.now() - t0, engine: "ai", promptVersion: PROMPT_VERSION, cached });
      // Same floor the fallback path has always applied (fallbackAnswerScore, `isResponsive`) —
      // a near-empty answer ("Okay.") must not receive a model-invented number. Observed live: a
      // 169ms "Okay." was scored 60/100 with nothing to justify it. Leaving it unscored is honest;
      // handing the model six words to render a verdict on is not a request it can decline.
      const score = isResponsive(turn.text) ? clampScore(data.answerScore) : undefined;
      if (score !== undefined) turn.answerScore = score;
    } catch (err) {
      // Leave it unscored — an honest gap beats a fabricated number (9.2 shows
      // "not measured" rather than inventing one).
      console.error("[aiInterview] late answer scoring failed (left unscored):", err.message);
    }
  }
}

// How clearly each answer was communicated, when the role declares that it assesses that.
//
// Runs at finalisation rather than per turn, for the same reason answer scoring does: it is slow,
// it is not needed to choose the next question, and doing it live would put a model call on the
// hottest path in the interview to produce a number nobody reads until the end.
//
// The whole point of utils/communication.js is that this NEVER sees the audio. It is handed the
// question and the transcript and nothing else — so pace, hesitation and filler rate cannot reach
// it even by accident, which is what makes the result accent-neutral by construction.
async function scoreCommunication({ session, candidate, ai, rubric, settings, useAi }) {
  if (!useAi) return; // the deterministic fallback has no view on how clearly someone spoke
  const excluded = Boolean(candidate?.accommodations?.excludeSpokenCommunication);
  if (!communication.isEnabled(rubric, { excluded })) {
    // Recorded rather than silently skipped: "this role does not assess it" and "this candidate
    // asked to be excluded" are different facts, and the second is one a candidate may later ask
    // us to confirm we honoured.
    ai.spokenCommunication = {
      assessed: false,
      reason: excluded ? "excluded_at_candidate_request" : "not_declared_for_this_role",
    };
    return;
  }

  for (let i = 0; i < ai.turns.length; i += 1) {
    const turn = ai.turns[i];
    if (turn.role !== "candidate" || turn.kind !== "answer" || turn.declined) continue;
    if (turn.communication) continue; // idempotent — finalisation can be retried
    const questionTurn = [...ai.turns.slice(0, i)].reverse().find((t) => t.role === "ai" && t.kind === "question");
    if (!questionTurn) continue;

    const t0 = Date.now();
    try {
      const resolved = resolveRole("cheap", settings);
      const { data, usage, model, cached } = await llm.generateJSON({
        system: COMMUNICATION_SYSTEM,
        prompt: communicationPrompt({ question: questionTurn.text, answer: turn.text }),
        schema: communication.FEATURE_SCHEMA,
        maxTokens: 600,
        model: resolved.model,
        temperature: 0,
        promptVersion: PROMPT_VERSION,
      });
      await usageService.recordUsage({ company: session.company, session: session._id, candidate: candidate._id, kind: "evaluation", provider: PROVIDER, model, usage, latencyMs: Date.now() - t0, engine: "ai", promptVersion: PROMPT_VERSION, cached });
      // Code does the arithmetic. The model returned observations; it never returned a number.
      turn.communication = communication.scoreAnswer(data, turn.text);
    } catch (err) {
      // Left unscored — an honest gap beats a fabricated number, and this is the score least
      // worth guessing at.
      console.error("[aiInterview] communication scoring failed (left unscored):", err.message);
    }
  }

  ai.spokenCommunication = {
    assessed: true,
    justification: String(rubric?.spokenCommunication?.justification || "").trim(),
  };
}

// The 13 rated axes behind the report's Cognitive Insights and Communication Skills panels.
//
// Runs at finalisation for the same reasons the other two scoring passes do: it is slow, it is
// not needed to choose the next question, and putting a model call on the hottest path of a live
// interview to produce a number nobody reads until the end is a bad trade.
//
// Like scoreCommunication, this NEVER sees the audio. It is handed the question, the transcript
// and the earlier transcripts, and nothing else — so pace, hesitation and filler rate cannot
// reach it even by accident. What it additionally gets, and communication scoring does not, is
// `transcriptConfidence`: not to score with, but to decide whether the grammar axis may be
// attributed to the speaker at all (utils/interviewInsights.js explains why that gate exists).
async function scoreInsights({ session, candidate, ai, rubric, settings, useAi }) {
  if (!useAi) return; // the deterministic fallback has no view on any of these

  // The communication panel rides on the rubric's spoken-communication declaration; the cognitive
  // panel does not, because reasoning about the work is what the interview is for. When the
  // declaration is absent we still extract, and the report simply never renders the communication
  // half — recorded here so a reviewer can see which of the two panels was in scope.
  const excluded = Boolean(candidate?.accommodations?.excludeSpokenCommunication);
  const communicationInScope = insights.communicationEnabled(rubric, { excluded });

  // Everything they have said so far, for the two cross-answer consistency indicators only.
  const said = [];

  for (let i = 0; i < ai.turns.length; i += 1) {
    const turn = ai.turns[i];
    if (turn.role !== "candidate" || turn.kind !== "answer" || turn.declined) continue;
    const questionTurn = [...ai.turns.slice(0, i)].reverse().find((t) => t.role === "ai" && t.kind === "question");
    if (!questionTurn) continue;
    if (turn.insights) {
      said.push(turn.text);
      continue; // idempotent — finalisation can be retried
    }

    const t0 = Date.now();
    try {
      const resolved = resolveRole("cheap", settings);
      const { data, usage, model, cached } = await llm.generateJSON({
        system: INSIGHTS_SYSTEM,
        prompt: insightsPrompt({
          question: questionTurn.text,
          answer: turn.text,
          earlier: said.length ? said.join("\n\n") : "",
        }),
        schema: insights.INSIGHT_SCHEMA,
        maxTokens: 2400,
        model: resolved.model,
        temperature: 0,
        promptVersion: PROMPT_VERSION,
      });
      await usageService.recordUsage({ company: session.company, session: session._id, candidate: candidate._id, kind: "evaluation", provider: PROVIDER, model, usage, latencyMs: Date.now() - t0, engine: "ai", promptVersion: PROMPT_VERSION, cached });
      // Code does the arithmetic. The model returned observations; it never returned a rating.
      turn.insights = insights.scoreAnswer(data, turn.text, turn.transcriptConfidence);
    } catch (err) {
      // Left unscored. An honest gap beats a fabricated number, and a panel that quietly drops one
      // answer is more honest than one that fills the hole with the average of the others.
      console.error("[aiInterview] insight scoring failed (left unscored):", err.message);
    }
    said.push(turn.text);
  }

  ai.insightsScope = { cognitive: true, communication: communicationInScope };
}

async function makeEvaluation({ session, candidate, job, settings, ai, useAi }) {
  if (!useAi) return fallbackEvaluation(ai);
  const t0 = Date.now();
  try {
    // Bias-blinded context: the candidate's name is withheld from the scoring prompt.
    const blindContext = buildContext(candidate, job, { blind: true });
    const resolved = resolveRole("interview", settings);
    const { data, usage, model, cached } = await llm.generateJSON({
      system: INTERVIEWER_SYSTEM,
      prompt: evaluationPrompt({ context: blindContext, turns: ai.turns }),
      schema: EVALUATION_SCHEMA,
      maxTokens: 1024,
      model: resolved.model,
      temperature: settings?.ai?.temperature,
      promptVersion: PROMPT_VERSION,
    });
    const latencyMs = Date.now() - t0;
    await usageService.recordUsage({ company: session.company, session: session._id, candidate: candidate._id, kind: "evaluation", provider: PROVIDER, model, usage, latencyMs, engine: "ai", promptVersion: PROMPT_VERSION, cached });
    // Metered first — the call was made and billed whether or not we can use what came back.
    //
    // Then the range check, BEFORE the spread. `...data` is what put an unchecked model integer
    // into evaluation.overallScore, and from there into computeVerdict. See usableAsScore.
    const unusable = SCORE_FIELDS.filter((k) => !usableAsScore(data?.[k]));
    if (unusable.length) {
      console.error(
        `[aiInterview] evaluation returned unusable ${unusable.map((k) => `${k}=${data?.[k]}`).join(", ")} ` +
          `(model ${model}); using fallback`
      );
      return fallbackEvaluation(ai);
    }
    return {
      ...data,
      generatedBy: "ai",
      provider: PROVIDER,
      model,
      promptVersion: PROMPT_VERSION,
      temperature: settings?.ai?.temperature ?? 0,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      latencyMs,
    };
  } catch (err) {
    console.error(`[aiInterview] evaluation failed, using fallback (${err.code || "no code"}): ${err.message}`);
    return fallbackEvaluation(ai);
  }
}

// Conduct exchanges that sit alongside the interview and never become "the open question" or
// "the last answer" — a candidate's claim about the record, and the code-authored fact-check of
// it (or a process question and its answer), are not the candidate moving the interview forward.
// Letting either flip into `lastAi`/`lastAnswer` below would replace the real open question with
// the side reply the moment it was recorded, which breaks the question-identity handshake
// (voiceAgentService.submitAnswer rejects the candidate's real next answer as a mismatch once
// `questionId` has silently moved to point at the reply instead).
const SIDE_CHANNEL_KINDS = new Set([
  "meta_question", "meta_answer", "already_answered_claim", "already_answered_reply",
]);

// The question turn currently open for an answer — the same "last real ai turn" publicState
// computes, exposed so a handler can look it up BEFORE pushing a side-channel exchange of its own
// (see handleAlreadyAnswered) without duplicating the exclusion list.
function openQuestionTurn(ai) {
  return [...(ai.turns || [])].reverse().find((t) => t.role === "ai" && !SIDE_CHANNEL_KINDS.has(t.kind));
}

// Candidate-facing view of the interview (never exposes the evaluation or provenance).
function publicState(session) {
  const ai = session.aiInterview;
  let lastAiIndex = -1;
  for (let i = ai.turns.length - 1; i >= 0; i--) {
    if (ai.turns[i].role === "ai" && !SIDE_CHANNEL_KINDS.has(ai.turns[i].kind)) { lastAiIndex = i; break; }
  }
  const lastAi = lastAiIndex >= 0 ? ai.turns[lastAiIndex] : undefined;
  const lastAnswer = [...ai.turns].reverse().find((t) => t.role === "candidate" && !SIDE_CHANNEL_KINDS.has(t.kind));
  return {
    // The open question's identity: its index in `turns`, which is append-only and therefore
    // stable for the life of the session. This is what lets a transport prove an answer is being
    // attached to the question it was actually given for (voiceAgentService.submitAnswer rejects
    // a mismatch) instead of to whatever the engine happens to think is current — the 2026-08-18
    // session recorded a decline against a question the candidate had already answered because
    // nothing carried this identity across the wire.
    questionId: ai.status === "in_progress" && lastAiIndex >= 0 ? `q${lastAiIndex}` : null,
    status: ai.status,
    engine: ai.engine,
    questionCount: ai.questionCount,
    maxQuestions: ai.maxQuestions,
    turns: ai.turns.map((t) => ({ role: t.role, kind: t.kind, text: t.text, at: t.at })),
    // The spoken greeting, surfaced separately from `turns` because the client speaks it ONCE,
    // ahead of the first question. It used to be pushed as a turn and rendered on screen but
    // never spoken by anything — so in a voice interview the candidate was never actually
    // greeted. Kept out of `currentQuestion` because it is not a question and must not be
    // re-spoken on every poll.
    intro: ai.turns.find((t) => t.kind === "intro")?.text || null,
    // The authored goodbye (closingScript / withdrawalScript), surfaced once the interview is
    // over. The realtime worker needs it the way the client needs `intro`: the closing is pushed
    // as a turn, but on the agent path nothing reads turns — so the candidate was hearing the
    // model improvise a goodbye while the authored one sat unspoken in the record. What the
    // candidate is promised at the end ("a person will review it") is not the model's to reword.
    closingMessage:
      ai.status !== "in_progress" && ai.status !== "not_started"
        ? [...ai.turns].reverse().find((t) => t.kind === "closing")?.text || null
        : null,
    currentQuestion: ai.status === "in_progress" ? lastAi?.text || null : null,
    // The current turn is the opening self-introduction rather than a scored question, so the UI
    // can label it honestly instead of counting it as "Question 0 of 8".
    currentIsWarmup: ai.status === "in_progress" && lastAi?.kind === "warmup",
    // What the interviewer says about the answer just given, BEFORE the current question
    // (utils/groundedAck.js). Spoken once, then the question — so the pair lands as one breath:
    // "You mentioned the Mumbai launch. — Let me ask you about something else now."
    //
    // Always a speakable string: when grounding failed for any reason, this is the uniform phrase
    // from the approved bank, which is what the interview said here before this feature existed.
    // `groundedAck` tells the UI whether it was grounded, so a reviewer's transcript can show which
    // acknowledgements were composed and which were the bank — never surfaced to the candidate.
    currentAck: ai.status === "in_progress" ? lastAnswer?.ack?.text || null : null,
    // Which frame it used, for a reviewer's transcript. Never shown to the candidate.
    currentAckShape: ai.status === "in_progress" ? lastAnswer?.ack?.shape || null : null,
    groundedAck: ai.status === "in_progress" ? Boolean(lastAnswer?.ack?.grounded) : false,
    // The current turn is an adaptive follow-up rather than part of the approved set. The browser
    // needs this for the same reason it needs currentQuestionBridges: a follow-up must NOT be
    // preceded by a change-of-subject phrase, because it is the opposite of a change of subject.
    currentIsFollowUp: ai.status === "in_progress" && lastAi?.kind === "follow_up",
    // The closing sequence (utils/closingQuestions.js), so the UI can stop counting these against
    // the question budget — they are additive and would otherwise read as "Question 9 of 8".
    currentIsClosingSequence:
      ai.status === "in_progress" && closingQuestions.CLOSING_KINDS.has(lastAi?.kind),
    // The interviewer is asking how to say the candidate's name. Not a question of the instrument,
    // so the UI labels it as such and does not number it.
    currentIsNameCheck: ai.status === "in_progress" && lastAi?.kind === "name_check",
    // The interviewer is offering one further opportunity on the answer just given
    // (NUDGE_PHRASE). Not a question of the instrument, so the UI must not number it and must not
    // count it against the budget — a candidate told they are on "question 5 of 8" because they
    // gave a short answer would be learning something about their standing from the counter.
    currentIsNudge: ai.status === "in_progress" && lastAi?.kind === "nudge",
    // How to SAY the candidate's name, as they gave it. A rendering parameter handed to whatever
    // speaks — never a measurement, never scored. Empty when we could not verify an answer, in
    // which case the name is spoken as written.
    namePronunciation: ai.namePronunciation?.respelling || null,
    // Does this question change the subject? Recruiter-approved questions are delivered verbatim
    // by code and owe nothing to the answer just given, so they arrive abruptly — and since the
    // cadence alternates approved / adaptive follow-up / approved, that gear-change happens every
    // other turn. A human says "let me move to a different area" first; the browser plays an
    // approved bridge phrase when this is set.
    //
    // The BROWSER cannot work this out for itself: it sees only question text, with no way to
    // tell an approved question from an adaptive follow-up. Guessing would put a change-of-subject
    // announcement in front of a direct follow-up, which is worse than saying nothing.
    // FALSE when the acknowledgement already carries the bridge. The server now fuses the two into
    // one line so they are synthesised together (groundedAck.bridgeInto); leaving this true as well
    // would have the browser play a second, different bridge phrase straight after the first, which
    // is both duplicated and worse-sounding than the gap it was meant to remove.
    currentQuestionBridges:
      ai.status === "in_progress" &&
      lastAi?.kind === "question" &&
      Boolean(lastAi?.mustAskId) &&
      !lastAnswer?.ack?.bridged &&
      // Not on the very first question — there is no previous subject to move away from.
      (ai.questionCount || 0) > 1,
    // The approved plain-language rewording of the current question, when one was authored.
    //
    // This is what "let me put that a different way" actually says. Without it the clarify path
    // announced a rephrasing and then replayed the identical sentence, which is worse than not
    // offering to rephrase at all — so when this is null the client falls back to an honest
    // repeat instead of a promise it cannot keep.
    currentQuestionRestatement:
      ai.status === "in_progress" && lastAi?.kind === "question" ? lastAi?.restatement || null : null,
    awaitingAnswer: ai.status === "in_progress",
    // "Over" for the UI's purposes covers every ending — the room must show the end screen either
    // way, and must never leave a candidate who withdrew staring at an open microphone.
    // "abandoned" is listed so a swept session reads as over on any stray portal load; the one
    // legitimate way back in is a re-issued link, and beginInterview reopens it there.
    completed:
      ai.status === "completed" ||
      ai.status === "ended_early" ||
      ai.status === "halted" ||
      ai.status === "abandoned" ||
      ai.status === "integrity_terminated",
    // ...but the endings are surfaced distinctly, because what the candidate is told differs.
    // Someone who finished hears that their answers are with the team; someone who stopped should
    // not be shown a screen implying they completed something they deliberately did not; and
    // someone whose interview WE stopped must be told plainly that it was not their fault.
    endedEarly: ai.status === "ended_early",
    halted: ai.status === "halted",
    // Distinct from `halted` on purpose — see the status enum comment in InterviewSession.js. The
    // client shows a different, neutral screen for this rather than reusing halted's "not your
    // fault" framing.
    integrityTerminated: ai.status === "integrity_terminated",
  };
}

// Begin (or resume) the interview. Idempotent: safe to call on every load.
async function beginInterview(session) {
  const ai = session.aiInterview;

  // A swept interview whose candidate actually came back (recruiter re-issued the link —
  // interviewInvitationService treats an expired in-progress session as a locked-out candidate,
  // not a finished one). Reopen it: the sweep's evaluation was a score-what-exists snapshot of
  // partial evidence, and the live attempt now supersedes it. Clearing it here — at the moment
  // they press start, never at login — is what lets runFinalization run again at the real end;
  // the `abandoned` record (with reopenedAt) is what remains of the swept run. Turns, scores and
  // probe verdicts are kept: resumption continues the same transcript, exactly as an ordinary
  // dropped-connection resume does.
  if (ai.status === "abandoned") {
    if (ai.abandoned) ai.abandoned.reopenedAt = new Date();
    ai.evaluation = {};
    ai.status = "in_progress";
    await session.save();
    console.warn(
      `[aiInterview] session ${session._id} reopened after abandonment — snapshot evaluation cleared, transcript resumes`
    );
    return publicState(session);
  }

  if (ai.status !== "not_started") return publicState(session);

  const { candidate, job } = await loadRefs(session);
  const settings = await loadSettings(session.company);
  const context = buildContext(candidate, job);
  const useAi = await aiUsable(session, candidate, settings);

  const { plan, engine } = await makePlan({ session, candidate, job, settings, context, useAi });
  ai.plan = plan;
  ai.engine = useAi ? "ai" : "fallback";
  ai.currentDifficulty = plan.difficultyEstimate || "medium";

  // Per-job length overrides (Phase 8.3), sanity-clamped so min ≤ max.
  if (job.interviewMaxQuestions) ai.maxQuestions = job.interviewMaxQuestions;
  if (job.interviewMinQuestions) ai.minQuestions = Math.min(job.interviewMinQuestions, ai.maxQuestions);

  // Claim-probes (Phase 8.1/8.2): this candidate's unverified high-weight
  // claims become required coverage. Failure ⇒ empty list, interview as today.
  const probeResult = await probeService.generateProbesForSession(session, candidate);
  ai.probes = probeResult.probes;
  ai.probeEngine = probeResult.engine;
  ai.probeEngineReason = probeResult.reason || "";

  // RÉSUMÉ ANCHORS — required coverage taken straight from the candidate's document.
  //
  // Claim-probes above are the richer mechanism and they run first, but they are conditional on a
  // human having approved a RoleRubric for this job: without one there is no pre_interview
  // assessment, so no unverified claims, so no probes, and the interview asks nothing about the
  // résumé at all while looking exactly like one that did. Most jobs are in that state.
  //
  // Anchors close that hole with no rubric, no ClaimGraph and no model call. They are strictly
  // weaker than probes — an anchor guarantees the subject was RAISED, where a probe can move a
  // score — so they fill the coverage a probe has not already claimed and never displace one.
  // Nothing derived here reaches a score; see utils/resumeAnchors for why that boundary is hard.
  try {
    const probeTerms = (ai.probes || []).map((p) => `${p.question} ${p.resumeQuote || ""}`).join(" ");
    // A1 (REPORT-REDESIGN): when a screening assessment exists, hand its criteria to the
    // selector so each anchor is bound to the rubric criterion it evidences — deterministically,
    // by word-edge label match, never a model call. No assessment (most jobs) ⇒ empty list ⇒
    // every anchor gets criterionId "" and nothing about selection changes.
    let rubricCriteria = [];
    try {
      const AtsAssessment = require("../models/AtsAssessment");
      const pre = await AtsAssessment.findOne({
        candidate: candidate._id,
        company: session.company,
        stage: "pre_interview",
      })
        .sort({ createdAt: -1 })
        .select("criterionFindings")
        .lean();
      rubricCriteria = pre?.criterionFindings || [];
    } catch (err) {
      console.error("[aiInterview] criterion lookup for anchor binding failed — anchors stay unbound:", err.message);
    }
    const selection = resumeAnchors.selectAnchors(candidate, job, { criteria: rubricCriteria });
    // A topic an existing probe already covers does not need an anchor too — that would spend two
    // required questions on one subject and crowd out the rest of the résumé.
    ai.resumeAnchors = selection.anchors.filter((a) => !resumeAnchors.mentions(probeTerms, a.term));
    ai.anchorSelectionVersion = selection.version;
    if (selection.dropped.length) {
      console.warn(
        `[aiInterview] dropped ${selection.dropped.length} résumé anchor(s) for session ${session._id}: ` +
          selection.dropped.map((d) => `${d.term || "?"}:${d.reason}`).join("; ")
      );
    }
  } catch (err) {
    // Guardrail, identical in spirit to the probe one: a selection failure means the interview
    // runs exactly as it did before anchors existed, never that it fails to start.
    console.error("[aiInterview] résumé anchor selection failed — interview proceeds without anchors:", err.message);
    ai.resumeAnchors = [];
  }
  if (!(ai.probes || []).length && !(ai.resumeAnchors || []).length) {
    // Both résumé mechanisms are empty. Loud, because this is the state the candidate experiences
    // as "it never asked me anything about my CV" and it is otherwise completely silent.
    console.warn(
      `[aiInterview] session ${session._id} has NO résumé-derived coverage ` +
        `(probes: ${ai.probeEngineReason || "none"}; anchors: none) — the interview will not reference the document`
    );
  }
  if (probeResult.probes.length > 0) {
    const { PROBE_PROMPT_VERSION } = require("../utils/probePrompts");
    ai.probePromptVersion = PROBE_PROMPT_VERSION;
  }

  // The recruiter-approved must-ask set for this job profile (services/questionSetService).
  // Copied onto the session rather than referenced: this session must be able to state exactly
  // what it asked even after the set is superseded, and coverage is per-session state.
  // No approved set is a fully working interview — claim-probes plus adaptive questions, as
  // before — so adopting one is opt-in per job and never a prerequisite for hiring.
  const questionSet = await questionSetService.resolveForJob(session.company, job._id);
  ai.mustAsk = questionSet.questions.map((q) => ({
    questionId: q.id,
    text: q.text,
    // The approved plain-language rewording, copied onto the session with the question for the
    // same reason the question is: this session has to be able to state exactly what a candidate
    // was asked — including the version they heard when they said they did not understand —
    // after the set has been superseded. Empty is normal and means "cannot be rephrased".
    restatement: q.restatement || "",
    topic: q.topic || "",
    status: "pending",
  }));
  ai.questionSet = {
    id: questionSet.id || undefined,
    version: questionSet.version,
    source: questionSet.source,
    at: new Date(),
  };

  // The approved set is the instrument; the length cap must yield to it rather than silently
  // dropping part of it. Without this, a set larger than maxQuestions would leave approved
  // questions unasked — and closingAllowed would then refuse to end the interview at all.
  const requiredCoverage = ai.mustAsk.length + (ai.probes || []).length + (ai.resumeAnchors || []).length;
  if (requiredCoverage > ai.maxQuestions) {
    console.warn(
      `[aiInterview] raising maxQuestions ${ai.maxQuestions} → ${requiredCoverage} for session ${session._id}: ` +
        `${ai.mustAsk.length} approved question(s) + ${(ai.probes || []).length} claim-probe(s) + ` +
        `${(ai.resumeAnchors || []).length} résumé anchor(s) do not fit the configured cap`
    );
    ai.maxQuestions = requiredCoverage;
  }
  if (ai.minQuestions > ai.maxQuestions) ai.minQuestions = ai.maxQuestions;

  ai.status = "in_progress";
  ai.startedAt = new Date();

  // Greeted by name, in the persona's name, before anything is asked of them.
  const persona = await personaService.resolveForSession(session);
  // Resolved once, here, and stored — the approved phrase bank contains name-bearing
  // acknowledgements, and utils/speechAuthorization has to be able to check one without loading
  // the candidate. Blank when there is no usable first name, and those phrases then do not exist
  // for this session at all rather than being spoken with a gap in them.
  ai.candidateFirstName = backchannel.firstNameOf(candidate?.basicDetails?.name);
  // Whether this role assesses how clearly they explain things. Resolved HERE, before the first
  // word is spoken, because the candidate has to be told at the start or not assessed at all —
  // and because the same declaration must decide both the notice and the scoring, or we could
  // score something we never mentioned.
  const rubric = await loadRubric(session, job);
  const assessesCommunication = communication.isEnabled(rubric, {
    excluded: Boolean(candidate?.accommodations?.excludeSpokenCommunication),
  });
  const script = openingScript({ candidate, job, persona, maxQuestions: ai.maxQuestions, assessesCommunication });
  ai.turns.push({ role: "ai", kind: "intro", text: script.intro });

  // The opening turn is a self-introduction, not a question of the instrument. It eases the
  // candidate in and gives the first real question something to follow up on, but it is NOT
  // scored, NOT tied to a claim-probe, and does NOT consume the question budget — questionCount
  // stays at 0 until the first rubric-bound question is asked, on the next submit. Asking the
  // model to open cold also produced worse first questions: it had nothing from the candidate
  // to build on, so it fell back to reciting the résumé.
  // The name-pronunciation ask ("could you say your name for me?") was RETIRED here on
  // 2026-08-18 by owner decision: in practice it opened every interview with a recognition
  // problem — STT mishears short names, the retry loop reads as the interviewer failing, and one
  // real session spent five turns on it before the first question. The handling machinery
  // (recordNamePronunciation, the name_check routing, utils/namePronunciation) is kept for
  // sessions that already asked it; nothing inserts the ask any more. Every interview now opens
  // intro → warmup, exactly as it did before the feature existed.
  ai.turns.push({ role: "ai", kind: "warmup", text: script.warmup });
  ai.askedQuestions.push(script.warmup);
  ai.questionCount = 0;
  // Fixed per session so replaying it yields the same two closers rather than a fresh pair. Derived
  // from the session id rather than randomised — Math.random() here would make the interview
  // irreproducible, which is the one thing the record may not be.
  ai.closingSeed = seedFromId(session._id);

  await session.save();
  return publicState(session);
}

// A stable small integer from a Mongo ObjectId, for deterministic rotation.
function seedFromId(id) {
  const hex = String(id || "").replace(/[^0-9a-f]/gi, "");
  if (!hex) return 0;
  return parseInt(hex.slice(-6), 16) || 0;
}

// Record the candidate's answer and either ask the next question or complete. `opts` carries
// optional voice metadata (inputMode/transcriptConfidence/audioDurationMs/acoustic) for spoken
// answers — the transcript itself is `answerText`, so the downstream LLM path is unchanged.
async function submitAnswer(session, answerText, opts = {}) {
  const ai = session.aiInterview;
  if (ai.status !== "in_progress") {
    throw Object.assign(new Error("The interview is not in progress"), { status: 400 });
  }
  const raw = String(answerText || "").trim().slice(0, MAX_ANSWER_CHARS);

  // The interviewer's own non-evaluative speech ("take your time — I'm here") is played while
  // the microphone is open, so it can land in the transcript. Strip it before anything treats
  // this text as the candidate's evidence — our words must never be scored as theirs. Only
  // phrases from the approved bank are removable, so the client cannot use this to delete its
  // own content (utils/backchannel.stripEcho).
  const echo = backchannel.stripEcho(raw, opts.backchannels, { firstName: ai.candidateFirstName });
  const text = echo.text;
  if (!text) throw Object.assign(new Error("An answer is required"), { status: 400 });

  // An answer to the opening self-introduction is marked as such and stays out of every scoring
  // path (see the score guard below and scoreUnscoredAnswers). "Tell me about yourself" has no
  // rubric criterion behind it, so a number attached to it would be a judgement with nothing to
  // justify it — and it would drag the mean that a real hiring decision reads.
  const precedingAi = [...ai.turns].reverse().find((t) => t.role === "ai");

  // The candidate saying their own name. Handled entirely here and returned early: it is a
  // rendering parameter, so it never becomes an answer, never reaches a score, and never advances
  // the interview through advance() — the next turn is the warmup, delivered below.
  if (precedingAi?.kind === "name_check") {
    return recordNamePronunciation(session, text);
  }

  // Replying to "would you like to add anything more?" EXTENDS the previous answer rather than
  // starting a new one. Two turns would mean two scored answers for one question — and the second
  // would be scored in isolation, without the half of the reply that came before it, which is
  // exactly backwards. Merged here so the rest of the pipeline sees one answer, as it would have
  // if the candidate had simply said all of it at once.
  if (precedingAi?.kind === "nudge") {
    const previous = [...ai.turns].reverse().find((t) => t.role === "candidate" && t.kind === "answer");
    if (previous) {
      previous.text = `${previous.text} ${text}`.trim().slice(0, MAX_ANSWER_CHARS);
      previous.nudgeMerged = true;
      if (opts.inputMode === "voice") ai.modality = "voice";
      return advance(session);
    }
  }

  const isWarmupAnswer = precedingAi?.kind === "warmup";
  const answerTurn = {
    role: "candidate",
    kind: isWarmupAnswer ? "warmup_answer" : "answer",
    text,
    inputMode: opts.inputMode === "voice" ? "voice" : "text",
  };
  if (opts.inputMode === "voice") {
    ai.modality = "voice";
    if (opts.transcriptConfidence !== undefined) answerTurn.transcriptConfidence = opts.transcriptConfidence;
    if (opts.audioDurationMs !== undefined) answerTurn.audioDurationMs = opts.audioDurationMs;
    if (opts.acoustic) {
      // Raw prosody measurements are kept, and exactly ONE thing is derived from them: whether
      // this answer's AUDIO was usable. There used to be a `deliveryScore` here that fed the
      // evaluation and was shown to recruiters as a score bar — that scored candidates on pace,
      // filler rate and hesitation, which are accent, nervousness and disability proxies that no
      // rubric ever approved. See utils/prosody.js for the full reasoning.
      answerTurn.acoustic = { ...opts.acoustic, audioQuality: audioQuality(opts.acoustic) };
    }
    // Why the turn ended. Recorded next to the answer it belongs to so a disputed "it cut me
    // off" is checkable; read by no scorer.
    if (opts.endOfTurn) answerTurn.endOfTurn = opts.endOfTurn;
    // Realtime only: the agent's own account of this answer, when it materially disagreed with the
    // verbatim transcript above. `text` is always the raw speech-to-text; this is kept so a
    // reviewer can see the interviewer was summarising rather than reporting. Never scored.
    if (opts.agentRendering) answerTurn.agentRendering = opts.agentRendering;
    // Said in the gap before this question. Recorded on this turn because that is where it can be
    // found; attributed to nothing, because it followed the PREVIOUS answer.
    if (opts.spokeBetweenTurns) answerTurn.spokeBetweenTurns = opts.spokeBetweenTurns;
    // The socket dropped and recovered part-way through this answer, so words are missing from
    // the transcript. Recorded ONLY when it actually happened, so a clean answer stores nothing
    // rather than a zero that reads like a measurement. The report marks the turn degraded; no
    // scorer reads it, and it says nothing about the candidate — only about their connection.
    if (opts.connection && opts.connection.drops > 0) {
      answerTurn.connection = { drops: opts.connection.drops, gapMs: opts.connection.gapMs };
      console.warn(
        `[aiInterview] answer recorded across ${opts.connection.drops} connection drop(s), ` +
          `~${opts.connection.gapMs}ms of audio lost (session ${session._id})`
      );
    }
    if (echo.removed.length) {
      answerTurn.backchannelEchoRemoved = echo.removed.length;
      console.warn(
        `[aiInterview] stripped ${echo.removed.length} backchannel echo(es) from a spoken answer ` +
          `(session ${session._id}) — client-side capture pausing is not holding on that device`
      );
    }
  }
  const lastQuestion = [...ai.turns].reverse().find((t) => t.role === "ai" && t.kind === "question");

  // How many times the candidate asked to hear the question again. Recorded on the QUESTION turn,
  // because that is what was repeated — and recorded ONLY there: it is a condition of the
  // interview, never an input to a score (see models/InterviewSession.js and utils/repeatIntent.js
  // for why treating it as a signal would be a disparate-impact machine).
  if (Number.isFinite(opts.repeatCount) && opts.repeatCount > 0 && lastQuestion) {
    lastQuestion.repeatCount = opts.repeatCount;
  }

  // Barge-in bookkeeping. `markProbeAsked` runs when a question is GENERATED, which assumed the
  // question would then be delivered in full — true for typed interviews and for the turn-based
  // voice path, but not once a candidate can talk over it. A probe the candidate never actually
  // heard has not been covered, so it goes back to pending and closingAllowed() will not let the
  // interview end on it. Without this, barge-in would quietly shorten interviews by letting
  // half-heard questions count as asked.
  if (lastQuestion && opts.questionDelivery && opts.questionDelivery.deliveredFully === false) {
    lastQuestion.deliveredFully = false;
    lastQuestion.interruptedAtChar = opts.questionDelivery.interruptedAtChar;
    if (probeUncoveredByInterruption(lastQuestion)) {
      const probe = (ai.probes || []).find((p) => p.claimId === lastQuestion.probeId && p.status === "asked");
      if (probe) {
        probe.status = "pending";
        probe.turnIndex = undefined;
        probe.askedAt = undefined;
      }
    }
    // Same for an approved question the candidate talked over: it was not really asked, so it
    // goes back into the queue and closingAllowed will not let the interview end without it.
    if (mustAskUncoveredByInterruption(lastQuestion)) {
      const q = (ai.mustAsk || []).find((m) => m.questionId === lastQuestion.mustAskId && m.status === "asked");
      if (q) {
        q.status = "pending";
        q.turnIndex = undefined;
        q.askedAt = undefined;
      }
    }
    // And the same for a résumé anchor. The whole value of an anchor is the guarantee that the
    // subject was actually put to the candidate; a question they spoke over before it named the
    // topic did not put it to them, so the guarantee has not been earned yet.
    if (lastQuestion.anchorId && probeUncoveredByInterruption({ ...lastQuestion, probeId: lastQuestion.anchorId })) {
      const anchor = (ai.resumeAnchors || []).find((a) => a.id === lastQuestion.anchorId && a.status === "asked");
      if (anchor) {
        anchor.status = "pending";
        anchor.turnIndex = undefined;
        anchor.askedAt = undefined;
      }
    }
  }

  ai.turns.push(answerTurn);
  // A résumé topic that was asked AND answered is now covered. Done here, against the turn that
  // was just recorded, because "covered" means the candidate spoke to it — not merely that the
  // question went out (see markAnchorsCovered).
  markAnchorsCovered(ai, ai.turns.length - 1, { declined: Boolean(answerTurn.declined) });

  // Record the interviewer's non-evaluative utterances against this answer. Deliberately NOT a
  // turn: it is part of the interview's conditions, not part of the instrument.
  if (Array.isArray(opts.backchannels) && opts.backchannels.length) {
    const turnIndex = ai.turns.length - 1;
    for (const b of opts.backchannels) {
      ai.backchannels.push({ kind: b.kind, phrase: b.phrase, turnIndex, at: b.at || new Date() });
    }
  }

  return advance(session);
}

// ---- The reflect step: what the interviewer says about the answer, and what it asks next -----
//
// One model call per answered turn produces both the grounded lead-in and a candidate follow-up
// question; utils/followUpPrompts explains why they share a call and utils/groundedAck explains
// why neither may ever rate the answer. Everything the model returns is verified in code before a
// word of it is spoken, and every failure degrades to the uniform phrase bank.
//
// This function CANNOT fail the interview. Every error path returns the bank phrase and no
// follow-up, which is exactly the behaviour that shipped before it existed.
async function reflect({ session, candidate, job, settings, ai, useAi }) {
  const bankIndex = ai.questionCount || 0;
  const shape = groundedAck.shapeFor(bankIndex);
  const abstain = (rejection) => ({
    ack: groundedAck.decide(null, "", { index: bankIndex, firstName: ai.candidateFirstName }),
    followUp: { ask: false, question: "", rationale: "", rejection },
  });

  const answerTurn = [...ai.turns].reverse().find((t) => t.role === "candidate");
  // Only a real, attempted answer gets a grounded acknowledgement. A decline already has its own
  // approved reply (backchannel's `decline` bank) and grounding one would mean quoting the words
  // someone used to tell us they could not answer — the single most tactless thing available here.
  // The warmup self-introduction is skipped because it is not part of the instrument.
  if (!answerTurn || answerTurn.kind !== "answer" || answerTurn.declined) {
    return abstain("not_an_answer");
  }
  // No key, no consent, or over budget. The bank phrase is spoken and `rejection` records WHY —
  // an uncertainty that is visible rather than a placeholder rendered as a measurement.
  if (!useAi) return abstain("engine_unavailable");

  // On a silent turn with no follow-up budget left there is nothing this call could produce that
  // anything would use, so it is skipped — a small saving repeated on every interview, and it keeps
  // the silent slot genuinely free rather than paid-for-and-discarded.
  if (shape.key === "silent" && (ai.followUpCount || 0) >= followUpPrompts.MAX_FOLLOW_UPS) {
    return abstain("shape_silent");
  }

  const followUpsRemaining = Math.max(
    0,
    followUpPrompts.MAX_FOLLOW_UPS - (ai.followUpCount || 0)
  );
  const questionTurn = [...ai.turns].reverse().find((t) => t.role === "ai" && ASKABLE_KINDS.has(t.kind));

  const t0 = Date.now();
  try {
    const resolved = resolveRole("interview", settings);
    const { data, usage, model, cached } = await llm.generateJSON({
      system: followUpPrompts.REFLECT_SYSTEM,
      prompt: followUpPrompts.reflectPrompt({
        roleTitle: job?.title || "",
        // The JD excerpt is what makes a follow-up land in the right domain — a marketing role's
        // follow-ups ask about the channel and the numbers, not about system design. Bounded
        // because this call runs on every turn and the whole JD would dominate its cost.
        roleContext: truncateForReflect(job),
        question: questionTurn?.text || "(the question was not recorded)",
        answer: answerTurn.text,
        followUpsRemaining,
        // What has already been said. Without this the reflect call has no memory at all and can
        // only ever respond to the turn in front of it — see followUpPrompts.historyBlock.
        history: recentExchanges(ai),
        // The candidate's own document, as verified spans (utils/resumeAnchors). This is what lets
        // a follow-up cross-check the résumé against what they are saying now — by ASKING about
        // the difference, never by stating it.
        resumeFacts: (ai.resumeAnchors || []).map((a) => ({ term: a.term, quote: a.quote })),
        // Which frame the interviewer uses this turn (utils/groundedAck.SHAPES). Rotated by turn
        // index so it cannot correlate with how the candidate is doing, which is the whole reason
        // the shape is not the model's to choose.
        shapeHint: shape.hint,
        // The question this answers was itself a follow-up, so one further press for a concrete
        // particular is allowed. Bounded by the same MAX_FOLLOW_UPS budget as everything else here
        // — pressing is a use of the follow-up allowance, not an exemption from it.
        isPress: questionTurn?.kind === "follow_up",
      }),
      schema: followUpPrompts.REFLECT_SCHEMA,
      maxTokens: 320,
      model: resolved.model,
      temperature: settings?.ai?.temperature,
      promptVersion: followUpPrompts.REFLECT_PROMPT_VERSION,
    });
    await usageService.recordUsage({
      company: session.company, session: session._id, candidate: candidate._id,
      kind: "reflect", provider: PROVIDER, model, usage, latencyMs: Date.now() - t0,
      engine: "ai", promptVersion: followUpPrompts.REFLECT_PROMPT_VERSION, cached,
    });

    // Both verifications run against the VERBATIM answer text, never the model's account of it.
    const ack = groundedAck.decide(data, answerTurn.text, {
      index: bankIndex,
      firstName: ai.candidateFirstName,
    });
    const followUp = followUpPrompts.decideFollowUp(data, answerTurn.text, { followUpsRemaining, asked: forbiddenQuestionTexts(ai) });
    return { ack, followUp };
  } catch (err) {
    console.error("[aiInterview] reflect failed, using the uniform acknowledgement:", err.message);
    return abstain("reflect_failed");
  }
}

// How many prior question/answer pairs the reflect call remembers, and how much of each.
//
// Bounded because this call is the one the candidate waits on: every token added here is dead air
// between them finishing a sentence and the interviewer speaking. Four exchanges is enough to
// carry conversational continuity — "you said earlier that…", not re-asking something covered two
// turns ago — while the FULL transcript still goes to the next-question call, which is a slower
// decision that can afford it.
const REFLECT_HISTORY_TURNS = 4;
const REFLECT_HISTORY_QUESTION_CHARS = 140;
const REFLECT_HISTORY_ANSWER_CHARS = 260;

function truncate(text, max) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

// The recent exchanges, oldest first, EXCLUDING the pair currently being reflected on (that is
// passed separately and in full). Declines are included as declines: "they were asked about
// Kubernetes and said they couldn't speak to it" is exactly the thing a follow-up must not
// re-litigate, so hiding it would produce the pressure this design exists to avoid.
function recentExchanges(ai) {
  const turns = ai.turns || [];
  const pairs = [];
  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    if (t.role !== "ai" || !ASKABLE_KINDS.has(t.kind)) continue;
    const answer = turns.slice(i + 1).find((x) => x.role === "candidate");
    if (!answer) continue;
    pairs.push({
      question: truncate(t.text, REFLECT_HISTORY_QUESTION_CHARS),
      answer: answer.declined
        ? "(they said they could not answer this)"
        : truncate(answer.text, REFLECT_HISTORY_ANSWER_CHARS),
    });
  }
  // Drop the last pair: it is the one being reflected on right now and is already in the prompt
  // verbatim, so including it here would just spend tokens saying the same thing twice.
  return pairs.slice(0, -1).slice(-REFLECT_HISTORY_TURNS);
}

// The JD, cut to what a follow-up needs to stay in the role's domain.
function truncateForReflect(job) {
  return [
    job?.department ? `Department: ${job.department}` : "",
    job?.requiredSkills?.length ? `Required: ${job.requiredSkills.join(", ")}` : "",
    truncate(job?.description, 500),
  ]
    .filter(Boolean)
    .join("\n");
}

// Interviewer turn kinds that are a question the candidate was meant to answer. Used to find "the
// question this answer answers" — a positive list rather than `kind !== "closing"`, so a kind added
// later is not silently treated as a question until someone deliberately adds it here.
const ASKABLE_KINDS = new Set(["question", "warmup", "follow_up", "capstone", "capstone_follow", "closer"]);

// ---- The closing sequence (utils/closingQuestions.js) -----------------------
//
// The capstone experience pair, then the easy closers. Entered only once every approved question
// and every claim-probe is covered, because a closing sequence that ran while the recruiter's
// instrument was still pending would mean the interview ended without running it.
//
// These questions are ADDITIVE: they do not increment questionCount, so they cannot interact with
// the `maxQuestions` ceiling, the `mustCoverNow` arithmetic, or the closing gate. Reserving them
// out of the budget instead was tried and is subtly wrong — when the last claim-probe clears late,
// a reserve either overshoots the ceiling or silently truncates the sequence, and both outcomes
// are worse than the sequence simply being what it is. What that costs is honesty in the intro
// about the length, which openingScript pays (see closingLength there).
//
// When the approved set alone fills the budget, the approved set wins and the closing sequence is
// skipped — a nice-to-have never displaces the recruiter's instrument.
function closingLength(ai) {
  return closingQuestions.closingSequence({ seed: ai?.closingSeed || 0 }).length;
}

// The next unasked question in the sequence, or null when the sequence is done or must not run.
// Callers reach this only at a point where the interview would otherwise COMPLETE, so there is no
// "is it time yet" judgement here — only "is it allowed and is there any left".
function chooseClosingQuestion(ai) {
  const seq = closingQuestions.closingSequence({ seed: ai.closingSeed || 0 });
  const idx = ai.closingIndex || 0;
  if (idx >= seq.length) return null;
  // Never while the recruiter's instrument is still pending. If the approved set filled the whole
  // budget, the approved set wins and the closing sequence is skipped entirely.
  if (pendingProbes(ai).length || pendingMustAsk(ai).length) return null;
  return seq[idx];
}

// Ask the next closing question if there is one; otherwise finish the interview. This is the ONLY
// path to completion for a normally-run interview, so the capstone and the closers cannot be
// skipped by one branch and asked by another.
async function deliverClosingOrComplete(session, ai, candidate) {
  const closing = chooseClosingQuestion(ai);
  if (closing) {
    ai.turns.push({
      role: "ai",
      kind: closing.kind,
      text: closing.text,
      topic: closing.topic,
      difficulty: closing.difficulty,
      engine: "closing_script",
    });
    ai.askedQuestions.push(closing.text);
    ai.closingIndex = (ai.closingIndex || 0) + 1;
    // Deliberately does NOT increment questionCount — see closingLength() above. The interview is
    // already past its budget when this runs, and re-entering this branch is gated on closingIndex,
    // so the sequence advances exactly once per answer and terminates.
    await session.save();
    return publicState(session);
  }
  ai.turns.push({ role: "ai", kind: "closing", text: closingScript(candidate) });
  ai.status = "completed";
  ai.completedAt = new Date();
  session.status = "completed";
  session.completedAt = new Date();
  await session.save();
  scheduleFinalization(session._id);
  return publicState(session);
}

// Decide and deliver the interviewer's next turn: complete, an approved must-ask question, or an
// adaptive one. Extracted from submitAnswer so the dialogue-act paths reach the next question
// through exactly the same code — a decline has to advance the interview identically to an
// answer, and a second copy of this logic would be a second place for the two to drift apart.
async function advance(session) {
  const ai = session.aiInterview;
  const { candidate, job } = await loadRefs(session);
  const settings = await loadSettings(session.company);
  const context = buildContext(candidate, job);
  const useAi = await aiUsable(session, candidate, settings);

  // Will the next question change the subject? Peeked BEFORE composing the acknowledgement so the
  // two can be spoken as ONE line ("Okay, the Mumbai launch. Let me ask you about something else
  // now.") instead of two synthesis calls with a beat of silence between them — see
  // groundedAck.bridgeInto for why that gap is most of what makes an interviewer sound automated.
  //
  // chooseMustAsk is a pure read of session state, so peeking here and calling it again below
  // cannot double-deliver a question or advance anything.
  // One further opportunity on a very short reply, before anything else happens this turn. Placed
  // FIRST because it is not a branch of the interview advancing — it is the interview declining to
  // advance yet. Nothing is scored, no counter moves, and no model is called.
  const nudgeTarget = nudgeTargetFor(ai);
  if (nudgeTarget) {
    nudgeTarget.nudged = true;
    ai.turns.push({ role: "ai", kind: "nudge", text: NUDGE_PHRASE, engine: "authored" });
    await session.save();
    return publicState(session);
  }

  const upcomingMustAsk = chooseMustAsk(ai);
  const bridgeDue = Boolean(upcomingMustAsk) && (ai.questionCount || 0) > 1;

  // SPECULATIVE QUESTION GENERATION — the fix for "delay in reply".
  //
  // A voice turn used to cost FOUR sequential model round-trips before the candidate heard
  // anything: the agent deciding to call submit_answer, then reflect() here, then nextQuestion()
  // here, then the agent turning the result into speech. The middle two are the ones this code
  // owns, and they were serial for no reason other than being written on consecutive lines —
  // nextQuestion does not read anything reflect produces. Run concurrently they cost the slower
  // of the two instead of the sum, which removes roughly a full model call from every adaptive
  // turn in the interview.
  //
  // WHY IT IS SPECULATIVE. Three branches can pre-empt the adaptive question: the budget being
  // spent, a pending approved question, and a follow-up. The first two are pure reads of session
  // state and are checked right here, so speculation only starts when neither applies. The third
  // is reflect's own output and cannot be known in advance — so when a follow-up does win, this
  // generation is discarded. That is capped and small: follow-ups are limited to MAX_FOLLOW_UPS
  // per interview, so an interview can waste at most that many generations.
  //
  // WHY THE DISCARD IS SAFE. nextQuestion is a PURE READ of session state — it appends nothing to
  // turns, marks no probe or anchor as asked, and advances no counter (all of that happens below,
  // against whichever result is actually used). A discarded question is therefore invisible to the
  // record except in metering, where it correctly appears as tokens that really were spent.
  const speculateQuestion =
    SPECULATIVE_QUESTION_ENABLED && !upcomingMustAsk && ai.questionCount < ai.maxQuestions;
  const speculative = speculateQuestion
    ? nextQuestion({ session, candidate, job, settings, ai, context, useAi }).catch((err) => {
        // nextQuestion already swallows generation failures into a fallback, so reaching here
        // means something unexpected. It must not take the turn down with it — the interview
        // simply generates the question again, serially, below.
        console.error("[aiInterview] speculative question generation threw:", err.message);
        return null;
      })
    : null;

  // What the interviewer says about the answer just given, and whether that answer earned a
  // follow-up. Recorded on the answer turn either way — including when we abstained and why.
  const { ack, followUp } = await reflect({ session, candidate, job, settings, ai, useAi });

  // Now the branch IS known, so the bridge can be fused. A follow-up cancels it: a follow-up grows
  // out of the answer just given, and prefacing it with "let me move us on to a different area"
  // would announce the opposite of what is about to happen.
  const bridge =
    bridgeDue && !followUp?.ask
      ? backchannel.phraseFor("bridge", ai.questionCount || 0, { firstName: ai.candidateFirstName })
      : "";
  const ackText = groundedAck.bridgeInto(ack?.text || "", bridge);
  const answeredTurn = [...ai.turns].reverse().find((t) => t.role === "candidate");
  // Stored ONLY for a real, attempted answer — never for a decline, a silence, or the warmup.
  //
  // Not just tidiness: publicState surfaces this as `currentAck` for the client to speak, and a
  // decline already has its own approved reply from the bank ("That's no problem — let's move on").
  // Writing an acknowledgement here too would have the interviewer say both, so a candidate who
  // said "I don't know" would hear "That's no problem, let's move on. Thank you." — the second
  // sentence thanking them for an answer they had just explained they could not give.
  if (answeredTurn && ack && ack.rejection !== "not_an_answer") {
    answeredTurn.ack = {
      // The FUSED line, because that is the string that will actually be synthesised — and
      // utils/speechAuthorization authorises what was said, not the halves it was built from.
      text: ackText,
      grounded: ack.grounded,
      term: ack.term || "",
      rejection: ack.rejection || "",
      shape: ack.shape || "",
      bridged: Boolean(bridge),
    };
  }

  if (ai.questionCount >= ai.maxQuestions) {
    // Cannot have speculated on this branch (the guard above requires questionCount < max), so
    // there is nothing to drain here.
    // The budget is spent — but the closing sequence was reserved out of it, so this is where the
    // capstone and the easy closers get asked. Once they are done this completes the interview,
    // including the detached evaluation (scheduleFinalization) that used to live inline here.
    return deliverClosingOrComplete(session, ai, candidate);
  }

  // An approved must-ask question is delivered VERBATIM, by code, with no model call at all.
  // That is both the guarantee (the recruiter's wording reaches every candidate unaltered) and,
  // incidentally, free: these turns cost nothing and add no latency.
  //
  // The previous answer goes unscored on this path because scoring lived inside nextQuestion().
  // That is safe and already designed for — finalisation scores every unscored answer through
  // the dedicated bias-blinded prompt (scoreUnscoredAnswers, Phase 9.1) — and it is better than
  // the alternative of making a model call purely to attach a number mid-interview.
  // A follow-up goes FIRST, before the approved queue, because it is about the answer that was
  // just given: "you mentioned the Mumbai launch — what did you own on it?" only makes sense as
  // the very next thing said. Delivered by code from the verified text, exactly as an approved
  // question is, and it does NOT increment questionCount — see InterviewSession.followUpCount for
  // why that separation is a correctness requirement rather than bookkeeping.
  if (followUp?.ask) {
    // A follow-up pre-empts the adaptive question, so the speculative generation is discarded.
    // Awaited rather than abandoned so its usage record is written before the request returns —
    // tokens that were really spent have to reach the meter even when the output is not used.
    if (speculative) {
      const wasted = await speculative;
      if (wasted) {
        console.info(
          `[aiInterview] discarded a speculatively-generated question (session ${session._id}) — ` +
            `a follow-up on the last answer took the turn instead`
        );
      }
    }
    ai.turns.push({
      role: "ai",
      kind: "follow_up",
      text: followUp.question,
      topic: "follow-up",
      difficulty: ai.currentDifficulty,
      followUpRationale: followUp.rationale || "",
      engine: "follow_up",
    });
    // Recorded in askedQuestions so the next-question prompt can never repeat it, which is the one
    // thing askedQuestions is for.
    ai.askedQuestions.push(followUp.question);
    ai.followUpCount = (ai.followUpCount || 0) + 1;
    await session.save();
    return publicState(session);
  }

  const must = chooseMustAsk(ai);
  if (must) {
    // §3.4: same reason the follow-up branch above drains `speculative` before returning — a
    // recruiter-approved question pre-empts the adaptive one just like a follow-up does, and
    // tokens the speculative call really spent have to reach the meter even though its output is
    // discarded. This branch used to return without awaiting it at all, which left that usage
    // record to finish in the background after the response was already sent.
    if (speculative) {
      const wasted = await speculative;
      if (wasted) {
        console.info(
          `[aiInterview] discarded a speculatively-generated question (session ${session._id}) — ` +
            `an approved question took the turn instead`
        );
      }
    }
    ai.turns.push({
      role: "ai",
      kind: "question",
      text: must.text,
      topic: must.topic || "approved set",
      mustAskId: must.questionId,
      // Carried onto the turn so it is speakable: utils/speechAuthorization allows only the
      // approved phrase bank and text already present as an interviewer turn, and a restatement
      // is neither until it is written here.
      restatement: must.restatement || "",
      engine: "approved_set",
    });
    ai.askedQuestions.push(must.text);
    markMustAskAsked(ai, must.questionId);
    ai.questionCount += 1;
    await session.save();
    return publicState(session);
  }

  // Whichever arrived first. `speculative` is null when the branch above ruled speculation out,
  // and resolves to null only if it threw — in both cases this falls back to a plain serial call,
  // so the speculation is a latency optimisation and never a correctness dependency.
  const next = (speculative && (await speculative)) || (await nextQuestion({ session, candidate, job, settings, ai, context, useAi }));
  const lastAnswer = [...ai.turns].reverse().find((t) => t.role === "candidate");
  // Same floor scoreUnscoredAnswers applies: a near-empty answer must not receive a model-invented
  // number just because it was attached to a real question. `isResponsive` is content-blind (word
  // count only), so it costs nothing to check ahead of trusting the model's own score for it.
  const score = lastAnswer && isResponsive(lastAnswer.text) ? clampScore(next.answerScore) : undefined;
  // The model scores "the previous answer" unconditionally, and on the first pass that answer is
  // the self-introduction. Discard it rather than record it: nothing in the rubric backs it. Same
  // for a decline — the model will happily score "I don't know" a 5, and that 5 would be a
  // judgement about an answer nobody gave.
  if (lastAnswer && lastAnswer.kind !== "warmup_answer" && !lastAnswer.declined && score !== undefined) {
    lastAnswer.answerScore = score;
  }
  // THE MODEL'S OWN `difficulty` IS DELIBERATELY DISCARDED HERE.
  //
  // It used to be assigned straight onto the session, which made the adaptive level a value the
  // model chose, stored, and then read back to itself — self-consistent and answerable to nothing.
  // The rung is now recomputed in code from the recorded answer scores (utils/difficultyLadder),
  // which makes it reproducible from the stored transcript and makes "the interview got harder
  // because they were doing well" a checkable statement rather than a claim. `next.difficulty`
  // survives only as a label on the turn, describing the question that was actually asked.
  const ladder = difficultyLadder.computeRung(ai, ai.plan?.difficultyEstimate);
  if (ladder.rung !== ai.currentDifficulty) {
    console.info(
      `[aiInterview] difficulty ${ai.currentDifficulty} → ${ladder.rung} (session ${session._id}) — ` +
        `${ladder.moves} move(s) over the scored answers so far`
    );
  }
  ai.currentDifficulty = ladder.rung;

  // Phase 8.3 — early end, decided by CODE: the model may propose closing
  // (isClosing), but it only takes effect once every probe is covered and the
  // minimum length is reached. In this path the model's "question" is a brief
  // closing statement, and the final answer was scored above (next.answerScore).
  if (next.isClosing && closingAllowed(ai)) {
    // The model proposed closing and code agrees the instrument is covered — so the interview
    // moves into the closing sequence rather than ending here. The model's own closing sentence is
    // DISCARDED on this path: it was composed for an interview that was about to end, and there
    // are still the capstone and the easy closers to ask. When the sequence is exhausted,
    // deliverClosingOrComplete finishes on the authored closingScript, which every candidate hears.
    return deliverClosingOrComplete(session, ai, candidate);
  }

  ai.turns.push({ role: "ai", kind: "question", text: next.question, topic: next.topic, difficulty: next.difficulty, probeId: next.probeId || undefined, anchorId: next.anchorId || undefined, engine: next.engine, model: next.model, latencyMs: next.latencyMs });
  ai.askedQuestions.push(next.question);
  markProbeAsked(ai, next.probeId);
  // Re-checked here rather than trusted from nextQuestion: the turn is on the list now, so this is
  // the only point at which "which turn asked it" is knowable, and the coverage claim is only
  // written if the question text really names the anchor.
  markAnchorAsked(ai, next.anchorId, next.question);
  ai.questionCount += 1;

  await session.save();
  return publicState(session);
}

// ---- Dialogue acts: the candidate talking ABOUT the interview --------------
//
// See utils/dialogueActs.js for what the acts are and why detection is deterministic. This is the
// server half: the browser reports which act it detected (it has to — detection must be instant),
// and this RE-RUNS the same rules against the same transcript before acting on any of it.
//
// That re-check is not paranoia about a malicious candidate; there is nothing here worth
// attacking (the worst available outcome is ending your own interview, which the button already
// offers). It is that "the client said so" is not an acceptable answer to "why did this interview
// end?", and one day someone will ask. The stored record has to name a trigger phrase and a rule.

async function submitDialogueAct(session, act, opts = {}) {
  const ai = session.aiInterview;
  if (ai.status !== "in_progress") {
    throw Object.assign(new Error("The interview is not in progress"), { status: 400 });
  }

  if (act === "pause") return handlePause(session, opts);
  if (act === "decline") return handleDecline(session, opts);
  if (act === "no_response") return handleNoResponse(session, opts);
  if (act === "withdraw") return handleWithdraw(session, opts);
  if (act === "already_answered") return handleAlreadyAnswered(session, opts);
  throw Object.assign(new Error("Unknown conversational act"), { status: 400 });
}

// "I already answered that." / "you already asked me this."
//
// Ported from the turn-based path (controllers/interviewPortalController.js), which has carried
// this since 2026-08-20 as a fixed side-channel exchange: the claim and the reply both go into the
// transcript so a reviewer can see it happened, but neither is scored and neither is the
// candidate's answer to the still-open question. Whether the claim is TRUE is decided the same way
// it always has been — in code, from whether the open question was authored as a follow-up
// (utils/alreadyAnsweredResponder) — never from the candidate's wording or a model's reading of
// the conversation. The realtime path had no equivalent: the room model was told to check the
// transcript itself and compose its own sentence, in its own words, which is the one thing every
// other acknowledgement and reply in this system is explicitly forbidden from doing.
async function handleAlreadyAnswered(session, opts = {}) {
  const ai = session.aiInterview;
  const text = String(opts.text || "").trim().slice(0, MAX_ANSWER_CHARS);
  if (!text) throw Object.assign(new Error("A transcript is required"), { status: 400 });

  const currentQuestionTurn = openQuestionTurn(ai);
  const answer = alreadyAnsweredResponder.respond(currentQuestionTurn);

  ai.turns.push({
    role: "candidate",
    kind: "already_answered_claim",
    text,
    inputMode: opts.inputMode === "voice" ? "voice" : "text",
  });
  ai.turns.push({ role: "ai", kind: "already_answered_reply", text: answer.text });

  await session.save();

  return { ...publicState(session), alreadyAnsweredReply: answer.text, foundPriorAnswer: answer.found };
}

// Nothing was said, and nothing was heard.
//
// WHY THIS IS NOT A DECLINE. A decline is something the candidate DID: they spoke, and what they
// said was "I can't answer this one". Silence is the absence of any act, and the same silence is
// produced by a candidate who chose not to answer, a microphone that stopped working, a dropped
// audio track, and an STT model that returned nothing for speech it did receive. We cannot tell
// those apart — not from the transcript, not from the audio evidence, not from anything we hold —
// and so the record does not pretend to. It says what is true: no answer was captured.
//
// Recording it at all is the point. Before this existed the interviewer simply could not move past
// a silent question: submitAnswer rejected the empty text and the model re-asked forever, which is
// how a candidate with a dead microphone spends their interview being asked question three.
//
// CONSEQUENCES, and they are all protective:
//   - `declined: true` keeps it out of every scoring path, exactly as a spoken decline is.
//   - It is NOT scored zero. A zero says "they answered badly"; this says "we have nothing".
//   - Any occurrence routes the whole interview to a human (reviewRequiredReason). That is
//     deliberate and deliberately unconditional: the only alternative to escalating an ambiguity
//     we cannot resolve is guessing, and the adverse guess here would penalise a candidate for our
//     audio path failing. Rule 4 and rule 6, at the point they actually bite.
const NO_RESPONSE_TEXT = "[no answer captured]";

async function handleNoResponse(session, opts = {}) {
  const ai = session.aiInterview;
  const precedingAi = [...ai.turns].reverse().find((t) => t.role === "ai");
  if (precedingAi?.kind === "warmup") {
    // Silence on "tell me about yourself" is not a missing answer to anything scored — there is no
    // rubric criterion behind the warmup. Record it and move on without flagging the interview.
    ai.turns.push({
      role: "candidate",
      kind: "warmup_answer",
      text: NO_RESPONSE_TEXT,
      declined: true,
      declineAct: "no_response",
      inputMode: "voice",
    });
    ai.modality = "voice";
    return advance(session);
  }

  ai.turns.push({
    role: "candidate",
    kind: "answer",
    // Code-authored, and marked as such by its brackets. It is NOT a transcript and must never be
    // read as one: nobody said these words. `text` is required by the schema, and the honest thing
    // to put in a required field describing an absence is a statement that there was one.
    text: NO_RESPONSE_TEXT,
    declined: true,
    declineAct: "no_response",
    inputMode: "voice",
    // How much voiced audio the worker captured while this question was open. Zero (or absent)
    // means we heard nothing at all; a positive value with no transcript means we heard speech and
    // failed to transcribe it. Both are recorded because they point at different failures, and
    // neither changes the outcome — a reviewer decides, not this code.
    ...(opts.audioDurationMs !== undefined ? { audioDurationMs: opts.audioDurationMs } : {}),
  });
  if (opts.inputMode === "voice" || opts.inputMode === undefined) ai.modality = "voice";

  return advance(session);
}

// "Give me a second." Nothing to decide and nothing to record on the instrument — the interviewer
// simply says it is waiting, and the browser extends its own silence window. It is logged as a
// backchannel so the interview's real conditions stay reconstructible, and that is all it is.
async function handlePause(session, opts) {
  const ai = session.aiInterview;
  ai.backchannels.push({
    kind: "pause",
    phrase: backchannel.phraseFor("pause", ai.backchannels.length),
    turnIndex: ai.turns.length - 1,
    at: opts.at ? new Date(opts.at) : new Date(),
  });
  await session.save();
  return publicState(session);
}

// "I don't know." / "Can we skip this one?"
//
// Recorded verbatim as the candidate's turn — their words are their words, and tidying them out
// of the transcript is not this system's call — but flagged `declined`, which is what keeps it out
// of every scoring path. Then the interview advances exactly as it would after any other answer.
//
// Note what does NOT happen: the probe or approved question this was asked against stays `asked`.
// It WAS asked; the candidate heard it and responded. What it did not produce is evidence, and
// that shows up as an `inconclusive` verdict, not as an uncovered probe. Putting it back to
// pending would mean re-asking a question the candidate has already declined, which is the one
// thing a person would obviously not do.
async function handleDecline(session, opts) {
  const ai = session.aiInterview;
  const raw = String(opts.text || "").trim().slice(0, MAX_ANSWER_CHARS);
  const echo = backchannel.stripEcho(raw, opts.backchannels, { firstName: ai.candidateFirstName });
  const text = echo.text;
  if (!text) throw Object.assign(new Error("A transcript is required"), { status: 400 });

  // Re-run the detection server-side. A client that reports "decline" over a real answer would
  // otherwise be able to discard that answer from scoring, which is the one direction of this
  // that a candidate could actually benefit from.
  //
  // TWO READINGS, and the turn is a decline if EITHER says so and neither finds an answer in it.
  //
  // dialogueActs.detect counts the words outside the matched trigger across the whole utterance.
  // That is the right test for typed input and it collapses on spoken input: the seven declines in
  // the 2026-08-25 session scored between 7 and 38 "other words" against a limit of 6, because the
  // candidate wrapped each skip in "you already asked me this" and "can you repeat that" — which
  // are not answer content, they are more dialogue acts. Every one was recorded as an answer and
  // scored zero. utils/turnComposition reads the same turn sentence by sentence and catches all
  // seven, so it is consulted first and detect() is kept as the narrower second opinion.
  //
  // THE GUARD IS UNCHANGED AND IS THE POINT: `composition.isAnswer` means at least one sentence
  // carried real content, and that ends the question whatever either detector says. Missing a
  // decline costs one question its correct handling; inventing one deletes an answer the candidate
  // actually gave. The asymmetry is why this reads the way it does.
  const composition = turnComposition.classify(text);
  const verdict = dialogueActs.detect(text);
  const readsAsDecline =
    composition.act === "decline" || (verdict.act === "decline" && verdict.honour);
  if (!readsAsDecline || composition.isAnswer) {
    // Not a decline on the server's reading — treat it as the answer it appears to be, through
    // the ordinary path. Falling back to submitAnswer rather than erroring means a disagreement
    // between the two readings can never cost the candidate their words.
    console.warn(
      `[aiInterview] client reported a decline the server does not read as one (session ${session._id}, ` +
        `act=${verdict.act || "none"}, otherWords=${verdict.otherWords}, ` +
        `composition=${composition.act || "none"}, contentWords=${composition.contentWords}) — recording it as an answer`
    );
    return submitAnswer(session, text, opts);
  }
  const declineTrigger = composition.matchedTrigger || verdict.matchedTrigger || null;

  const precedingAi = [...ai.turns].reverse().find((t) => t.role === "ai");
  if (precedingAi?.kind === "warmup") {
    // Declining the self-introduction is not a decline of anything scored — there is no rubric
    // criterion behind "tell me about yourself". Record it as the warmup answer it is.
    return submitAnswer(session, text, opts);
  }

  ai.turns.push({
    role: "candidate",
    kind: "answer",
    text,
    declined: true,
    declineAct: "decline",
    ...(declineTrigger ? { declineTrigger } : {}),
    inputMode: opts.inputMode === "voice" ? "voice" : "text",
    ...(opts.transcriptConfidence !== undefined ? { transcriptConfidence: opts.transcriptConfidence } : {}),
    ...(opts.audioDurationMs !== undefined ? { audioDurationMs: opts.audioDurationMs } : {}),
  });
  if (opts.inputMode === "voice") ai.modality = "voice";

  const turnIndex = ai.turns.length - 1;
  ai.backchannels.push({
    kind: "decline",
    phrase: backchannel.phraseFor("decline", ai.questionCount || 0),
    turnIndex,
    at: new Date(),
  });
  for (const b of Array.isArray(opts.backchannels) ? opts.backchannels : []) {
    ai.backchannels.push({ kind: b.kind, phrase: b.phrase, turnIndex, at: b.at || new Date() });
  }

  return advance(session);
}

// "I don't want to do this."
//
// The only irreversible action a candidate can take here, and therefore the only one that is
// never taken on a single utterance. The browser must already have asked the confirmation
// question and got an affirmative (or the candidate pressed the explicit End button, which needs
// no confirmation — a button press is unambiguous by construction). Both are re-verified here.
//
// Rule 6 in the sharpest form it takes anywhere in this system: what follows must never be an
// automated adverse action. The partial transcript is preserved, evaluated only for what it
// actually contains, and the recommendation is forced to "review" by code
// (see reviewRequiredReason) so no candidate is ever auto-rejected for exercising an exit.
// Stop a realtime interview because the INTERVIEWER went off-script (utils/agentGuardrail.js).
//
// Note carefully whose fault this is, because everything about the handling follows from it: the
// candidate did nothing wrong. They prepared, they turned up, and our agent asked something it was
// not allowed to ask. So this is `halted`, not `ended_early` — a candidate who chose to leave and
// a candidate whose interview was taken away from them are different facts, and a report that
// cannot tell them apart will eventually be read as if the candidate quit.
//
// Consequences, all deliberate: the transcript is kept (it is the evidence), the recommendation is
// withheld and routed to a human (reviewRequiredReason), and no adverse action follows. The
// candidate is told it will not count against them, and that has to be true.
async function haltForGuardrail(session, finding) {
  const ai = session.aiInterview;
  if (ai.status !== "in_progress") return publicState(session);

  const { candidate } = await loadRefs(session);
  const stats = coverageStats(ai);

  ai.haltedBy = {
    reason: "guardrail",
    ruleId: finding?.ruleId || "",
    severity: finding?.severity || "critical",
    label: finding?.label || "",
    utterance: String(finding?.utterance || "").slice(0, 2000),
    questionsAsked: stats.asked,
    questionsAnswered: stats.answered,
    at: new Date(),
  };
  ai.status = "halted";
  ai.completedAt = new Date();
  session.status = "completed"; // operationally over; what happened is on aiInterview.status
  session.completedAt = new Date();
  await session.save();

  console.error(
    `[aiInterview] session ${session._id} HALTED by guardrail (${finding?.ruleId}) after ${stats.asked} question(s) — ` +
      `the interviewer went off-script; this must never be adverse to the candidate`
  );

  scheduleFinalization(session._id);
  return publicState(session);
}

async function handleWithdraw(session, opts) {
  const ai = session.aiInterview;
  const confirmedBy = opts.confirmedBy === "explicit" ? "explicit" : "spoken";

  if (confirmedBy === "spoken") {
    const requestText = String(opts.text || "").trim().slice(0, MAX_ANSWER_CHARS);
    const confirmText = String(opts.confirmText || "").trim().slice(0, MAX_ANSWER_CHARS);
    const request = dialogueActs.detect(requestText);
    if (request.act !== "withdraw" || !request.honour) {
      throw Object.assign(
        new Error("That did not read as a request to end the interview — the interview is continuing"),
        { status: 400, code: "WITHDRAW_NOT_RECOGNISED" }
      );
    }
    // Anything that is not a recognised yes resumes the interview. Silence, a half-sentence and
    // an outright no are all the same answer here, and it is the recoverable one.
    if (dialogueActs.detectConfirmation(confirmText) !== "yes") {
      throw Object.assign(
        new Error("The interview was not ended — no confirmation was given"),
        { status: 400, code: "WITHDRAW_NOT_CONFIRMED" }
      );
    }
    ai.endedEarly = {
      by: "candidate",
      requestText,
      matchedTrigger: request.matchedTrigger,
      confirmedBy,
      confirmText,
    };
  } else {
    ai.endedEarly = { by: "candidate", confirmedBy: "explicit" };
  }

  const { candidate } = await loadRefs(session);
  const stats = coverageStats(ai);
  ai.endedEarly.questionsAsked = stats.asked;
  ai.endedEarly.questionsAnswered = stats.answered;
  ai.endedEarly.at = new Date();

  ai.turns.push({ role: "ai", kind: "closing", text: withdrawalScript(candidate) });
  ai.status = "ended_early";
  ai.completedAt = new Date();
  // The SESSION is "completed" in the operational sense — it is over, it must not be resumable,
  // and the expiry job must not later mark it expired. What actually happened is carried by
  // aiInterview.status, which is where every consumer that cares about the difference reads it.
  session.status = "completed";
  session.completedAt = new Date();
  await session.save();

  // A withdrawn interview is terminal. Best-effort room cleanup prevents the
  // realtime worker from remaining alive and metered after the browser leaves.
  await livekit
    .deleteRoom(session)
    .catch((err) => console.error(`[aiInterview] room delete failed for ${session._id}:`, err.message));

  console.warn(
    `[aiInterview] session ${session._id} ended early by the candidate after ${stats.asked} question(s) ` +
      `(${stats.answered} answered, ${stats.declined} declined, confirmedBy=${confirmedBy})`
  );

  scheduleFinalization(session._id);
  return publicState(session);
}

// Anti-cheating hard stop: the candidate's OWN proctoring signals (camera/identity/device — see
// AUTO_SUBMIT_TRIGGER_TYPES in utils/proctoring.js) crossed a hard threshold. Ends the interview
// immediately, no human step — a deliberate, explicit reversal of this file's usual "a human always
// decides" rule for this one case (see InterviewSession.js's status enum comment for the reasoning).
//
// Triggered from a plain HTTP request (interviewPortalController's proctoring flush), which is NOT a
// LiveKit room participant — unlike haltForGuardrail, which never tears the room down itself because
// the Python worker is already inside the room and closes it from there. This function has to delete
// the room directly, the same way finalizeAbandoned's presence-triggered branch does.
async function terminateForIntegrityViolation(session, { triggerCount, threshold, types }) {
  const ai = session.aiInterview;
  if (ai.status !== "in_progress") return publicState(session);

  const stats = coverageStats(ai);
  ai.integrityTerminated = {
    triggerCount,
    threshold,
    types: Array.isArray(types) ? types : [],
    questionsAsked: stats.asked,
    questionsAnswered: stats.answered,
    at: new Date(),
  };
  ai.status = "integrity_terminated";
  ai.completedAt = new Date();
  session.status = "completed";
  session.completedAt = new Date();
  await session.save();

  await livekit
    .deleteRoom(session)
    .catch((err) => console.error(`[aiInterview] room delete failed for ${session._id}:`, err.message));

  console.warn(
    `[aiInterview] session ${session._id} TERMINATED after ${triggerCount} integrity flag(s) (types: ` +
      `${(types || []).join(", ")}) at ${stats.asked} question(s) (${stats.answered} answered) — scoring what exists`
  );

  // Fire-and-forget — the session is already ended; nothing about it should wait on a best-effort
  // admin ping.
  notifyAdmin({
    companyId: session.company,
    type: "interview_integrity_terminated",
    title: "Interview auto-submitted — integrity violation",
    message: `An AI interview was auto-submitted after ${triggerCount} hard integrity flags (camera/identity/device signals). Review it from the candidate's report — this was scored from whatever ran before the cutoff.`,
    meta: { interviewSessionId: session._id, candidateId: session.candidate },
  }).catch(() => {});

  scheduleFinalization(session._id);
  return publicState(session);
}

// Close out an in-progress interview whose link expired unused — the score-what-exists guarantee
// the assessment engine already makes (assessmentService.expireSession), applied to interviews.
// Called from jobs/interviewReminderJob.sweepAbandoned on a 15-minute cron; without it an
// abandoned session sits at in_progress forever, its answers unscored, its probes unassessed, and
// the recruiter's report renders every criterion "Untested" as if a finished interview found
// nothing (rule 5: that blank IS a claim, and a false one).
//
// The guard re-checks everything on the passed (freshly loaded) doc rather than trusting the
// sweep's query, because a recruiter resend can race the sweep: resend pushes expiresAt into the
// future and this then declines to touch the session at all. Never throws on the skip paths —
// the sweep loop treats a false return as "nothing to do".
//
// §3.6: `becausePresenceLeft` is the second, faster trigger — a candidate whose last presence
// event is "left" and who has been silent for INTERVIEW_ABANDON_AFTER_LEAVE_MS holds a LIVE room
// for up to the full 48h link-validity window otherwise, because the original guard below only
// ever fired once expiresAt had already passed. That path expires the link itself (rather than
// waiting for it) and tears down the LiveKit room in the same transition, so the candidate cannot
// wander back into a session that has already been scored and closed.
async function finalizeAbandoned(session, { becausePresenceLeft = false } = {}) {
  const ai = session.aiInterview;
  if (!ai || ai.status !== "in_progress") return false;
  const linkExpired = Boolean(session.expiresAt && session.expiresAt.getTime() <= Date.now());
  if (!linkExpired && !becausePresenceLeft) return false;

  const stats = coverageStats(ai);
  ai.abandoned = {
    at: new Date(),
    lastActivityAt: session.updatedAt,
    questionsAsked: stats.asked,
    questionsAnswered: stats.answered,
  };
  ai.status = "abandoned";
  ai.completedAt = new Date();
  // The operational state the portal's lazy expiry would have applied anyway — the link is dead.
  // NOT "completed": interviewInvitationService must keep treating this as a locked-out candidate
  // (re-issuable), never as a finished interview (final).
  if (session.status !== "expired") session.status = "expired";
  // The presence-triggered path fires WHILE the link is technically still valid — expire it here
  // rather than leaving it to run out on its own, or the candidate could still open the portal on
  // a session that this same call is about to finalize and score.
  if (!linkExpired) session.expiresAt = new Date();
  await session.save();

  if (becausePresenceLeft) {
    await livekit
      .deleteRoom(session)
      .catch((err) => console.error(`[aiInterview] room delete failed for ${session._id}:`, err.message));
  }

  console.warn(
    `[aiInterview] session ${session._id} abandoned — ${becausePresenceLeft ? "candidate left and stayed away" : "link expired unused"} ` +
      `after ${stats.asked} question(s) (${stats.answered} answered, ${stats.declined} declined); scoring what exists`
  );
  scheduleFinalization(session._id);
  return true;
}

// §3.8: durable finalization. Enqueued onto BullMQ when Redis is configured — a deploy or crash
// mid-finalization no longer loses the report, since the job survives the process and BullMQ
// retries it (finalizationQueue's job options: attempts: 3). runFinalization is idempotent on
// aiInterview.evaluation.generatedAt (checked at the top of the function), so a retry is safe and
// covers the same race the old bespoke VersionError handling below existed for — the realtime
// pipelines' metering close (client /end, webhook) can save the session while this holds a now-
// stale doc. Without Redis, that race has no queue-level retry to fall back on, so the fallback
// path keeps the one-retry-on-VersionError handling that used to cover every path.
function scheduleFinalization(sessionId) {
  const queue = getFinalizationQueue();
  if (queue) {
    queue
      .add(
        "finalize",
        { sessionId: String(sessionId) },
        { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100, removeOnFail: 500 }
      )
      .catch((err) => console.error(`[aiInterview] failed to enqueue finalization for ${sessionId}:`, err.message));
    return;
  }
  runInBackground(`finalize interview ${sessionId}`, () =>
    tenantContext
      .runAsSystem(() => runFinalization(sessionId))
      .catch((err) => {
        if (err?.name === "VersionError") {
          console.warn(`[aiInterview] finalization raced a concurrent write on ${sessionId} — retrying once`);
          return tenantContext
            .runAsSystem(() => runFinalization(sessionId))
            .catch((err2) => console.error("[aiInterview] finalization retry failed:", err2.message));
        }
        console.error("[aiInterview] finalization failed:", err.message);
      })
  );
}

async function runFinalization(sessionId) {
  const InterviewSession = require("../models/InterviewSession");
  const session = await InterviewSession.findById(sessionId);
  if (!session) return;
  const ai = session.aiInterview;
  if (ai.evaluation && ai.evaluation.generatedAt) return; // already finalized (idempotent)

  const { candidate, job } = await loadRefs(session);
  const settings = await loadSettings(session.company);
  const useAi = await aiUsable(session, candidate, settings);

  // Phase 9.1: the final answer (and any other scoring gap) is scored BEFORE
  // the overall evaluation, so every mean is over complete data.
  await scoreUnscoredAnswers({ session, candidate, job, settings, ai, useAi });

  // How clearly each answer was communicated — but only if this role declared that it assesses
  // that, and only from the transcript. `delivery` and `confidence` used to be computed here from
  // the candidate's pace, filler rate and hesitation, which are accent, nervousness and speech-
  // difference proxies measured against no approved criterion. Same field names, entirely
  // different inputs: see utils/communication.js for why the inputs were the problem and the
  // presentation never was.
  const rubric = await loadRubric(session, job);
  await scoreCommunication({ session, candidate, ai, rubric, settings, useAi });

  // The 13 rated axes the report's two radar panels are drawn from. Same contract, same
  // transcript-only inputs; see scoreInsights above and utils/interviewInsights.js.
  await scoreInsights({ session, candidate, ai, rubric, settings, useAi });

  const evaluation = await makeEvaluation({ session, candidate, job, settings, ai, useAi });

  const spoken = communication.aggregate(ai.turns);
  if (spoken) {
    if (spoken.delivery !== undefined) evaluation.delivery = spoken.delivery;
    if (spoken.confidence !== undefined) evaluation.confidence = spoken.confidence;
    evaluation.spokenCommunication = {
      answersScored: spoken.answersScored,
      // Carried onto the evaluation so the recruiter reading the number sees, on the same screen,
      // the recorded reason this role assesses it at all.
      justification: ai.spokenCommunication?.justification || "",
    };
  }

  // The two rated panels, aggregated across the answers that produced readings. An axis nothing
  // could be verified for stays `undefined` all the way to the screen, where it renders as "not
  // enough evidence" rather than as a low rating — the distinction utils/interviewInsights.js
  // exists to preserve. The communication half is dropped entirely when the role never declared
  // it assesses how someone communicates.
  const rated = insights.aggregate(ai.turns);
  if (rated) {
    evaluation.insights = {
      cognitive: rated.cognitive,
      communication: ai.insightsScope?.communication ? rated.communication : null,
      answersScored: rated.answersScored,
      // Why the communication panel is absent, when it is — "this role does not assess it" and
      // "this candidate asked to be excluded" are different facts, and the second is one a
      // candidate may later ask us to confirm we honoured.
      communicationReason: ai.insightsScope?.communication
        ? null
        : ai.spokenCommunication?.reason || "not_declared_for_this_role",
    };
  }

  // How much of the instrument produced evidence, attached to the score so the two can never be
  // read apart. Computed here in code — the model is never asked how complete its own input was.
  const stats = coverageStats(ai);
  evaluation.questionsAsked = stats.asked;
  evaluation.questionsAnswered = stats.answered;
  evaluation.questionsDeclined = stats.declined;

  // CODE overrules the model's recommendation when the transcript cannot support one. The model
  // returned a recommendation because the schema requires one; whether there was enough interview
  // behind it to act on is not a question it is in a position to answer, so it is not asked.
  const reason = reviewRequiredReason(ai);
  if (reason) {
    evaluation.reviewReason = reason;
    evaluation.recommendation = "review";
    evaluation.summary =
      `No automated recommendation: ${reason}. A human must review this interview before any decision is taken. ` +
      (stats.answered > 0
        ? `What follows describes only the ${stats.answered} question(s) the candidate actually answered. `
        : `The candidate answered no scored questions, so nothing below is measured. `) +
      String(evaluation.summary || "");
  }

  // Realtime interviews only: were the questions we handed the agent actually asked, in the words
  // we gave it?
  //
  // The live guardrail catches the agent INVENTING a question. This catches the opposite and
  // quieter failure — the agent receiving an approved question and then skipping it, glossing it,
  // or folding it into a conversational aside. Nothing notices that in the moment, because nothing
  // wrong is said; the interview simply stops being the instrument the recruiter approved.
  //
  // Recorded, never thrown. The interview already happened, and refusing to produce a report would
  // punish the candidate for the agent's behaviour.
  if ((ai.agentUtterances || []).length) {
    try {
      const voiceAgentService = require("./voiceAgentService");
      const fidelity = voiceAgentService.verifyQuestionsAsked(
        ai.askedQuestions || [],
        ai.agentUtterances.map((u) => u.text)
      );
      const missed = fidelity.filter((f) => !f.matched);
      evaluation.questionsNotAskedVerbatim = missed.length;
      if (missed.length) {
        console.error(
          `[aiInterview] session ${session._id}: ${missed.length} approved question(s) were not asked verbatim by the realtime agent`
        );
        // A candidate who was never asked part of the approved set did not sit the same interview
        // as everyone else, so the comparison a recommendation rests on is not available.
        evaluation.reviewReason =
          evaluation.reviewReason ||
          `${missed.length} of the approved question(s) were not asked in the approved wording, so this candidate was not assessed on the same instrument as others for this role`;
        evaluation.recommendation = "review";
      }

      // Per-turn delivery reconciliation: stamp every authored AI turn with whether it actually
      // reached the room, so the RECORD can tell "asked and unanswered" apart from "never heard"
      // (voiceAgentService.reconcileDelivery — the 2026-08-18 phantom question and unspoken
      // opening). The opening carries the candidate's affordances (length, the right to ask for
      // repeats), so an undelivered one means this candidate did not sit the approved interview —
      // same review routing as an unasked question, for the same reason.
      const delivery = voiceAgentService.reconcileDelivery(ai.turns, ai.agentUtterances);
      if (delivery.introNotDelivered) {
        evaluation.introNotDelivered = true;
        console.error(
          `[aiInterview] session ${session._id}: the approved opening script was never delivered to the candidate`
        );
        evaluation.reviewReason =
          evaluation.reviewReason ||
          "the approved opening script (which tells the candidate how the interview works and that they may ask for repeats) was never delivered, so this candidate did not sit the interview as approved";
        evaluation.recommendation = "review";
      }
    } catch (err) {
      console.error("[aiInterview] question-fidelity check failed:", err.message);
    }
  }

  ai.evaluation = { ...evaluation, generatedAt: new Date() };
  await session.save();

  // Phase 8: close the loop — assess claim-probe verdicts against the
  // transcript, write them back to the ClaimGraph, and rescore (a SECOND
  // assessment, stage post_interview). Failure never blocks completion, and a
  // contradicted verdict never triggers any pipeline transition here.
  await probeService.finalizeProbes(session, candidate);

  // Advance the pipeline stage (guarded) — a transition error never blocks completion.
  try {
    const candidateDoc = await Candidate.findById(session.candidate).populate("job", "title");
    if (candidateDoc && candidateDoc.status === "interview_scheduled") {
      await applyTransition(candidateDoc, "ai_interview_completed", { actorName: "AI Interviewer" });
    }
  } catch (err) {
    console.error("[aiInterview] stage transition to ai_interview_completed failed:", err.message);
  }

  try {
    await notifyAdmin({
      companyId: session.company,
      type: "ai_report_ready",
      title: "AI interview report ready",
      message: `${candidate.basicDetails.name}'s AI interview for ${job.title} is complete. Overall score: ${ai.evaluation.overallScore ?? "not measured"}${ai.evaluation.recommendation === "review" ? " (needs human review)" : ""}.`,
      meta: { candidateId: candidate._id, sessionId: session._id, score: ai.evaluation.overallScore, recommendation: ai.evaluation.recommendation },
    });
  } catch (err) {
    console.error("[aiInterview] admin notification failed:", err.message);
  }
}

module.exports = {
  beginInterview,
  submitAnswer,
  submitDialogueAct,
  haltForGuardrail,
  // Exported for the realtime path, which has no deterministic fallback to degrade to and must
  // therefore refuse the session outright rather than proceed without consent.
  consentOk,
  publicState,
  runFinalization,
  finalizeAbandoned,
  terminateForIntegrityViolation,
  closingAllowed,
  // exported for tests (dialogue acts + the evidence-coverage guards)
  coverageStats,
  // Realtime presence (candidate left / rejoined). Appends an audit row and nothing else.
  recordPresence,
  longestAbsenceMs,
  nudgeTargetFor,
  NUDGE_MIN_WORDS,
  NUDGE_PHRASE,
  NOTABLE_ABSENCE_MS,
  reviewRequiredReason,
  markAnchorsCovered,
  withdrawalScript,
  MAX_DECLINE_SHARE,
  // exported for tests (Phase 9 gates)
  scoreUnscoredAnswers,
  // exported for tests (the score-range guard): the only model-supplied number that reaches a
  // hiring decision unmediated, so the guard on it needs an acceptance gate of its own.
  makeEvaluation,
  probeUncoveredByInterruption,
  fallbackEvaluation,
  // exported for tests (the authored opening/closing)
  openingScript,
  closingScript,
  estimatedMinutes,
  // exported for tests (recruiter-approved must-ask coverage)
  chooseMustAsk,
  mustAskUncoveredByInterruption,
  pendingMustAsk,
  // exported for tests (the one gate every question passes before it is spoken)
  forbiddenQuestionTexts,
  // exported for tests (probe-question alignment guard)
  questionCoversProbe,
  // exported for the realtime dispatch (side-channel handling) and for tests
  openQuestionTurn,
  SIDE_CHANNEL_KINDS,
};
