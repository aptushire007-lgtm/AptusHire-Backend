// A RESCHEDULE must never drop the candidate back into the middle of an interview they had
// already started. The old behaviour rotated the token and moved the date but left `aiInterview`
// untouched on the same document, so the "fresh" link opened straight onto the existing transcript
// and startInterview resumed it — a candidate who reconnected days later was handed a follow-up
// question about an answer they no longer remembered giving, against a stale interview plan and
// half a recording.
//
// The fix is a new ATTEMPT, not an in-place wipe, and both halves of that matter: the candidate
// gets a session with nothing carried over, and the retired attempt stays readable (transcript,
// evaluation, recording, evidence) instead of being destroyed by a scheduling action. This file is
// the acceptance gate for both, plus for the thing that must NOT change — a plain resend still
// resumes, because that path exists to recover a locked-out candidate, not to restart them.
//
// No DB: the model statics and the notification side-effect are monkey-patched, mirroring
// interviewLinkEpoch.test.js / evidenceClips.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

process.env.PUBLIC_CANDIDATE_URL = "https://candidate.example.com";

// Patch the notification module BEFORE the service under test requires it — the service
// destructures `notifyCandidate` at load time, so a later patch would never be seen.
const notificationService = require("../../services/notificationService");
const sentNotifications = [];
notificationService.notifyCandidate = async (payload) => {
  sentNotifications.push(payload);
};

const InterviewSession = require("../../models/InterviewSession");
const User = require("../../models/User");
const { resendOrRescheduleInterview, hashToken } = require("../../services/interviewInvitationService");

const originalCreate = InterviewSession.create;
const originalUserFindOne = User.findOne;

User.findOne = async () => null;

const created = [];
InterviewSession.create = async (doc) => {
  const row = { ...doc, _id: new mongoose.Types.ObjectId(), toObject: () => ({ ...doc }) };
  created.push(row);
  return row;
};

test.after(() => {
  InterviewSession.create = originalCreate;
  User.findOne = originalUserFindOne;
});

const candidate = {
  _id: new mongoose.Types.ObjectId(),
  basicDetails: { name: "Asha Rao", email: "asha@example.com" },
};
const job = { _id: new mongoose.Types.ObjectId(), title: "Backend Engineer", company: new mongoose.Types.ObjectId() };

// A session that has been sat: the candidate started, answered a question, and stopped.
function startedSession(overrides = {}) {
  const session = {
    _id: new mongoose.Types.ObjectId(),
    candidate: candidate._id,
    company: job.company,
    job: job._id,
    attempt: 1,
    tokenHash: "old-hash",
    sessionEpoch: 3,
    status: "expired",
    interviewAt: new Date(Date.now() - 86400000),
    expiresAt: new Date(Date.now() - 3600000),
    instructions: "Bring a laptop.",
    startedAt: new Date(Date.now() - 80000000),
    accessedAt: new Date(Date.now() - 80000000),
    reminder24hSent: true,
    reminder1hSent: true,
    aiInterview: {
      status: "in_progress",
      startedAt: new Date(Date.now() - 80000000),
      turns: [{ question: "Tell me about a system you owned.", answer: "I ran the billing pipeline." }],
    },
    save: async function saveFn() {
      return this;
    },
    toObject: function toObj() {
      return { _id: this._id, attempt: this.attempt };
    },
    ...overrides,
  };
  return { session };
}

// A session nobody has opened yet — scheduled, never accessed, no transcript.
function untouchedSession() {
  const { session } = startedSession({
    status: "scheduled",
    startedAt: undefined,
    accessedAt: undefined,
    aiInterview: { status: "pending", turns: [] },
    interviewAt: new Date(Date.now() + 86400000),
    expiresAt: new Date(Date.now() + 172800000),
  });
  return session;
}

test("ACCEPTANCE GATE: rescheduling a started interview hands back a link to a NEW, empty attempt", async () => {
  created.length = 0;
  const { session } = startedSession();
  const when = new Date(Date.now() + 3 * 86400000);

  const result = await resendOrRescheduleInterview(session, candidate, job, { interviewAt: when });

  assert.equal(result.freshStart, true, "a started interview must not be resumed after a reschedule");
  assert.equal(created.length, 1, "the new link must point at a newly created session document");

  const fresh = created[0];
  assert.equal(fresh.attempt, 2, "the clean slate is the next attempt");
  assert.equal(String(result.session._id), String(fresh._id), "callers must be handed the NEW session");
  assert.notEqual(String(result.session._id), String(session._id));

  // The whole point: nothing from the previous sitting rides along.
  assert.equal(fresh.aiInterview, undefined, "no transcript may be carried onto the new attempt");
  assert.equal(fresh.startedAt, undefined);
  assert.equal(fresh.accessedAt, undefined);
  assert.equal(fresh.proctoring, undefined);
  assert.equal(fresh.identityVerification, undefined);
  assert.equal(fresh.interviewAt.getTime(), when.getTime());
  assert.equal(fresh.instructions, "Bring a laptop.", "the job's instructions are not progress and do carry over");
  assert.equal(fresh.tokenHash, hashToken(result.interviewUrl.split("/interview/")[1]));
});

