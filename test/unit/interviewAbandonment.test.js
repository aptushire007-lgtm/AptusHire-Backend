// The abandonment sweep — an in-progress interview whose link expired is closed out and its
// partial work scored (jobs/interviewReminderJob.sweepAbandoned → aiInterviewService.
// finalizeAbandoned), instead of rotting at in_progress with every report figure blank.
//
// The stakes are rule 5 and rule 6 at once. Rule 5: a never-finalized session renders a report
// whose every criterion reads "Untested" as though a finished interview found nothing — a blank
// that IS a claim, and a false one. Rule 6: an abandoned session must never produce an automated
// adverse verdict, because a candidate who gave up and a voice pipeline that failed them leave
// the IDENTICAL record — this exact sweep exists because a real candidate's voice interview
// degraded until they had to type, and the session it stranded stayed blank for days.
//
// Pure and offline: no DB, no socket, no provider.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const aiInterview = require("../../services/aiInterviewService");
const { computeVerdict } = require("../../utils/interviewReportEngine");
const InterviewSession = require("../../models/InterviewSession");
const tenantContext = require("../../utils/tenantContext");

// ---------------------------------------------------------------------------
// 1. The state exists and is distinct
// ---------------------------------------------------------------------------

test("1.1: 'abandoned' is a first-class aiInterview status — never a flag on completed", () => {
  const statuses = InterviewSession.schema.path("aiInterview.status").enumValues;
  assert.ok(statuses.includes("abandoned"));
  // The neighbours it must stay distinguishable from.
  assert.ok(statuses.includes("ended_early"));
  assert.ok(statuses.includes("halted"));
});

test("1.2: publicState shows an abandoned session as over — no open microphone on a dead link", () => {
  const state = aiInterview.publicState({
    aiInterview: { status: "abandoned", turns: [], questionCount: 3, maxQuestions: 8 },
  });
  assert.equal(state.completed, true);
  assert.equal(state.awaitingAnswer, false);
});

// ---------------------------------------------------------------------------
// 2. Rule 6 — abandonment can never become an adverse verdict
// ---------------------------------------------------------------------------

test("2.1: THE GUARD — an abandoned session with zero answers is REVIEW, never CLEAR_REJECT", () => {
  // Without the abandoned branch this exact input falls through to
  // "No answers were recorded." → CLEAR_REJECT at High confidence: an automated
  // rejection whose entire evidence is that somebody stopped showing up.
  const v = computeVerdict({
    abandoned: true,
    responsiveCount: 0,
    totalAnswers: 0,
    declinedCount: 0,
    engineRan: false,
    overallScore: null,
  });
  assert.equal(v.verdict, "REVIEW");
  assert.equal(v.confidence, "Low");
  assert.match(v.reason, /not knowable/i);
  assert.match(v.reason, /must not count against them/i);
});

test("2.2: abandonment outranks the responsiveness rejection branches too", () => {
  // Partial answers that happen to be thin must not turn into "below 50%" → CLEAR_REJECT.
  const v = computeVerdict({
    abandoned: true,
    responsiveCount: 1,
    totalAnswers: 4,
    declinedCount: 0,
    engineRan: true,
    overallScore: 20,
  });
  assert.equal(v.verdict, "REVIEW");
});

test("2.3: finalization forces recommendation to review — the model is never asked to judge a hole", () => {
  const reason = aiInterview.reviewRequiredReason({ status: "abandoned", turns: [] });
  assert.ok(reason, "an abandoned session must carry a review reason");
  assert.match(reason, /link expired/i);
  assert.match(reason, /not count against them/i);
});

// ---------------------------------------------------------------------------
// 3. finalizeAbandoned — the guards that keep it away from live interviews
// ---------------------------------------------------------------------------

