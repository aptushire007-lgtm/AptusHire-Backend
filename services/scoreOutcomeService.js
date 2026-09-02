// Outcome capture (BUILD-PLAN Phase 10.1) — every pipeline transition updates
// the candidate's ScoreOutcome row. Fire-and-forget from pipelineService: a
// metering failure must never block a stage move.

const ScoreOutcome = require("../models/ScoreOutcome");
const AtsAssessment = require("../models/AtsAssessment");
const { normalizeStage, stageIndex, REJECTED } = require("../utils/pipeline");

// "Advanced" = reached shortlisted or beyond — the first stage that is
// unambiguously a positive HUMAN decision after screening + AI interview.
const ADVANCE_INDEX = stageIndex("shortlisted");

/** Pure: what a stage means as an outcome milestone. */
function outcomeForStage(stage) {
  const s = normalizeStage(stage);
  if (s === REJECTED) return "rejected";
  if (stageIndex(s) >= ADVANCE_INDEX) return "advanced";
  return "pending";
}

/** Pure: milestone escalation — once decided (advanced/rejected), the
 * milestone is immutable; only a pending row can move. */
function nextOutcome(current, incoming) {
  return current === "pending" ? incoming : current;
}

/**
 * Record a stage transition against the candidate's score. Creates the row on
 * first sight (using the latest pre-interview assessment, or the legacy ATS
 * score when no evidence assessment exists), then escalates the milestone.
 * Never throws.
 */
async function recordTransition(candidate, toStage, { by } = {}) {
  try {
    const companyId = candidate.company;
    const incoming = outcomeForStage(toStage);

    let existing = await ScoreOutcome.findOne({ company: companyId, candidate: candidate._id });
    if (!existing) {
      const assessment = await AtsAssessment.findOne({
        candidate: candidate._id,
        company: companyId,
        stage: "pre_interview",
      }).sort({ createdAt: -1 });

      const score = assessment ? assessment.overallScore : candidate.ats?.overallScore;
      if (score == null) return null; // nothing scored this candidate — nothing to calibrate

      existing = new ScoreOutcome({
        company: companyId,
        job: candidate.job?._id || candidate.job,
        candidate: candidate._id,
        assessment: assessment?._id,
        rubric: assessment?.rubric,
        rubricVersion: assessment?.rubricVersion,
        engine: assessment ? "evidence" : "legacy",
        score: Math.max(0, Math.min(100, Math.round(score))),
        band: assessment?.band || candidate.ats?.decision || "",
        engineDecision: assessment?.decision || candidate.ats?.decision || "",
      });
    }

    const updated = nextOutcome(existing.outcome, incoming);
    if (updated !== existing.outcome && existing.outcome === "pending") {
      existing.outcome = updated;
      existing.outcomeAt = new Date();
      existing.decidedBy = by || "system";
    }
    existing.finalStage = normalizeStage(toStage);
    await existing.save();
    return existing;
  } catch (err) {
    console.error("[scoreOutcome] failed to record transition:", err.message);
    return null;
  }
}

module.exports = { recordTransition, outcomeForStage, nextOutcome, ADVANCE_INDEX };
