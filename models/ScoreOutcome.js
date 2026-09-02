// ScoreOutcome (BUILD-PLAN Phase 10.1) — one row per scored candidate joining
// the engine's assessment to what actually happened in the pipeline. This is
// the raw material calibration is computed from ("candidates scored like this
// advanced past HR 42% of the time HERE").
//
// The outcome is a MILESTONE, not a final disposition: once a candidate has
// advanced past the screening stages (reached "shortlisted" or beyond), the
// milestone happened — a later rejection doesn't un-happen it. `finalStage`
// separately tracks where the journey ended.

const mongoose = require("mongoose");

const scoreOutcomeSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate", required: true },
    assessment: { type: mongoose.Schema.Types.ObjectId, ref: "AtsAssessment" },
    rubric: { type: mongoose.Schema.Types.ObjectId, ref: "RoleRubric" },
    rubricVersion: { type: Number },

    engine: { type: String, enum: ["evidence", "legacy"], required: true },
    score: { type: Number, required: true, min: 0, max: 100 },
    band: { type: String },
    engineDecision: { type: String },

    // pending → advanced | rejected (rejected only BEFORE ever advancing).
    outcome: { type: String, enum: ["pending", "advanced", "rejected"], default: "pending" },
    finalStage: { type: String },
    outcomeAt: { type: Date },
    decidedBy: { type: String }, // actor name from stageHistory — human vs system is auditable
  },
  { timestamps: true }
);

scoreOutcomeSchema.index({ company: 1, candidate: 1 }, { unique: true });
scoreOutcomeSchema.index({ company: 1, outcome: 1, score: 1 });
scoreOutcomeSchema.index({ company: 1, rubric: 1, rubricVersion: 1 });

scoreOutcomeSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("ScoreOutcome", scoreOutcomeSchema);
