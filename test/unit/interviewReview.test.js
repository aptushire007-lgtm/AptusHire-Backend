const { test } = require("node:test");
const assert = require("node:assert/strict");
const { reviewState, pendingReviewLookup } = require("../../utils/interviewReview");
const Candidate = require("../../models/Candidate");
const Session = require("../../models/InterviewSession");
const { recordInterviewReview } = require("../../controllers/interviewReviewController");
const id = "6a9f5606821cdc7119a91f73";
const date = new Date("2026-09-01T00:00:00.000Z");

test("review is explicit, per attempt, and reopens after session updates", () => {
  const session = { attempt: 2, updatedAt: date, aiInterview: { status: "ended_early" } };
  assert.equal(reviewState(session).required, true);
  session.recruiterReview = { at: date, evidenceUpdatedAt: date, note: "Insufficient evidence" };
  assert.equal(reviewState(session).required, false);
  assert.equal(reviewState({ ...session, updatedAt: new Date(+date + 1) }).required, true);
  assert.equal(reviewState({ ...session, aiInterview: { status: "in_progress" } }).eligible, false);
  assert.equal(pendingReviewLookup(id).$lookup.pipeline[0].$match.company, id);
});

test("review endpoint scopes reads and atomic writes; rejects invalid, stale and concurrent submissions", async () => {
  const originals = [Candidate.exists, Session.findOne, Session.findOneAndUpdate];
  let status, body, write, candidateFilter, sessionFilter;
  const session = { _id: id, updatedAt: date, attempt: 1, aiInterview: { status: "ended_early" } };
  Candidate.exists = async filter => { candidateFilter = filter; return true; };
  Session.findOne = filter => { sessionFilter = filter; return { lean: async () => session }; };
  Session.findOneAndUpdate = (filter, update, options) => { write = { filter, update, options }; return { lean: async () => ({ ...session, recruiterReview: update.$set.recruiterReview }) }; };
  const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
  const req = { params: { id }, user: { company: id, _id: id, name: "Recruiter" }, body: { attempt: 1, version: date.toISOString(), note: "Reviewed transcript; arrange follow-up." } };
  try {
    await recordInterviewReview(req, res);
    assert.equal(body.review.required, false);
    assert.equal(candidateFilter.company, id);
    assert.equal(sessionFilter.company, id);
    assert.equal(write.filter.company, id);
    assert.equal(write.filter.updatedAt, date);
    assert.equal(write.options.timestamps, false);
    assert.deepEqual(Object.keys(write.update.$set), ["recruiterReview"]);
    assert.equal(req.audit.action, "interview.review.record");
    session.recruiterReview = { at: date, evidenceUpdatedAt: new Date(+date - 1), by: id, note: "Earlier evidence" };
    await recordInterviewReview(req, res);
    assert.equal(write.update.$push.recruiterReviewHistory.note, "Earlier evidence");
    session.recruiterReview = { at: date, evidenceUpdatedAt: date, by: id, note: "Another note" };
    await recordInterviewReview(req, res);
    assert.equal(status, 409);
    delete session.recruiterReview;
    await recordInterviewReview({ ...req, body: { ...req.body, version: new Date(+date - 1).toISOString() } }, res);
    assert.equal(status, 409);
    await recordInterviewReview({ ...req, body: { ...req.body, note: " " } }, res);
    assert.equal(status, 400);
    Session.findOneAndUpdate = () => ({ lean: async () => null });
    await recordInterviewReview(req, res);
    assert.equal(status, 409);
    Candidate.exists = async () => false;
    await recordInterviewReview(req, res);
    assert.equal(status, 404);
  } finally { [Candidate.exists, Session.findOne, Session.findOneAndUpdate] = originals; }
});
