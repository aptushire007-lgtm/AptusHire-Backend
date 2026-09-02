// Candidate dashboard acceptance gates.
//
// Two separate claims are being defended here.
//
// (1) The next-action engine says who a step is waiting on and by when. Its
//     value is that it is TRUE, so these test the cases where a naive
//     implementation lies: a stage label that lags a closing session window, a
//     session status the cron has not caught up to, and an "expired" state that
//     must be reported as recoverable rather than as still-open.
//
// (2) The candidate serializers are the boundary between recruiter-only
//     material and the applicant's browser. Assessment sessions carry the
//     scored result, the item bank and the proctoring risk band — releasing any
//     of those would leak an unreleased evaluation, hand a re-taking candidate
//     the answer key, and surface adverse proctoring material that a human is
//     required to review first. These assert the withholding directly, so
//     adding a field to the model can never silently widen the payload.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildNextActions } = require("../../utils/candidateNextActions");
const { toAssessmentSessionView, toSessionView } = require("../../utils/candidateSerializers");

const NOW = new Date("2026-07-31T12:00:00Z").getTime();
const hours = (n) => new Date(NOW + n * 60 * 60 * 1000).toISOString();

function application(overrides = {}) {
  return {
    _id: "app1",
    status: "applied",
    createdAt: new Date(NOW - 72 * 60 * 60 * 1000).toISOString(),
    stageHistory: [],
    ...overrides,
  };
}

const primaryOf = (out) => out[0].primary;

// --- who is it waiting on ---------------------------------------------------

test("an application with nothing owed by the candidate is reported as waiting on the company", () => {
  const out = buildNextActions({ applications: [application({ status: "under_review" })], now: NOW });
  const p = primaryOf(out);
  assert.equal(p.owner, "company");
  assert.equal(p.state, "waiting");
  // The honest part: a date the claim can be checked against, not just a label.
  assert.ok(p.since, "must report since when it has been waiting");
});

test("waiting-since comes from the last stage change, not from the application date", () => {
  const moved = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
  const out = buildNextActions({
    applications: [
      application({
        status: "under_review",
        stageHistory: [{ stage: "applied", at: new Date(NOW - 72e5).toISOString() }, { stage: "under_review", at: moved }],
      }),
    ],
    now: NOW,
  });
  assert.equal(primaryOf(out).since, moved);
});

test("an open assessment outranks the stage label", () => {
  // The stage still says the assessment was merely sent; the session says it
  // shuts in three hours. Leading with the stage would be the commodity
  // behaviour and would cost the candidate the application.
  const out = buildNextActions({
    applications: [application({ status: "assessment_scheduled" })],
    assessmentSessions: [
      { _id: "as1", candidate: "app1", status: "scheduled", startDeadline: hours(3), expiresAt: hours(3) },
    ],
    now: NOW,
  });
  const p = primaryOf(out);
  assert.equal(p.owner, "candidate");
  assert.equal(p.kind, "assessment");
  assert.equal(p.state, "due");
  assert.equal(p.urgency, "soon");
  assert.equal(p.dueAt, hours(3));
});

test("a started assessment is measured against the finish deadline, not the start deadline", () => {
  const out = buildNextActions({
    applications: [application({ status: "assessment_scheduled" })],
    assessmentSessions: [
      {
        _id: "as1",
        candidate: "app1",
        status: "in_progress",
        startedAt: hours(-1),
        startDeadline: hours(-0.5), // already passed — irrelevant once started
        expiresAt: hours(2),
      },
    ],
    now: NOW,
  });
  const p = primaryOf(out);
  assert.equal(p.state, "in_progress");
  assert.equal(p.dueAt, hours(2), "a started assessment is not 'missed' because the START window shut");
});

test("a passed deadline is reported as missed even when the status field still says scheduled", () => {
  // The expiry cron runs on an interval, so there is always a window where the
  // stored status is stale. Trusting it would tell a locked-out candidate they
  // still have time.
  const out = buildNextActions({
    applications: [application({ status: "assessment_scheduled" })],
    assessmentSessions: [
      { _id: "as1", candidate: "app1", status: "scheduled", startDeadline: hours(-2), expiresAt: hours(-2) },
    ],
    now: NOW,
  });
  const p = primaryOf(out);
  assert.equal(p.state, "missed");
  assert.equal(p.canRecoverLink, true, "a missed window must offer a route back in");
});

test("a completed assessment moves the ball to the company", () => {
  const out = buildNextActions({
    applications: [application({ status: "assessment_completed" })],
    assessmentSessions: [
      { _id: "as1", candidate: "app1", status: "completed", completedAt: hours(-4), expiresAt: hours(-1) },
    ],
    now: NOW,
  });
  const p = primaryOf(out);
  assert.equal(p.owner, "company");
  assert.equal(p.state, "waiting", "primary falls through to the company-side step once nothing is owed");
});

