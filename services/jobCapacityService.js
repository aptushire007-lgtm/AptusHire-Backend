// Vacancy-capacity orchestration. Pipeline code reports stage changes here;
// this module alone decides what counts as pending/filled and owns automatic
// closure, board withdrawal, CRM webhook propagation, and recruiter alerts.

const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const { notifyAdmin } = require("./notificationService");
const { emitToCompany } = require("../config/socket");
const { writeAuditLog } = require("../middleware/auditLog");

const PENDING_OFFER_STAGES = ["offer_sent"];
const FILLED_STAGES = ["offer_accepted", "joined"];
const CAPACITY_STAGES = new Set([...PENDING_OFFER_STAGES, ...FILLED_STAGES]);

function affectsCapacity(fromStage, toStage) {
  return CAPACITY_STAGES.has(fromStage) || CAPACITY_STAGES.has(toStage);
}

function validateNumberOfOpenings(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    const err = new Error("Number of openings must be a whole number from 1 to 10,000");
    err.status = 400;
    throw err;
  }
  return count;
}

async function capacitySnapshot(jobId, companyId) {
  const [pendingOffers, filledOpenings] = await Promise.all([
    Candidate.countDocuments({ company: companyId, job: jobId, status: { $in: PENDING_OFFER_STAGES } }),
    Candidate.countDocuments({ company: companyId, job: jobId, status: { $in: FILLED_STAGES } }),
  ]);
  return { pendingOffers, filledOpenings };
}

async function reconcileJobCapacity(jobId, companyId, { actorName = "system" } = {}) {
  const job = await Job.findOne({ _id: jobId, company: companyId });
  if (!job) return { job: null, closedNow: false };

  const openings = validateNumberOfOpenings(job.numberOfOpenings ?? 1);
  const snapshot = await capacitySnapshot(job._id, companyId);
  const shouldClose = snapshot.filledOpenings >= openings;
  let closedNow = false;

  if (shouldClose && job.status === "published") {
    const autoClosedAt = new Date();
    // Compare-and-close is the concurrency boundary. If two final acceptances
    // reconcile together, only one update can match status=published, so only
    // one withdrawal and one recruiter email are emitted.
    const result = await Job.updateOne(
      { _id: job._id, company: companyId, status: "published" },
      {
        $set: {
          status: "closed",
          filledOpenings: snapshot.filledOpenings,
          pendingOffers: snapshot.pendingOffers,
          autoClosedAt,
          closureReason: "openings_filled",
        },
      }
    );
    closedNow = result.modifiedCount === 1;
    if (closedNow) {
      job.status = "closed";
      job.autoClosedAt = autoClosedAt;
      job.closureReason = "openings_filled";
    }
  }

  job.filledOpenings = snapshot.filledOpenings;
  job.pendingOffers = snapshot.pendingOffers;
  if (!closedNow) {
    await Job.updateOne(
      { _id: job._id, company: companyId },
      { $set: { filledOpenings: snapshot.filledOpenings, pendingOffers: snapshot.pendingOffers } }
    );
  }

  emitToCompany(companyId, "job:capacity", {
    jobId: String(job._id),
    status: job.status,
    numberOfOpenings: openings,
    ...snapshot,
  });

  if (!closedNow) return { job, closedNow, ...snapshot };

  // The seat is gone — take everyone still working through this role's pipeline
  // off the board (their records stay for audit). Not a rejection.
  await releaseJobCandidates(job._id, companyId, "job_filled", { actorName }).catch((err) =>
    console.error(`[capacity] release candidates failed for job ${job._id}: ${err.message}`)
  );

  // The ATS status is authoritative and already committed. External systems
  // are best-effort satellites: failures are visible in publication status
  // and retried by the existing reconciliation worker.
  try {
    require("./careersService").cacheClear();
    await require("./jobPublishService").withdrawAllForJob(
      job._id,
      companyId,
      `all ${openings} opening${openings === 1 ? "" : "s"} filled`
    );
  } catch (err) {
    console.error(`[capacity] external withdrawal failed for job ${job._id}: ${err.message}`);
  }

  writeAuditLog({
    action: "job.capacity_filled",
    company: companyId,
    resourceType: "Job",
    resourceId: job._id,
    meta: { actorName, numberOfOpenings: openings, ...snapshot },
  });

  await notifyAdmin({
    companyId,
    type: "job_filled",
    title: "All openings filled",
    message: `${job.title} reached ${snapshot.filledOpenings} of ${openings} filled openings and was closed automatically.`,
    meta: { jobId: job._id, numberOfOpenings: openings, ...snapshot },
    email: {
      template: "jobFilledEmailTemplate",
      args: (admin) => [admin, job, { numberOfOpenings: openings, ...snapshot }],
    },
  });

  return { job, closedNow, ...snapshot };
}

