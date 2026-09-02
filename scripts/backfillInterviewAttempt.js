// One-time migration for §3.1 (multiple interview attempts). InterviewSession.candidate used to
// be `unique: true` — a candidate could only ever have one session document, ever. That's now
// replaced by a compound unique index on { candidate, attempt }, so every existing document needs
// `attempt: 1` backfilled BEFORE `npm run sync:indexes` drops the old single-field unique index and
// creates the new compound one — running sync:indexes first would either fail to build the new
// index (duplicate-null-attempt collision) or briefly leave the collection unconstrained.
//
// Idempotent: only touches documents missing `attempt`, so running it twice is a no-op the second
// time. Run in this order, in a maintenance window:
//   1. node scripts/backfillInterviewAttempt.js
//   2. npm run sync:indexes
require("dotenv").config();
require("../config/dnsOverride").applyDnsOverride();
const mongoose = require("mongoose");
const InterviewSession = require("../models/InterviewSession");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

  const res = await InterviewSession.updateMany({ attempt: { $exists: false } }, { $set: { attempt: 1 } });
  console.log(`Backfilled attempt:1 on ${res.modifiedCount} interview session(s).`);

  const remaining = await InterviewSession.countDocuments({ attempt: { $exists: false } });
  if (remaining > 0) {
    console.warn(`${remaining} session(s) still missing attempt — re-run before syncing indexes.`);
  }

  await mongoose.disconnect();
  console.log("Done backfilling interview attempts.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