function stubSession({ status = "in_progress", aiStatus = "in_progress", expiresAt, updatedAt } = {}) {
  let saved = false;
  const session = {
    _id: "s-abandon",
    status,
    expiresAt,
    updatedAt: updatedAt || new Date(Date.now() - 2 * 60 * 60 * 1000),
    aiInterview: {
      status: aiStatus,
      questionCount: 4,
      maxQuestions: 8,
      turns: [
        { role: "ai", kind: "question", text: "Q1" },
        { role: "candidate", kind: "answer", text: "an answer with quite a few words in it." },
      ],
      probes: [],
      resumeAnchors: [],
    },
    save: async () => {
      saved = true;
    },
    wasSaved: () => saved,
  };
  return session;
}

// finalizeAbandoned schedules the (DB-touching) finalization via tenantContext.runAsSystem;
// swallow it here so the offline suite never opens a mongoose query.
async function withFinalizationStubbed(fn) {
  const real = tenantContext.runAsSystem;
  let scheduled = 0;
  tenantContext.runAsSystem = async () => {
    scheduled += 1;
  };
  try {
    return await fn(() => scheduled);
  } finally {
    tenantContext.runAsSystem = real;
  }
}

test("3.1: a session whose link is still valid is refused — the resend race loses politely", async () => {
  await withFinalizationStubbed(async () => {
    // The sweep's query saw it expired, a recruiter resend then pushed expiresAt forward:
    // the re-check on the loaded doc must decline to touch it.
    const session = stubSession({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    const done = await aiInterview.finalizeAbandoned(session);
    assert.equal(done, false);
    assert.equal(session.aiInterview.status, "in_progress", "left exactly as found");
    assert.equal(session.wasSaved(), false);
  });
});

test("3.2: a session that is not in_progress is refused — completed work is never re-stamped", async () => {
  await withFinalizationStubbed(async () => {
    for (const aiStatus of ["not_started", "completed", "ended_early", "halted", "abandoned"]) {
      const session = stubSession({ aiStatus, expiresAt: new Date(Date.now() - 60 * 60 * 1000) });
      const done = await aiInterview.finalizeAbandoned(session);
      assert.equal(done, false, `${aiStatus} must be refused`);
      assert.equal(session.wasSaved(), false);
    }
  });
});

test("3.3: an expired in-progress session is closed out, stamped, and scheduled for scoring", async () => {
  await withFinalizationStubbed(async (scheduled) => {
    const session = stubSession({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) });
    const done = await aiInterview.finalizeAbandoned(session);
    assert.equal(done, true);

    const ai = session.aiInterview;
    assert.equal(ai.status, "abandoned");
    assert.ok(ai.completedAt instanceof Date);
    assert.ok(ai.abandoned.at instanceof Date);
    assert.equal(ai.abandoned.questionsAsked, 4);
    assert.equal(ai.abandoned.questionsAnswered, 1);
    // The operational state the portal's lazy expiry would have applied — NOT "completed",
    // so interviewInvitationService keeps treating this as re-issuable.
    assert.equal(session.status, "expired");
    assert.equal(session.wasSaved(), true);

    // Score-what-exists actually got scheduled.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduled(), 1, "finalization was scheduled exactly once");
  });
});

// ---------------------------------------------------------------------------
// 4. The way back in — a re-issued link reopens the interview
// ---------------------------------------------------------------------------

test("4.1: beginInterview on an abandoned session reopens it and clears the snapshot evaluation", async () => {
  const session = stubSession({ aiStatus: "abandoned" });
  session.aiInterview.abandoned = { at: new Date(), questionsAsked: 4, questionsAnswered: 1 };
  session.aiInterview.evaluation = { generatedAt: new Date(), overallScore: 12, recommendation: "review" };

  const state = await aiInterview.beginInterview(session);

  const ai = session.aiInterview;
  assert.equal(ai.status, "in_progress", "the candidate is back — the interview resumes");
  assert.equal(ai.evaluation.generatedAt, undefined, "the score-what-exists snapshot is cleared so finalization runs again");
  assert.ok(ai.abandoned.reopenedAt instanceof Date, "the swept run leaves a dated breadcrumb");
  assert.equal(session.wasSaved(), true);
  assert.equal(state.completed, false, "the portal sees a live interview again");
  // The transcript is kept: resumption continues the same record, like any dropped-connection resume.
  assert.equal(ai.turns.length, 2);
});