// A role that is filled, closed, or deleted has no live seat to hire into, so
// every candidate still working through its pipeline is released FROM THE BOARD
// (`pipelineExit`) — not rejected (that is a human's call) and not deleted (the
// history is kept for audit/reporting). Candidates already hired (`joined`),
// already rejected, or holding/keeping an offer (`offer_sent` / `offer_accepted`
// — a closing role may still be finalising those) are left untouched.
// One aggregation-pipeline updateMany so it stays a single atomic write and can
// stamp each row's own `status` into its stage history.
const RELEASE_EXEMPT_STAGES = ["offer_sent", "offer_accepted", "joined", "rejected"];
const RELEASE_NOTES = {
  job_filled: "Left the pipeline — the role filled all its openings.",
  job_closed: "Left the pipeline — the role was closed.",
  job_deleted: "Left the pipeline — the role was deleted.",
};

async function releaseJobCandidates(jobId, companyId, reason, { actorName = "system" } = {}) {
  if (!RELEASE_NOTES[reason]) throw new Error(`releaseJobCandidates: bad reason "${reason}"`);
  const note = RELEASE_NOTES[reason];
  const result = await Candidate.updateMany(
    {
      company: companyId,
      job: jobId,
      status: { $nin: RELEASE_EXEMPT_STAGES },
      "pipelineExit.at": { $exists: false },
    },
    [
      {
        $set: {
          pipelineExit: { at: "$$NOW", reason },
          stageHistory: {
            $concatArrays: [
              { $ifNull: ["$stageHistory", []] },
              [{ stage: "$status", note, by: actorName, at: "$$NOW" }],
            ],
          },
        },
      },
    ]
  );
  const released = result.modifiedCount || 0;
  if (released) {
    emitToCompany(companyId, "candidate:stage", { jobId: String(jobId), released, reason });
  }
  return released;
}

// A role coming back to life (re-published / re-opened) puts its released
// candidates back on the board — but only those released BY a close/fill, never
// a delete (that job is gone) and never a hire-elsewhere (that person is
// placed). The `status` they had is still on the doc, so they land back in the
// same column.
async function restoreJobCandidates(jobId, companyId, { actorName = "system" } = {}) {
  const result = await Candidate.updateMany(
    { company: companyId, job: jobId, "pipelineExit.reason": { $in: ["job_filled", "job_closed"] } },
    [
      {
        $set: {
          stageHistory: {
            $concatArrays: [
              { $ifNull: ["$stageHistory", []] },
              [{ stage: "$status", note: "Back in the pipeline — the role was re-opened.", by: actorName, at: "$$NOW" }],
            ],
          },
        },
      },
      { $unset: "pipelineExit" },
    ]
  );
  const restored = result.modifiedCount || 0;
  if (restored) emitToCompany(companyId, "candidate:stage", { jobId: String(jobId), restored });
  return restored;
}

module.exports = {
  PENDING_OFFER_STAGES,
  FILLED_STAGES,
  affectsCapacity,
  validateNumberOfOpenings,
  capacitySnapshot,
  reconcileJobCapacity,
  releaseJobCandidates,
  restoreJobCandidates,
};
