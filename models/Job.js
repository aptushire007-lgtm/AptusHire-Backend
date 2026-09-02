const mongoose = require("mongoose");

const jobSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    title: { type: String, required: true, trim: true },
    slug: { type: String, unique: true, sparse: true, index: true },
    department: { type: String, trim: true },
    location: { type: String, trim: true },
    description: { type: String, required: true },
    requirements: { type: String },
    status: { type: String, enum: ["draft", "published", "closed"], default: "draft" },

    requiredSkills: { type: [String], default: [] },
    minExperienceYears: { type: Number, default: 0 },
    requiredEducation: { type: String, trim: true },
    atsThreshold: { type: Number, default: 60, min: 0, max: 100 },
    interviewInstructions: { type: String, trim: true },
    // Optional per-job interview length overrides (Phase 8.3). The interview can
    // end early once all claim-probes are covered and min is reached; max is the
    // hard ceiling.
    interviewMinQuestions: { type: Number, min: 1, max: 30 },
    interviewMaxQuestions: { type: Number, min: 1, max: 30 },

    // Assessment engine (ASSESSMENT-ENGINE-PLAN A2.3) — the per-job gate.
    //   off    → today's flow, untouched (the default for every existing job).
    //   manual → ATS-passed candidates PARK at ats_passed until a recruiter
    //            explicitly chooses "Send assessment" or "Skip to AI interview".
    //   auto   → every ATS pass is auto-assigned (sanctioned only for
    //            high-volume drives, A4.4 — creating the drive IS the bulk
    //            assignment decision).
    assessmentPolicy: { type: String, enum: ["off", "manual", "auto"], default: "off" },
    // Per-job assessment window config (applies at assignment time).
    assessmentValidityHours: { type: Number, min: 1, max: 720 },     // link validity (default env, 72h)
    assessmentStartDeadlineHours: { type: Number, min: 1, max: 720 }, // must START within this (default = validity)
  },
  { timestamps: true }
);

jobSchema.statics.findByIdOrSlug = function (idOrSlug) {
  if (mongoose.Types.ObjectId.isValid(idOrSlug)) {
    return this.findOne({ $or: [{ _id: idOrSlug }, { slug: idOrSlug }] });
  }
  return this.findOne({ slug: idOrSlug });
};

// Recruiter job list — a tenant's jobs newest-first (jobController.listJobs). Leading
// `company` also covers the tenant-scope plugin's injected equality (redundant single-field
// company index dropped).
jobSchema.index({ company: 1, createdAt: -1 });
// Public job board — published jobs newest-first, across tenants (jobController.listPublicJobs).
jobSchema.index({ status: 1, createdAt: -1 });

jobSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("Job", jobSchema);
