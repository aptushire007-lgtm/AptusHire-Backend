const mongoose = require("mongoose");

const parsedSnapshotSchema = new mongoose.Schema(
  {
    skills: { type: [String], default: [] },
    experienceYears: { type: Number, default: 0 },
    certifications: { type: [String], default: [] },
    educationTier: { type: String, trim: true },
    suggestedRoles: { type: [String], default: [] },
    rawText: { type: String, default: "" },
    textHash: { type: String, required: true, index: true },
  },
  { _id: false }
);

const shareLogSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    companyName: { type: String, required: true },
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    jobTitle: { type: String, required: true },
    sharedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const resumeVersionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    candidateEmail: { type: String, required: true, lowercase: true, index: true },
    label: { type: String, required: true, trim: true },
    tags: { type: [String], default: [] },
    fileUrl: { type: String, required: true },
    filePath: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    mimeType: { type: String, required: true },
    checksum: { type: String, required: true },

    parsedSnapshot: { type: parsedSnapshotSchema, required: true },
    // Same candidate-reviewed suggestion cache used by legacy Resume records.
    // Keeping it on the version lets applying preserve provenance after a
    // version-only upload has been selected.
    autofill: { type: mongoose.Schema.Types.Mixed },
    parseConfidence: { type: Number, min: 0, max: 100, default: 92 },

    isDefault: { type: Boolean, default: false },
    isArchived: { type: Boolean, default: false, index: true },

    applyCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date },
    shareLog: { type: [shareLogSchema], default: [] },
  },
  { timestamps: true }
);

resumeVersionSchema.index({ user: 1, isDefault: 1 });
resumeVersionSchema.index({ user: 1, isArchived: 1 });

module.exports = mongoose.model("ResumeVersion", resumeVersionSchema);
