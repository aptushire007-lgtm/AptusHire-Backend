// A resend/reschedule now optionally overrides the "don't touch a live interview" guard
// (interviewInvitationService's `force` option) so a recruiter can deliberately issue a new
// link even mid-interview. That override is only meaningful if the OLD link's already-issued
// portal session actually stops working — otherwise "force resend" would just email a new
// link while the candidate keeps answering on the old one. sessionEpoch is that mechanism:
// every resend/reschedule bumps it, and candidateAuth.js rejects any token signed with a
// stale epoch. This file is the acceptance gate for that rejection, mirroring the mocking
// style already established in evidenceClips.test.js (no DB — InterviewSession.findById is
// monkey-patched per test).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const InterviewSession = require("../../models/InterviewSession");
const { requireCandidateAuth, requirePhoneAuth } = require("../../middleware/candidateAuth");

const originalFindById = InterviewSession.findById;
process.env.JWT_SECRET = "test-secret";

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) {
      res.statusCode = c;
      return res;
    },
    json(p) {
      res.body = p;
      return res;
    },
  };
  return res;
}

function setSession(overrides) {
  const sessionId = new mongoose.Types.ObjectId();
  const candidateId = new mongoose.Types.ObjectId();
  const session = {
    _id: sessionId,
    candidate: candidateId,
    status: "in_progress",
    expiresAt: new Date(Date.now() + 3600000),
    sessionEpoch: 0,
    ...overrides,
  };
  InterviewSession.findById = async () => session;
  return { sessionId, candidateId, session };
}

test.after(() => {
  InterviewSession.findById = originalFindById;
});

test("ACCEPTANCE GATE: a token signed before a force-resend is rejected once sessionEpoch has moved on", async () => {
  const { sessionId, candidateId } = setSession({ sessionEpoch: 1 }); // recruiter already force-resent once

  // Candidate's browser is still holding the JWT it got BEFORE that resend — epoch 0.
  const staleToken = jwt.sign(
    { candidateId: String(candidateId), sessionId: String(sessionId), epoch: 0 },
    "test-secret",
    { expiresIn: "1h" }
  );

  const res = mockRes();
  let nextCalled = false;
  await requireCandidateAuth({ headers: { authorization: `Bearer ${staleToken}` } }, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, "a stale-epoch token must not reach the interview portal");
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /replaced/i);
});

test("ACCEPTANCE GATE: a token signed after the resend (current epoch) is accepted", async () => {
  const { sessionId, candidateId } = setSession({ sessionEpoch: 1 });

  const freshToken = jwt.sign(
    { candidateId: String(candidateId), sessionId: String(sessionId), epoch: 1 },
    "test-secret",
    { expiresIn: "1h" }
  );

  const res = mockRes();
  let nextCalled = false;
  await requireCandidateAuth({ headers: { authorization: `Bearer ${freshToken}` } }, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.body, null, "no error was written for the accepted request");
});

test("a token with no epoch claim (pre-existing sessions) still passes while sessionEpoch is still 0", async () => {
  const { sessionId, candidateId } = setSession({ sessionEpoch: 0 });

  // Signed before this feature shipped — no `epoch` claim at all.
  const legacyToken = jwt.sign({ candidateId: String(candidateId), sessionId: String(sessionId) }, "test-secret", {
    expiresIn: "1h",
  });

  const res = mockRes();
  let nextCalled = false;
  await requireCandidateAuth({ headers: { authorization: `Bearer ${legacyToken}` } }, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true, "a never-resent session must not break existing candidates on deploy");
});

test("ACCEPTANCE GATE: the epoch check also gates the phone-companion token (requirePhoneAuth)", async () => {
  const { sessionId, candidateId } = setSession({ sessionEpoch: 2 });

  const stalePhoneToken = jwt.sign(
    { candidateId: String(candidateId), sessionId: String(sessionId), epoch: 1 },
    "test-secret",
    { audience: "phone-cam", expiresIn: "1h" }
  );

  const res = mockRes();
  let nextCalled = false;
  await requirePhoneAuth({ headers: { authorization: `Bearer ${stalePhoneToken}` } }, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, "a force-resend must also cut off an already-paired phone camera");
  assert.equal(res.statusCode, 401);
});

test("epoch mismatch is reported before the expired/cancelled checks, so the reason given is accurate", async () => {
  // Session is BOTH stale-epoch and already expired — the more specific, more actionable
  // reason ("your link was replaced") must win over the generic "expired" message.
  const { sessionId, candidateId } = setSession({ sessionEpoch: 1, expiresAt: new Date(Date.now() - 1000) });

  const staleToken = jwt.sign(
    { candidateId: String(candidateId), sessionId: String(sessionId), epoch: 0 },
    "test-secret",
    { expiresIn: "1h" }
  );

  const res = mockRes();
  await requireCandidateAuth({ headers: { authorization: `Bearer ${staleToken}` } }, res, () => {});

  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /replaced/i);
});