test("ACCEPTANCE GATE: the previous attempt is retired, not destroyed", async () => {
  created.length = 0;
  const { session } = startedSession();
  const before = session.sessionEpoch;

  await resendOrRescheduleInterview(session, candidate, job, { interviewAt: new Date(Date.now() + 86400000) });

  assert.equal(session.status, "cancelled", "the old raw link must stop working");
  assert.equal(session.sessionEpoch, before + 1, "a portal session already open on the old link must be cut off");
  assert.ok(session.expiresAt.getTime() <= Date.now(), "expired now, so the abandonment sweep can close it out");
  // The evidence of the first sitting survives — this is why a new document beats an in-place wipe.
  assert.equal(session.aiInterview.turns.length, 1, "the answers already given remain readable on the old attempt");
  assert.ok(session.startedAt, "and so does the record that it ran (quota counts it)");
});

test("the retired attempt's epoch bump is what makes the candidate's error message accurate", async () => {
  // candidateAuth checks epoch BEFORE status, so a candidate mid-interview is told their link was
  // replaced rather than that their interview was cancelled. That only holds if BOTH moved.
  const { session } = startedSession();
  await resendOrRescheduleInterview(session, candidate, job, { interviewAt: new Date(Date.now() + 86400000) });
  assert.equal(session.status, "cancelled");
  assert.equal(session.sessionEpoch, 4);
});

test("rescheduling an interview nobody has opened yet stays on the same document", async () => {
  // Nothing to run "fresh from the start" — and minting a throwaway attempt for every date change
  // would fill the candidate's attempt history with empty cancelled rows.
  created.length = 0;
  const session = untouchedSession();
  const when = new Date(Date.now() + 5 * 86400000);

  const result = await resendOrRescheduleInterview(session, candidate, job, { interviewAt: when });

  assert.equal(result.freshStart, false);
  assert.equal(created.length, 0, "no new attempt for a session that was never sat");
  assert.equal(String(result.session._id), String(session._id));
  assert.equal(session.interviewAt.getTime(), when.getTime());
  assert.equal(session.status, "scheduled");
  assert.equal(session.reminder24hSent, false, "the reminder cron fires again for the new slot");
});

test("ACCEPTANCE GATE: a plain RESEND still resumes — it exists to recover a locked-out candidate", async () => {
  created.length = 0;
  const { session } = startedSession();

  const result = await resendOrRescheduleInterview(session, candidate, job, {});

  assert.equal(result.freshStart, false, "a resend must never restart an interview");
  assert.equal(created.length, 0);
  assert.equal(String(result.session._id), String(session._id));
  assert.equal(session.aiInterview.turns.length, 1, "the transcript the candidate is coming back to is intact");
  assert.equal(session.status, "scheduled");
});

test("a resend's link is never dead on arrival, even for a long-overdue slot", async () => {
  // Regression guard on the existing anchoring rule — the fresh-start branch must not have moved it.
  const { session } = startedSession({ interviewAt: new Date(Date.now() - 30 * 86400000) });
  await resendOrRescheduleInterview(session, candidate, job, {});
  assert.ok(session.expiresAt.getTime() > Date.now(), "resending an overdue interview must yield a usable link");
});

test("a completed interview is still refused, reschedule or not", async () => {
  const { session } = startedSession({ status: "completed", aiInterview: { status: "completed", turns: [] } });
  await assert.rejects(
    () => resendOrRescheduleInterview(session, candidate, job, { interviewAt: new Date(Date.now() + 86400000) }),
    /already been completed/
  );
});

test("a live interview on a valid link is still protected from an unforced reschedule", async () => {
  const { session } = startedSession({
    status: "in_progress",
    expiresAt: new Date(Date.now() + 3600000),
  });
  await assert.rejects(
    () => resendOrRescheduleInterview(session, candidate, job, { interviewAt: new Date(Date.now() + 86400000) }),
    /in progress on a valid link/
  );
});

test("a FORCED reschedule of a live interview both ends it and starts a clean attempt", async () => {
  created.length = 0;
  const { session } = startedSession({ status: "in_progress", expiresAt: new Date(Date.now() + 3600000) });

  const result = await resendOrRescheduleInterview(session, candidate, job, {
    interviewAt: new Date(Date.now() + 86400000),
    force: true,
  });

  assert.equal(result.forcedLiveOverride, true, "the controller needs this to write its audit row");
  assert.equal(result.freshStart, true);
  assert.equal(String(result.previousAttemptId), String(session._id));
  assert.equal(created[0].attempt, 2);
});

test("the reschedule email announces the new slot and points at the new session", async () => {
  created.length = 0;
  sentNotifications.length = 0;
  const { session } = startedSession();
  const when = new Date(Date.now() + 2 * 86400000);

  const result = await resendOrRescheduleInterview(session, candidate, job, { interviewAt: when });

  const note = sentNotifications.at(-1);
  assert.match(note.title, /rescheduled/i);
  assert.equal(
    String(note.meta.interviewSessionId),
    String(result.session._id),
    "the notification must reference the attempt the link actually opens, not the retired one"
  );
});

