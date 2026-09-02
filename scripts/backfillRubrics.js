#!/usr/bin/env node
// Backfill draft rubrics for existing jobs (BUILD-PLAN Phase 3.5).
//
//   node scripts/backfillRubrics.js          # deterministic fallback drafts (no LLM, no spend)
//   node scripts/backfillRubrics.js --ai     # use the AI compiler where a key is configured
//
// Every draft is left UNAPPROVED, so nothing about live scoring changes until a
// human reviews and freezes each rubric in the admin UI. Jobs that already have
// any rubric version are skipped. Deterministic by default: a bulk backfill must
// never surprise-spend LLM budget — AI compilation is an explicit opt-in.

require("dotenv").config();
require("../config/dnsOverride").applyDnsOverride();
const mongoose = require("mongoose");
const Job = require("../models/Job");
const RoleRubric = require("../models/RoleRubric");
const rubricService = require("../services/rubricService");
const tenantContext = require("../utils/tenantContext");

async function main() {
  const useAi = process.argv.includes("--ai");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

  await tenantContext.runAsSystem(async () => {
    const jobs = await Job.find({}).select("_id company title description requirements requiredSkills minExperienceYears requiredEducation atsThreshold");
    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const job of jobs) {
      const existing = await RoleRubric.countDocuments({ job: job._id, company: job.company });
      if (existing > 0) {
        skipped += 1;
        continue;
      }
      try {
        const rubric = await rubricService.compile(job, { forceFallback: !useAi });
        created += 1;
        console.log(`  ✓ ${job.title} (${job._id}) → draft v${rubric.version} [${rubric.compiledBy.engine}], ${rubric.criteria.length} criteria, ${rubric.qualityFlags.length} flag(s)`);
      } catch (err) {
        failed += 1;
        console.error(`  ✗ ${job.title} (${job._id}): ${err.message}`);
      }
    }

    console.log(`\n[backfill] ${created} draft(s) created, ${skipped} job(s) already had rubrics, ${failed} failed.`);
    console.log("[backfill] All drafts are UNAPPROVED — review and freeze them in the admin UI (Jobs → Edit → Scoring Rubric).");
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
