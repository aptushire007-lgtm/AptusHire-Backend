#!/usr/bin/env node
// Live end-to-end smoke of the rubric lifecycle against real Mongo (BUILD-PLAN
// Phase 3 acceptance gates that need a database):
//
//   compile → idempotent recompile → edit draft → approve/freeze →
//   frozen mutation REJECTED → query-level update REJECTED →
//   JD edit supersedes to v2 (v1 intact) → approve v2 archives v1.
//
// Uses the deterministic fallback engine (forceFallback) — zero LLM spend.
// Creates its own throwaway job under a synthetic company id and cleans up.
//
//   node scripts/smokeRubric.js

require("dotenv").config();
require("../config/dnsOverride").applyDnsOverride();
// The smoke must be free and offline-safe: blank the LLM key IN-PROCESS so even
// supersede() (which normally may use AI) takes the deterministic fallback.
process.env.OPENROUTER_API_KEY = "";
process.env.LLM_REPLAY = "";
process.env.RUBRIC_ENGINE_ENABLED = "true";

const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Job = require("../models/Job");
const RoleRubric = require("../models/RoleRubric");
const rubricService = require("../services/rubricService");
const tenantContext = require("../utils/tenantContext");

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const companyId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  let jobId;

  try {
    await tenantContext.runAsSystem(async () => {
      const job = await Job.create({
        company: companyId,
        title: "SMOKE Rubric Lifecycle Engineer",
        description: "Throwaway job created by scripts/smokeRubric.js. Safe to delete.",
        requiredSkills: ["node.js", "mongodb"],
        minExperienceYears: 3,
        requiredEducation: "Bachelor's degree",
        atsThreshold: 65,
      });
      jobId = job._id;

      // compile → draft v1 (deterministic, labelled)
      const v1 = await rubricService.compile(job, { forceFallback: true });
      assert.equal(v1.version, 1);
      assert.equal(v1.status, "draft");
      assert.equal(v1.compiledBy.engine, "fallback");
      assert.ok(v1.criteria.length >= 3);
      const sum = v1.criteria.filter((c) => c.kind !== "disqualifier").reduce((s, c) => s + c.weight, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9);
      ok("compile produces draft v1 (fallback-labelled, weights sum to 1)");

      // idempotent recompile
      const again = await rubricService.compile(job, { forceFallback: true });
      assert.equal(String(again._id), String(v1._id));
      ok("recompiling an unchanged JD returns the same draft (no version churn)");

      // edit draft: the caller sends importance WORDS and a bogus weight; the
      // weight must be ignored and the words must drive the arithmetic.
      const edited = await rubricService.updateDraft(v1._id, companyId, {
        criteria: v1.criteria.map((c, i) => ({ ...c.toObject(), importance: i === 0 ? "critical" : "bonus", weight: 999 })),
        thresholds: { advance: 70, review: 50 },
      });
      assert.equal(edited.thresholds.advance, 70);
      const editedSum = edited.criteria.filter((c) => c.kind !== "disqualifier").reduce((s, c) => s + c.weight, 0);
      assert.ok(Math.abs(editedSum - 1) < 1e-9);
      const others = edited.criteria.length - 1;
      // critical=8, bonus=1 each ⇒ first criterion is 8/(8+others).
      assert.ok(Math.abs(edited.criteria[0].weight - 8 / (8 + others)) < 1e-9, "importance drives the weight, not the client's number");
      assert.equal(edited.criteria[0].importance, "critical");
      ok("draft edits set importance by word; client-sent weights are ignored");

      // approve & freeze
      const approved = await rubricService.approve(v1._id, companyId, { _id: userId });
      assert.equal(approved.status, "approved");
      assert.ok(approved.frozenAt);
      assert.equal(String(approved.approvedBy.user), String(userId));
      ok("approve freezes v1 (frozenAt + approvedBy set)");

      // ACCEPTANCE GATE: frozen mutation rejected
      const frozen = await RoleRubric.findOne({ _id: v1._id, company: companyId });
      frozen.criteria[0].label = "TAMPERED";
      await assert.rejects(frozen.save(), /frozen/);
      ok("ACCEPTANCE GATE: a frozen rubric cannot be mutated (save rejected)");

      // query-level updates banned outright
      await assert.rejects(
        RoleRubric.updateOne({ _id: v1._id, company: companyId }, { $set: { "criteria.0.label": "TAMPERED" } }).exec(),
        /query-level/
      );
      ok("query-level updates are banned (no middleware bypass)");

      // ACCEPTANCE GATE: JD edit → supersede → v2 draft, v1 intact
      const before = (await RoleRubric.findOne({ _id: v1._id, company: companyId })).toObject();
      job.description = "EDITED: now with different responsibilities entirely.";
      await job.save();
      const v2 = await rubricService.supersede(job);
      assert.ok(v2, "supersede must compile a new draft after a JD edit");
      assert.equal(v2.version, 2);
      assert.equal(v2.status, "draft");
      const v1After = (await RoleRubric.findOne({ _id: v1._id, company: companyId })).toObject();
      assert.equal(v1After.status, "approved", "v1 stays the active approved version until v2 is approved");
      assert.deepEqual(v1After.criteria, before.criteria, "v1 criteria are byte-identical after supersede");
      ok("ACCEPTANCE GATE: JD edit produces draft v2 and leaves frozen v1 intact");

      // approving v2 archives v1 — the one permitted frozen transition
      await rubricService.approve(v2._id, companyId, { _id: userId });
      const v1Final = await RoleRubric.findOne({ _id: v1._id, company: companyId });
      assert.equal(v1Final.status, "archived");
      const active = await rubricService.getActiveRubric(job._id, companyId);
      assert.equal(String(active._id), String(v2._id));
      ok("approving v2 archives v1; getActiveRubric now returns v2");
    });

    console.log(`\n[smokeRubric] PASS — ${passed} checks green.`);
  } finally {
    await tenantContext.runAsSystem(async () => {
      if (jobId) await Job.deleteOne({ _id: jobId });
      await RoleRubric.deleteMany({ company: companyId });
    });
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("\n[smokeRubric] FAIL:", err.message);
  process.exit(1);
});
