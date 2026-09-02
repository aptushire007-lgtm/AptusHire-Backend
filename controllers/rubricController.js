// HTTP layer for the Rubric Compiler (Phase 3). All routes are admin-only and
// tenant-scoped; the heavy lifting lives in services/rubricService.
//
// Approval is the sanctioned human-in-the-loop boundary (GDPR Art. 22 / EU AI
// Act): the auditLog middleware records it via req.audit — who froze what, when.

const Job = require("../models/Job");
const RoleRubric = require("../models/RoleRubric");
const rubricService = require("../services/rubricService");
const engine = require("../utils/rubricEngine");

// The importance ladder and the selectivity presets are defined ONCE, in
// rubricEngine, and shipped to the editor — the UI renders whatever the server
// says a tier means. Hard-coding the multipliers in the SPA would let the two
// drift, and "what did Critical weigh when this rubric was approved" has to have
// exactly one answer.
const AUTHORING_VOCAB = {
  importanceTiers: engine.IMPORTANCE_TIERS,
  defaultImportance: engine.DEFAULT_IMPORTANCE,
  thresholdPresets: engine.THRESHOLD_PRESETS,
  evidenceTypes: engine.EVIDENCE_TYPES,
  maxCriteria: engine.MAX_CRITERIA,
};

async function loadOwnJob(req) {
  return Job.findOne({ _id: req.params.jobId, company: req.user.company });
}

// POST /api/rubrics/job/:jobId/compile
async function compileForJob(req, res) {
  const job = await loadOwnJob(req);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const rubric = await rubricService.compile(job);
  req.audit = {
    action: "rubric.compile",
    resourceType: "RoleRubric",
    resourceId: rubric._id,
    meta: { job: String(job._id), version: rubric.version, engine: rubric.compiledBy?.engine },
  };
  res.status(201).json(rubric);
}

// GET /api/rubrics/job/:jobId — active version + full version history.
async function getForJob(req, res) {
  const job = await loadOwnJob(req);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const [active, versions] = await Promise.all([
    rubricService.getActiveRubric(job._id, req.user.company),
    rubricService.listForJob(job._id, req.user.company),
  ]);
  res.json({ active, versions, vocab: AUTHORING_VOCAB });
}

// GET /api/rubrics/:id
async function getRubric(req, res) {
  const rubric = await RoleRubric.findOne({ _id: req.params.id, company: req.user.company });
  if (!rubric) return res.status(404).json({ error: "Rubric not found" });
  res.json(rubric);
}

// GET /api/rubrics/:id/insights — outcome-joined criterion predictiveness
// (Phase 10.4). READ-ONLY feedback for a human editing the rubric; the system
// never auto-tunes weights from outcomes (that would automate past bias).
async function getRubricInsights(req, res) {
  const insights = await require("../services/calibrationService").criterionInsights(req.params.id, req.user.company);
  if (!insights) return res.status(404).json({ error: "Rubric not found" });
  res.json(insights);
}

// PATCH /api/rubrics/:id — edit a draft (criteria, thresholds).
async function updateRubric(req, res) {
  const rubric = await rubricService.updateDraft(req.params.id, req.user.company, req.body);
  req.audit = {
    action: "rubric.update_draft",
    resourceType: "RoleRubric",
    resourceId: rubric._id,
    meta: { version: rubric.version, criteriaCount: rubric.criteria.length },
  };
  res.json(rubric);
}

// POST /api/rubrics/:id/approve — approve & freeze.
async function approveRubric(req, res) {
  const rubric = await rubricService.approve(req.params.id, req.user.company, req.user);
  req.audit = {
    action: "rubric.approve",
    resourceType: "RoleRubric",
    resourceId: rubric._id,
    meta: {
      job: String(rubric.job),
      version: rubric.version,
      sourceHash: rubric.sourceHash,
      criteriaCount: rubric.criteria.length,
      thresholds: rubric.thresholds,
      frozenAt: rubric.frozenAt,
    },
  };
  res.json(rubric);
}

// DELETE /api/rubrics/:id — remove an unwanted draft (never an approved/frozen version).
async function deleteRubric(req, res) {
  const rubric = await rubricService.remove(req.params.id, req.user.company);
  req.audit = {
    action: "rubric.delete_draft",
    resourceType: "RoleRubric",
    resourceId: rubric._id,
    meta: { job: String(rubric.job), version: rubric.version },
  };
  res.status(204).end();
}

module.exports = { compileForJob, getForJob, getRubric, getRubricInsights, updateRubric, approveRubric, deleteRubric };
