const mongoose = require("mongoose");

const interviewQueueSchema = new mongoose.Schema(
  {
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate", required: true, unique: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    atsScore: { type: Number, required: true },
    status: { type: String, enum: ["queued", "removed"], default: "queued" },
  },
  { timestamps: true }
);

// Recruiter queue view: a tenant's queued entries, highest ATS first then oldest
// (interviewQueueController.listQueue). company+status match the filter; atsScore+createdAt
// serve the sort. Replaces the redundant single-field company index.
interviewQueueSchema.index({ company: 1, status: 1, atsScore: -1, createdAt: 1 });

interviewQueueSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("InterviewQueue", interviewQueueSchema);
