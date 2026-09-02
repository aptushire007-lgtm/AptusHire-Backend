// A review item outliving its subject.
//
// The queue's whole claim is "a human must decide about THIS candidate". When
// the candidate (or the job) has since been deleted — DPDP erasure, the nightly
// retention purge, a removed role, an interrupted smoke run — the item becomes
// a decision about nobody: the card renders with a blank name, no score, and
// two buttons whose only behaviour is a "Candidate or job no longer exists"
// toast, because `resolveItem` 404s on exactly that condition.
//
// Two halves are tested here: the read path never serves an orphan, and the
// delete paths stop creating them.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const ReviewItem = require("../../models/ReviewItem");
const Candidate = require("../../models/Candidate");
const InterviewSession = require("../../models/InterviewSession");
const InterviewQueue = require("../../models/InterviewQueue");
const UsageEvent = require("../../models/UsageEvent");
const evidenceClipService = require("../../services/evidenceClipService");
const { listQueue } = require("../../controllers/reviewQueueController");
const { purgeCandidateArtifacts } = require("../../services/candidatePurgeService");

const originals = {
  reviewFind: ReviewItem.find,
  reviewDeleteMany: ReviewItem.deleteMany,
  candidateDeleteOne: Candidate.deleteOne,
  sessionFind: InterviewSession.find,
  sessionDeleteMany: InterviewSession.deleteMany,
  queueDeleteMany: InterviewQueue.deleteMany,
  usageDeleteMany: UsageEvent.deleteMany,
  clipPurge: evidenceClipService.purgeForCandidate,
};
afterEach(() => {
  ReviewItem.find = originals.reviewFind;
  ReviewItem.deleteMany = originals.reviewDeleteMany;
  Candidate.deleteOne = originals.candidateDeleteOne;
  InterviewSession.find = originals.sessionFind;
  InterviewSession.deleteMany = originals.sessionDeleteMany;
  InterviewQueue.deleteMany = originals.queueDeleteMany;
  UsageEvent.deleteMany = originals.usageDeleteMany;
  evidenceClipService.purgeForCandidate = originals.clipPurge;
});

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

// A chainable stand-in for the Query the controller builds.
function stubReviewFind(rows) {
  const query = {
    sort: () => query,
    limit: () => query,
    populate: () => query,
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  ReviewItem.find = () => query;
}

const companyId = new mongoose.Types.ObjectId();
const req = { user: { company: companyId }, query: {} };

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

test("review queue: an item whose candidate was deleted is not served", async () => {
  const liveItem = {
    _id: "live",
    candidate: { _id: "c1", basicDetails: { name: "Real Person" } },
    job: { _id: "j1", title: "Backend Engineer" },
  };
  // Mongoose resolves a dangling ref to null — that null IS the orphan signal.
  const orphan = { _id: "ghost", candidate: null, job: { _id: "j1", title: "Backend Engineer" } };
  stubReviewFind([liveItem, orphan]);

  const res = mockRes();
  await listQueue(req, res);

  assert.equal(res.body.length, 1);
  assert.equal(res.body[0]._id, "live");
});

test("review queue: an item whose job was deleted is not served", async () => {
  stubReviewFind([
    { _id: "ghost", candidate: { _id: "c1", basicDetails: { name: "Real Person" } }, job: null },
  ]);

  const res = mockRes();
  await listQueue(req, res);

  assert.deepEqual(res.body, []);
});

test("review queue: a fully-populated item is served untouched", async () => {
  const item = {
    _id: "live",
    candidate: { _id: "c1", basicDetails: { name: "Real Person" } },
    job: { _id: "j1", title: "Backend Engineer" },
    assessment: { overallScore: 26 },
  };
  stubReviewFind([item]);

  const res = mockRes();
  await listQueue(req, res);

  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].assessment.overallScore, 26);
});

// ---------------------------------------------------------------------------
// Delete path — the cure, not the symptom
// ---------------------------------------------------------------------------

test("purging a candidate takes their review items with it", async () => {
  const candidate = { _id: new mongoose.Types.ObjectId(), company: companyId, resumePath: null };
  const scopes = [];

  InterviewSession.find = () => ({ select: async () => [] });
  InterviewSession.deleteMany = async () => ({ deletedCount: 0 });
  InterviewQueue.deleteMany = async () => ({ deletedCount: 0 });
  UsageEvent.deleteMany = async () => ({ deletedCount: 0 });
  evidenceClipService.purgeForCandidate = async () => 0;
  Candidate.deleteOne = async () => ({ deletedCount: 1 });
  ReviewItem.deleteMany = async (scope) => {
    scopes.push(scope);
    return { deletedCount: 2 };
  };

  const summary = await purgeCandidateArtifacts(candidate);

  assert.equal(scopes.length, 1, "review items are purged exactly once");
  // Tenant scoping is not optional on a delete: the query must name the company
  // as well as the candidate, or an erasure could reach across tenants.
  assert.equal(String(scopes[0].company), String(companyId));
  assert.equal(String(scopes[0].candidate), String(candidate._id));
  assert.equal(summary.reviewItems, 2, "the erasure receipt reports what it removed");
});