test("an expired interview link is recoverable and says saved work is kept", () => {
  const out = buildNextActions({
    applications: [application({ status: "interview_scheduled" })],
    interviewSessions: [
      {
        _id: "is1",
        candidate: "app1",
        status: "in_progress",
        startedAt: hours(-3),
        interviewAt: hours(-3),
        expiresAt: hours(-1),
      },
    ],
    now: NOW,
  });
  const p = primaryOf(out);
  assert.equal(p.kind, "interview");
  assert.equal(p.state, "missed");
  assert.equal(p.canRecoverLink, true);
  assert.match(p.detail, /resume where you left off/i);
});

test("a missed window outranks a merely-due one", () => {
  // Two live obligations. The recoverable failure is the more urgent thing to
  // show, even though the other has the nearer deadline.
  const out = buildNextActions({
    applications: [application({ status: "interview_scheduled" })],
    assessmentSessions: [
      { _id: "as1", candidate: "app1", status: "scheduled", startDeadline: hours(-5), expiresAt: hours(-5) },
    ],
    interviewSessions: [
      { _id: "is1", candidate: "app1", status: "scheduled", interviewAt: hours(1), expiresAt: hours(2) },
    ],
    now: NOW,
  });
  const p = primaryOf(out);
  assert.equal(p.state, "missed");
  assert.equal(p.kind, "assessment");
  assert.equal(out[0].actions.length, 2, "the other obligation is still listed, just not primary");
});

// --- can this be entered from the dashboard right now? ----------------------
//
// `canOpen` is what puts a "Start interview" button in front of a candidate, so
// it decides whether someone can sit their interview without the invitation
// email. Two ways to get it wrong, both costly: withhold it while the window is
// open (the candidate is stuck waiting on mail that may never arrive), or offer
// it after the window shut (a button that can only produce a 410, told to
// someone who is already locked out).

test("a live interview is openable straight from the dashboard", () => {
  const out = buildNextActions({
    applications: [application({ status: "interview_scheduled" })],
    interviewSessions: [
      { _id: "is1", candidate: "app1", status: "scheduled", interviewAt: hours(1), expiresAt: hours(49) },
    ],
    now: NOW,
  });
  const p = primaryOf(out);
  assert.equal(p.canOpen, true);
  assert.equal(p.sessionId, "is1", "the id the open route needs must travel with the flag");
  // The copy must not send them hunting for an email when there is a button.
  assert.match(p.detail, /start it here/i);
  // …nor invent a start time. interviewAt is an hour away here, but the portal
  // admits the session now and the invitation email says so — copy that told
  // them to wait would be a rule the system does not enforce.
  assert.ok(!/at the scheduled time/i.test(p.detail), `must not imply a gated start: ${p.detail}`);
});

test("an interview is openable before its scheduled time, matching what the link does", () => {
  // The magic-link login gates on expiresAt only — never on interviewAt. If the
  // dashboard gated on the slot, the same session would be enterable by email
  // and refused here, and the candidate would be told two different things.
  const out = buildNextActions({
    applications: [application({ status: "interview_scheduled" })],
    interviewSessions: [
      { _id: "is1", candidate: "app1", status: "scheduled", interviewAt: hours(48), expiresAt: hours(96) },
    ],
    now: NOW,
  });
  const p = primaryOf(out);
  assert.equal(p.canOpen, true, "a future slot is not a closed door — the link would already work");
  assert.equal(p.scheduledAt, hours(48), "the slot is still reported, just not enforced");
});

test("a live assessment is openable straight from the dashboard", () => {
  const out = buildNextActions({
    applications: [application({ status: "assessment_scheduled" })],
    assessmentSessions: [
      { _id: "as1", candidate: "app1", status: "scheduled", startDeadline: hours(6), expiresAt: hours(30) },
    ],
    now: NOW,
  });
  const p = primaryOf(out);
  assert.equal(p.canOpen, true);
  assert.equal(p.sessionId, "as1");
});

test("a started session stays openable so a dropped connection is resumable", () => {
  const out = buildNextActions({
    applications: [application({ status: "interview_scheduled" })],
    interviewSessions: [
      { _id: "is1", candidate: "app1", status: "in_progress", startedAt: hours(-1), interviewAt: hours(-1), expiresAt: hours(4) },
    ],
    now: NOW,
  });
  const p = primaryOf(out);
  assert.equal(p.state, "in_progress");
  assert.equal(p.canOpen, true, "losing the tab mid-interview must not end the interview");
});

test("a closed window is never openable — for either kind", () => {
  const out = buildNextActions({
    applications: [application({ _id: "app1", status: "interview_scheduled" }), application({ _id: "app2", status: "assessment_scheduled" })],
    interviewSessions: [
      { _id: "is1", candidate: "app1", status: "scheduled", interviewAt: hours(-50), expiresAt: hours(-2) },
    ],
    assessmentSessions: [
      { _id: "as1", candidate: "app2", status: "scheduled", startDeadline: hours(-3), expiresAt: hours(-3) },
    ],
    now: NOW,
  });
  for (const entry of out) {
    assert.equal(entry.primary.state, "missed");
    assert.ok(!entry.primary.canOpen, `a ${entry.primary.kind} whose window shut must not offer a way in`);
  }
});

