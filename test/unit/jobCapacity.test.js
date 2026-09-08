const test = require("node:test");
const assert = require("node:assert/strict");

const Candidate = require("../../models/Candidate");
const Job = require("../../models/Job");
const User = require("../../models/User");
const AdminNotification = require("../../models/AdminNotification");
const AuditLog = require("../../models/AuditLog");
const jobPublishService = require("../../services/jobPublishService");
const careersService = require("../../services/careersService");
const capacity = require("../../services/jobCapacityService");

test("number of openings is recruiter capacity with a safe default and bounds", () => {
  const job = new Job({ company: "507f1f77bcf86cd799439011", title: "Engineer", description: "Build", status: "draft" });
  assert.equal(job.numberOfOpenings, 1);
  assert.equal(capacity.validateNumberOfOpenings("4"), 4);
  assert.throws(() => capacity.validateNumberOfOpenings(0), /whole number/);
  assert.throws(() => capacity.validateNumberOfOpenings(1.5), /whole number/);
});

test("capacity stages distinguish pending offers from filled openings", () => {
  assert.equal(capacity.affectsCapacity("selected", "offer_sent"), true);
  assert.equal(capacity.affectsCapacity("offer_sent", "offer_accepted"), true);
  assert.equal(capacity.affectsCapacity("applied", "ats_passed"), false);
  assert.deepEqual(capacity.PENDING_OFFER_STAGES, ["offer_sent"]);
  assert.deepEqual(capacity.FILLED_STAGES, ["offer_accepted", "joined"]);
});

test("a published job closes when accepted offers fill every opening", async () => {
  const originals = {
    jobFindOne: Job.findOne,
    jobUpdateOne: Job.updateOne,
    candidateCount: Candidate.countDocuments,
    userFind: User.find,
    notificationCreate: AdminNotification.create,
    auditCreate: AuditLog.create,
    withdraw: jobPublishService.withdrawAllForJob,
    cacheClear: careersService.cacheClear,
  };

  const job = {
    _id: "507f1f77bcf86cd799439012",
    company: "507f1f77bcf86cd799439011",
    title: "Engineer",
    status: "published",
    numberOfOpenings: 2,
    async save() { return this; },
  };
  let withdrawn = false;
  let notified = false;

  try {
    Job.findOne = async () => job;
    Job.updateOne = async (filter) => ({ modifiedCount: filter.status === "published" ? 1 : 0 });
    Candidate.countDocuments = async (query) => query.status.$in.includes("offer_sent") ? 1 : 2;
    User.find = async () => [];
    AdminNotification.create = async (payload) => { notified = payload.type === "job_filled"; return payload; };
    AuditLog.create = async () => ({});
    jobPublishService.withdrawAllForJob = async () => { withdrawn = true; return 1; };
    careersService.cacheClear = () => {};

    const result = await capacity.reconcileJobCapacity(job._id, job.company, { actorName: "Recruiter" });

    assert.equal(result.closedNow, true);
    assert.equal(job.status, "closed");
    assert.equal(job.closureReason, "openings_filled");
    assert.equal(job.filledOpenings, 2);
    assert.equal(job.pendingOffers, 1);
    assert.equal(withdrawn, true);
    assert.equal(notified, true);
  } finally {
    Job.findOne = originals.jobFindOne;
    Job.updateOne = originals.jobUpdateOne;
    Candidate.countDocuments = originals.candidateCount;
    User.find = originals.userFind;
    AdminNotification.create = originals.notificationCreate;
    AuditLog.create = originals.auditCreate;
    jobPublishService.withdrawAllForJob = originals.withdraw;
    careersService.cacheClear = originals.cacheClear;
  }
});
