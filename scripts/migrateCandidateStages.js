// One-time migration for the hiring-pipeline upgrade (Module 11).
//   1. Maps legacy candidate statuses onto the new pipeline stages.
//   2. Backfills a minimal stageHistory for candidates created before the
//      timeline existed, so their dashboards/timelines aren't blank.
// Idempotent: safe to run more than once. Run with:  node scripts/migrateCandidateStages.js
require("dotenv").config();
require("../config/dnsOverride").applyDnsOverride();
const mongoose = require("mongoose");
const Candidate = require("../models/Candidate");

const LEGACY_MAP = {
  interview_queue: "interview_scheduled",
  next_round: "shortlisted",
};

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

  // 1. Remap legacy statuses. updateMany does not run enum validators, so the
  //    old values (absent from the new enum) update cleanly.
  for (const [from, to] of Object.entries(LEGACY_MAP)) {
    const res = await Candidate.updateMany({ status: from }, { $set: { status: to } });
    console.log(`Remapped status "${from}" -> "${to}": ${res.modifiedCount} candidate(s)`);
  }

  // 2. Backfill stageHistory for docs that have none, seeding an "applied"
  //    entry timestamped at creation plus their current stage.
  const missing = await Candidate.find({
    $or: [{ stageHistory: { $exists: false } }, { stageHistory: { $size: 0 } }],
  }).select("status createdAt");

  let backfilled = 0;
  for (const c of missing) {
    const history = [{ stage: "applied", by: "system", at: c.createdAt || new Date() }];
    if (c.status && c.status !== "applied") {
      history.push({ stage: c.status, by: "system", at: c.updatedAt || new Date() });
    }
    await Candidate.updateOne({ _id: c._id }, { $set: { stageHistory: history } });
    backfilled++;
  }
  console.log(`Backfilled stageHistory for ${backfilled} candidate(s).`);

  await mongoose.disconnect();
  console.log("Done migrating candidate stages.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
