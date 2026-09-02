// AtsAssessment (BUILD-PLAN Phase 6.4) — one evidence-engine scoring run.
// Supersedes the flat Candidate.ats subdoc as the source of truth (that subdoc
// stays populated for backward compatibility with every existing screen).
//
// Never overwritten: a rescore (including Phase 8's post-interview rescore)
// creates a NEW document. The pre/post delta is itself a product feature.

const mongoose = require("mongoose");

const criterionFindingSchema = new mongoose.Schema(
  {
    criterionId: { type: String, required: true },
    label: { type: String, required: true },
    kind: { type: String, enum: ["must_have", "nice_to_have", "disqualifier"], required: true },
    weight: { type: Number, required: true },
    status: { type: String, enum: ["satisfied", "partial", "absent", "contradicted"], required: true },
    supportingClaimIds: { type: [String], default: [] },
    reasoning: { type: String, default: "" },
    confidence: { type: Number, min: 0, max: 1, default: 0 },
    criterionScore: { type: Number, required: true }, // statusValue × multipliers, [0,1]
    points: { type: Number, required: true },         // criterionScore × weight × 100
  },
  { _id: false }
);

const atsAssessmentSchema = new mongoose.Schema(
  {
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate", required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    rubric: { type: mongoose.Schema.Types.ObjectId, ref: "RoleRubric", required: true },
    rubricVersion: { type: Number, required: true },
    claimGraph: { type: mongoose.Schema.Types.ObjectId, ref: "ClaimGraph", required: true },
    resumeHash: { type: String, required: true },

    // post_assessment (A3.3) sits between the pre and post_interview legs: the same
    // pure rescore machinery, run after the skills-assessment verdict write-back.
    stage: { type: String, enum: ["pre_interview", "post_assessment", "post_interview"], default: "pre_interview" },
    // shadow = logged only, behaviour ran on the legacy engine; live = this
    // assessment drove the decision.
    mode: { type: String, enum: ["shadow", "live"], required: true },

    // Snapshot of the frozen rubric's thresholds at scoring time, so the
    // explainability screen renders correctly even after the rubric archives.
    thresholds: {
      advance: { type: Number },
      review: { type: Number },
    },

    overallScore: { type: Number, required: true, min: 0, max: 100 },
    band: { type: String, enum: ["advance", "review", "decline"], required: true },
    decision: { type: String, enum: ["pass", "review", "fail"], required: true },
    reviewReason: { type: String, default: "" },
    confidence: { type: Number, min: 0, max: 1 },

    criterionFindings: { type: [criterionFindingSchema], default: [] },
    topEvidence: {
      type: [
        new mongoose.Schema(
          { criterionId: String, claimId: String, quote: String },
          { _id: false }
        ),
      ],
      default: [],
    },
    unverifiedHighWeightClaims: {
      type: [
        new mongoose.Schema({ claimId: String, criterionId: String }, { _id: false }),
      ],
      default: [],
    },

    // QA gate results (Phase 7). `outcome`: passed | routed_review | hard_failed.
    qa: {
      mode: { type: String, enum: ["off", "monitor", "enforce"] },
      outcome: { type: String, enum: ["passed", "routed_review", "hard_failed"] },
      reasons: { type: [String], default: [] },
      agreement: { type: Number },
      criticDropped: { type: Number },
      counterfactual: {
        ran: { type: Boolean, default: false },
        identical: { type: Boolean },
        dimension: { type: String },
      },
    },

    engine: { type: String, enum: ["evidence"], default: "evidence" },
    model: { type: String },
    promptVersions: { type: [String], default: [] },
    scorerVersion: { type: String },
    reproducibilityHash: { type: String, required: true },
    scoredAt: { type: Date, required: true },
    latencyMs: { type: Number },
  },
  { timestamps: true }
);

atsAssessmentSchema.index({ company: 1, candidate: 1, createdAt: -1 });
atsAssessmentSchema.index({ company: 1, job: 1, rubricVersion: 1, createdAt: -1 });
atsAssessmentSchema.index({ company: 1, mode: 1, band: 1 });

atsAssessmentSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("AtsAssessment", atsAssessmentSchema);
