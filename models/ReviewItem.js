// Human review queue (BUILD-PLAN Phase 7.6). Everything the pipeline is NOT
// confident about lands here: review-band scores, QA-gate routings, ambiguous
// disqualifiers. One-click advance/decline resolution writes back a LABELLED
// training signal for Phase 10 calibration.
//
// The gate can only ever move candidates TOWARD this queue, never toward
// auto-rejection.

const mongoose = require("mongoose");

const reviewItemSchema = new mongoose.Schema(
  {
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate", required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    assessment: { type: mongoose.Schema.Types.ObjectId, ref: "AtsAssessment" },

    // Why this landed in the queue, machine-readable + plain-English.
    reasons: { type: [String], default: [] },
    summary: { type: String, default: "" },

    status: { type: String, enum: ["open", "resolved"], default: "open" },
    resolution: {
      decision: { type: String, enum: ["advance", "decline"] },
      note: { type: String, trim: true },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      at: { type: Date },
    },

    // The labelled outcome signal for calibration (Phase 10): what the model
    // said, what the human decided.
    label: {
      engineScore: { type: Number },
      engineBand: { type: String },
      humanDecision: { type: String, enum: ["advance", "decline"] },
    },
  },
  { timestamps: true }
);

// One OPEN item per candidate — repeated reruns must not flood the queue.
reviewItemSchema.index(
  { company: 1, candidate: 1 },
  { unique: true, partialFilterExpression: { status: "open" } }
);
reviewItemSchema.index({ company: 1, status: 1, createdAt: -1 });

reviewItemSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("ReviewItem", reviewItemSchema);
