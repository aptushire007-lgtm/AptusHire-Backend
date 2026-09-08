// Phase 17 — one-off backfill: take candidates off the active pipeline board
// when their role no longer has a live seat but nothing released them (the
// release logic in jobController / jobCapacityService only runs forward, from
// the moment it shipped).
//
// Two strands:
//   1. ORPHANS   — the Candidate's `job` points at a Job that no longer exists
//                  (deleted before the cascade existed) ⇒ pipelineExit
//                  { reason: "job_deleted" }.
//   2. CLOSED    — the Job exists with status "closed" and the candidate is
//                  still in an actionable stage ⇒ pipelineExit
//                  { reason: job.closureReason === "openings_filled"
//                             ? "job_filled" : "job_closed" }.
//
// Never touches candidates who are `joined`, `rejected`, holding an offer
// (`offer_sent` / `offer_accepted`), or already have a `pipelineExit`. Nothing
// is deleted and nothing is marked `rejected` — the records stay for audit and
// only leave the board view.
//
//   node scripts/releaseStrandedCandidates.js          # apply
//   node scripts/releaseStrandedCandidates.js --dry-run # report only

require("dotenv").config();
require("../config/dnsOverride").applyDnsOverride();
const mongoose = require("mongoose");
const logger = require("../utils/logger");
const Candidate = require("../models/Candidate");
const Job = require("../models/Job");

const EXEMPT_STAGES = ["offer_sent", "offer_accepted", "joined", "rejected"];
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/recruitment";
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, autoIndex: false });

  const base = {
    status: { $nin: EXEMPT_STAGES },
    "pipelineExit.at": { $exists: false },
  };

  // Candidate rows in an actionable stage, with their job's status/closureReason.
  const rows = await Candidate.find(base).select("_id job status company").lean();
  const jobIds = [...new Set(rows.map((r) => String(r.job)).filter(Boolean))];
  const jobs = await Job.find({ _id: { $in: jobIds } }).select("_id status closureReason").lean();
  const jobById = new Map(jobs.map((j) => [String(j._id), j]));

  const plan = { job_deleted: [], job_filled: [], job_closed: [] };
  for (const r of rows) {
    const job = r.job ? jobById.get(String(r.job)) : null;
    if (!job) {
      plan.job_deleted.push(r);
    } else if (job.status === "closed") {
      (job.closureReason === "openings_filled" ? plan.job_filled : plan.job_closed).push(r);
    }
  }

  const summary = Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, v.length]));
  logger.info(`${DRY_RUN ? "[dry-run] " : ""}stranded candidates found`, summary);

  if (DRY_RUN) {
    await mongoose.disconnect();
    return;
  }

  const now = new Date();
  let updated = 0;
  for (const [reason, list] of Object.entries(plan)) {
    if (!list.length) continue;
    const ids = list.map((r) => r._id);
    const note =
      reason === "job_deleted"
        ? "Left the pipeline — the role was deleted."
        : reason === "job_filled"
        ? "Left the pipeline — the role filled all its openings."
        : "Left the pipeline — the role was closed.";
    const res = await Candidate.updateMany({ _id: { $in: ids } }, [
      {
        $set: {
          pipelineExit: { at: now, reason },
          stageHistory: {
            $concatArrays: [
              { $ifNull: ["$stageHistory", []] },
              [{ stage: "$status", note, by: "backfill", at: now }],
            ],
          },
        },
      },
    ]);
    updated += res.modifiedCount || 0;
    logger.info("released", { reason, matched: ids.length, modified: res.modifiedCount || 0 });
  }

  await mongoose.disconnect();
  logger.info("release complete", { updated });
}

main().catch((err) => {
  logger.error("release stranded candidates failed", err);
  process.exit(1);
});