test("nothing the company owes is openable", () => {
  // Only the candidate's own live obligations get a door. A completed interview
  // sitting with the hiring team is not something to re-enter.
  const out = buildNextActions({
    applications: [application({ status: "ai_interview_completed" })],
    interviewSessions: [
      { _id: "is1", candidate: "app1", status: "completed", completedAt: hours(-2), expiresAt: hours(10) },
    ],
    now: NOW,
  });
  assert.ok(!out[0].actions.some((a) => a.canOpen), "a completed session must not be re-enterable");
});

test("an offer is an obligation on the candidate", () => {
  const out = buildNextActions({
    applications: [application({ status: "offer_sent", offer: { status: "sent", sentAt: hours(-20) } })],
    now: NOW,
  });
  const p = primaryOf(out);
  assert.equal(p.owner, "candidate");
  assert.equal(p.kind, "offer");
});

test("a rejection is reported plainly, owed by no one, with no invented reason", () => {
  const at = hours(-30);
  const out = buildNextActions({
    applications: [application({ status: "rejected", stageHistory: [{ stage: "rejected", at }] })],
    now: NOW,
  });
  const p = primaryOf(out);
  assert.equal(p.owner, "none");
  assert.equal(p.state, "closed");
  assert.equal(p.at, at);
  // Rule 6 territory: the dashboard states the decision and its date. It must
  // not synthesise a rationale, which would be an unreviewed machine
  // explanation of an adverse action.
  assert.ok(!/score|match|rank|because|due to/i.test(p.detail), `must not explain the rejection: ${p.detail}`);
});

test("sessions are matched to their own application", () => {
  const out = buildNextActions({
    applications: [application({ _id: "app1" }), application({ _id: "app2", status: "under_review" })],
    assessmentSessions: [
      { _id: "as2", candidate: "app2", status: "scheduled", startDeadline: hours(4), expiresAt: hours(4) },
    ],
    now: NOW,
  });
  assert.equal(out[0].primary.owner, "company", "app1 has no session and must not inherit app2's");
  assert.equal(out[1].primary.kind, "assessment");
});

test("an unmodelled status degrades to an honest generic rather than a blank", () => {
  const out = buildNextActions({ applications: [application({ status: "some_future_stage" })], now: NOW });
  const p = primaryOf(out);
  assert.equal(p.owner, "company");
  assert.ok(p.detail && p.detail.length > 0);
});

// --- what must never reach the candidate ------------------------------------

test("the assessment view withholds the score, the item bank and the proctoring record", () => {
  const view = toAssessmentSessionView({
    _id: "as1",
    candidate: "app1",
    job: { title: "Backend Engineer" },
    status: "completed",
    tokenHash: "SECRET-HASH",
    paper: "paper1",
    assignment: { assignedByName: "Recruiter Name" },
    difficultyTier: { value: "hard", basis: "internal reasoning" },
    expiresAt: hours(-1),
    assembledItems: [{ itemId: "i1", sectionId: "s1", order: 1 }, { itemId: "i2", sectionId: "s1", order: 2 }],
    responses: [{ itemId: "i1", response: ["o1"] }],
    sectionState: [{ sectionId: "s1", status: "completed" }],
    proctoring: { riskScore: 87, riskBand: "high", events: [{ type: "gaze_off" }] },
    result: { totalCorrect: 3, perItem: [{ itemId: "i1", correct: false }], claimVerdicts: [{ claimId: "c1" }] },
  });

  const serialized = JSON.stringify(view);
  for (const leak of ["SECRET-HASH", "riskBand", "riskScore", "totalCorrect", "perItem", "claimVerdicts", "gaze_off", "Recruiter Name", "internal reasoning"]) {
    assert.ok(!serialized.includes(leak), `assessment view leaked ${leak}`);
  }
  assert.equal(view.result, undefined);
  assert.equal(view.proctoring, undefined);
  assert.equal(view.assembledItems, undefined);

  // Progress is counts only — enough to answer "am I nearly done", carrying
  // nothing about which items or whether they were right.
  assert.deepEqual(view.progress, { totalSections: 1, completedSections: 1, answered: 1, totalItems: 2 });
});

test("the interview view still withholds the evaluation while exposing the application id", () => {
  const view = toSessionView({
    _id: "is1",
    candidate: "app1",
    status: "completed",
    tokenHash: "SECRET-HASH",
    interviewAt: hours(-2),
    expiresAt: hours(-1),
    aiInterview: {
      status: "completed",
      questionCount: 8,
      evaluation: { recommendation: "reject", score: 42 },
      turns: [{ role: "candidate", text: "transcript" }],
    },
  });
  const serialized = JSON.stringify(view);
  for (const leak of ["SECRET-HASH", "recommendation", "transcript", "42"]) {
    assert.ok(!serialized.includes(leak), `interview view leaked ${leak}`);
  }
  // Needed to line the session up against the right application card.
  assert.equal(view.candidate, "app1");
});
