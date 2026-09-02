// Evidence-bound ATS orchestration (BUILD-PLAN Phase 6.5).
//
//   frozen RoleRubric  ×  verified ClaimGraph
//        → evidenceMatcher (LLM: statuses + claim ids, NO numbers)
//        → evidenceScorer  (pure JS: every number)
//        → qaGateService   (invariants · critic · self-consistency · counterfactual)
//        → AtsAssessment   (persisted; never overwritten)
//
// Hard rules enforced here:
//   - No candidate is ever scored against an unapproved rubric (the human
//     approval boundary). No approved rubric ⇒ the caller stays on legacy.
//   - Any failure inside ⇒ throw; the caller (atsService) degrades to the
//     legacy engine, LABELLED. Never a half-scored candidate.

const AtsAssessment = require("../models/AtsAssessment");
const rubricService = require("./rubricService");
const claimService = require("./claimService");
const { matchEvidence, MATCH_PROMPT_VERSION } = require("./evidenceMatcher");
const { computeAssessment, reproducibilityHash, SCORER_VERSION } = require("../utils/evidenceScorer");
const qaGate = require("./qaGateService");
const { CLAIM_PROMPT_VERSION } = require("../utils/claimPrompts");
const driftService = require("./driftService");
const metrics = require("../utils/metrics");

metrics.registerMetric("ats_evidence_runs_total", "counter", "Evidence-engine runs by mode and band");

function resolveEngineMode(settings) {
  const tenant = settings?.ai?.atsEngine;
  if (["legacy", "shadow", "live"].includes(tenant)) return tenant;
  const env = (process.env.ATS_ENGINE || "legacy").toLowerCase();
  return ["legacy", "shadow", "live"].includes(env) ? env : "legacy";
}

/**
 * Run the full evidence assessment for a candidate. `mode` is recorded on the
 * document ("shadow" runs must be distinguishable forever).
 * Returns the persisted AtsAssessment.
 * Throws:
 *   { code: "NO_APPROVED_RUBRIC" }   — human hasn't approved a rubric yet
 *   { code: "INVARIANT_VIOLATION" }  — pipeline unsound; caller must alert
 *   any LLM error                    — caller degrades to legacy
 */
async function runEvidenceAssessment(candidate, job, { mode, forceCounterfactual = false } = {}) {
  const t0 = Date.now();

  const rubric = await rubricService.getActiveRubric(job._id, job.company);
  if (!rubric) {
    const err = new Error("No approved rubric for this job — evidence engine requires human-approved criteria");
    err.code = "NO_APPROVED_RUBRIC";
    throw err;
  }

  const claimGraph = await claimService.extractForCandidate(candidate, job);
  const canonicalText = candidate.resumeText || "";

  const { findings, model } = await matchEvidence({ rubric, claimGraph, company: job.company });

  const computed = computeAssessment({
    rubric,
    claims: claimGraph.claims.map((c) => (c.toObject ? c.toObject() : c)),
    findings,
  });

  const { assessment: gated, qa } = await qaGate.runGate({
    assessment: computed,
    rubric,
    claimGraph,
    canonicalText,
    candidate,
    force: { counterfactual: forceCounterfactual },
  });

  const doc = await AtsAssessment.create({
    candidate: candidate._id,
    job: job._id,
    company: job.company,
    rubric: rubric._id,
    rubricVersion: rubric.version,
    claimGraph: claimGraph._id,
    resumeHash: claimGraph.resumeHash,
    stage: "pre_interview",
    mode,
    thresholds: { advance: rubric.thresholds?.advance, review: rubric.thresholds?.review },
    overallScore: gated.overallScore,
    band: gated.band,
    decision: gated.decision,
    reviewReason: gated.reviewReason,
    criterionFindings: gated.criterionFindings,
    topEvidence: gated.topEvidence,
    unverifiedHighWeightClaims: gated.unverifiedHighWeightClaims,
    qa,
    engine: "evidence",
    model,
    promptVersions: [CLAIM_PROMPT_VERSION, MATCH_PROMPT_VERSION],
    scorerVersion: SCORER_VERSION,
    reproducibilityHash: reproducibilityHash({
      rubricId: String(rubric._id),
      rubricVersion: rubric.version,
      resumeHash: claimGraph.resumeHash,
      promptVersions: [CLAIM_PROMPT_VERSION, MATCH_PROMPT_VERSION],
      modelId: model,
    }),
    scoredAt: new Date(),
    latencyMs: Date.now() - t0,
  });

  metrics.incCounter("ats_evidence_runs_total", { mode, band: gated.band });

  // Drift watch (Phase 7.5) — fire and forget, never blocks scoring.
  driftService
    .checkDrift({ job: job._id, company: job.company, rubricVersion: rubric.version })
    .catch(() => {});

  return doc;
}

/** Latest assessment for a candidate (explainability endpoint). */
function latestAssessment(candidateId, companyId) {
  return AtsAssessment.findOne({ candidate: candidateId, company: companyId }).sort({ createdAt: -1 });
}

module.exports = { runEvidenceAssessment, resolveEngineMode, latestAssessment };
