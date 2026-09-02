#!/usr/bin/env node
//
// Recompute the evaluation for sessions that auditDeclineMisreads.js --fix already repaired but
// did not refinalize (i.e. run without --refinalize the first time, or run again after the fact).
//
// WHY THIS EXISTS. auditDeclineMisreads.js's --refinalize flag only fires on the SAME pass that
// detects a misread. Once --fix has already repaired a session's turns, a later run finds no more
// misreads there (there is nothing left to detect) and --refinalize is a no-op for it — the
// evaluation stays stuck on the pre-fix score with reviewRequired:true stamped on it forever. This
// script closes that gap: it finds sessions the fix already flagged (reviewRequiredReason contains
// "decline_misread_repaired") and refinalizes them directly, the same way the combined
// --fix --refinalize pass would have.
//
// USAGE
//   node scripts/refinalizeFlagged.js                 # report only, changes nothing
//   node scripts/refinalizeFlagged.js --fix            # clear + recompute the flagged evaluations
//   node scripts/refinalizeFlagged.js --fix --session <id>   # limit to one session
//
// COSTS MODEL CALLS (same as auditDeclineMisreads.js --refinalize) — opt-in via --fix on purpose.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
require("../config/dnsOverride").applyDnsOverride();

const InterviewSession = require("../models/InterviewSession");
const aiInterview = require("../services/aiInterviewService");

const args = process.argv.slice(2);
const FIX = args.includes("--fix");
const ONLY = (() => {
  const i = args.indexOf("--session");
  return i >= 0 ? args[i + 1] : null;
})();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);

  const query = ONLY
    ? { _id: ONLY }
    : { "aiInterview.evaluation.reviewRequiredReason": /decline_misread_repaired/ };
  const sessions = await InterviewSession.find(query);

  console.log(`found ${sessions.length} session(s) flagged for refinalize`);

  for (const session of sessions) {
    const before = session.aiInterview?.evaluation?.overallScore;
    console.log(`\nsession ${session._id}  stored overall (pre-refinalize): ${before ?? "-"}`);
    if (!FIX) continue;

    session.aiInterview.evaluation = undefined;
    await session.save();
    try {
      await aiInterview.runFinalization(session._id);
      const after = await InterviewSession.findById(session._id).select("aiInterview.evaluation").lean();
      console.log(`  refinalized → overall ${after?.aiInterview?.evaluation?.overallScore ?? "-"}`);
    } catch (e) {
      console.error(`  refinalize FAILED: ${e.message}`);
    }
  }

  if (!FIX) {
    console.log("\nreport only — nothing was written. Re-run with --fix to refinalize.");
  } else {
    console.log(`\nrefinalized ${sessions.length} session(s).`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
