const mongoose = require("mongoose");

const candidateRejectionReportSchema = new mongoose.Schema(
  {
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate", required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate", required: true },
    reportVersion: { type: Number, required: true },
    atsVersion: { type: String },
    evidenceVersion: { type: String, default: "deterministic-v1" },
    summary: { type: String, required: true },
    overallAlignment: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    rejectionReasons: { type: [mongoose.Schema.Types.Mixed], default: [] },
    requirementAnalysis: { type: [mongoose.Schema.Types.Mixed], default: [] },
    assessmentAnalysis: { type: mongoose.Schema.Types.Mixed, default: () => ({ status: "Not Assessed" }) },
    interviewAnalysis: { type: mongoose.Schema.Types.Mixed, default: () => ({ status: "Not Assessed" }) },
    claimValidation: { type: [mongoose.Schema.Types.Mixed], default: [] },
    skillGaps: { type: [mongoose.Schema.Types.Mixed], default: [] },
    areasOfImprovement: { type: [mongoose.Schema.Types.Mixed], default: [] },
    improvementPlan: { type: [mongoose.Schema.Types.Mixed], default: [] },
    reapplicationReadiness: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    evidence: { type: [mongoose.Schema.Types.Mixed], default: [] },
    confidence: { type: String, enum: ["Low", "Medium", "High"], default: "Low" },
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

candidateRejectionReportSchema.index({ company: 1, candidate: 1, createdAt: -1 });
candidateRejectionReportSchema.index({ company: 1, applicationId: 1, reportVersion: -1 });
candidateRejectionReportSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("CandidateRejectionReport", candidateRejectionReportSchema);