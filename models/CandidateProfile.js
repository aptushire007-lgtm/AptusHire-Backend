const mongoose = require("mongoose");

const verificationStateSchema = new mongoose.Schema(
  {
    nameMatch: { type: String, enum: ["verified", "pending", "mismatch", "missing"], default: "missing" },
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date },
    phoneVerified: { type: Boolean, default: false },
    phoneVerifiedAt: { type: Date },
    dobMatch: { type: String, enum: ["verified", "pending", "mismatch", "missing"], default: "missing" },
    govDocVerified: { type: Boolean, default: false },
    govDocVerifiedAt: { type: Date },
    linkedinLinked: { type: Boolean, default: false },
    linkedinProfileUrl: { type: String, trim: true },
    linkedinVerifiedAt: { type: Date },
  },
  { _id: false }
);

const educationEntrySchema = new mongoose.Schema(
  {
    institution: { type: String, required: true, trim: true },
    degree: { type: String, required: true, trim: true },
    fieldOfStudy: { type: String, trim: true },
    startYear: { type: String, trim: true },
    endYear: { type: String, trim: true },
    grade: { type: String, trim: true },
    current: { type: Boolean, default: false },
  },
  { _id: true }
);

const experienceEntrySchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    startDate: { type: String, trim: true },
    endDate: { type: String, trim: true },
    current: { type: Boolean, default: false },
    summary: { type: String, trim: true },
    skills: { type: [String], default: [] },
  },
  { _id: true }
);

const preferencesSchema = new mongoose.Schema(
  {
    jobAlerts: { type: Boolean, default: true },
    whatsappUpdates: { type: Boolean, default: false },
    smsUpdates: { type: Boolean, default: false },
    availabilityWindow: { type: String, enum: ["immediate", "15_days", "30_days", "60_days"], default: "30_days" },
    aiScreeningConsent: { type: Boolean, default: true },
    dataRetentionConsent: { type: Boolean, default: true },
    consentTimestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const candidateProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },

    // Legacy and fast access fields
    headline: { type: String, trim: true },
    location: { type: String, trim: true },
    skills: { type: [String], default: [] },
    bio: { type: String, trim: true },

    // Structured personal info
    personal: {
      firstName: { type: String, trim: true },
      lastName: { type: String, trim: true },
      dob: { type: Date },
      phone: { type: String, trim: true },
      locationCity: { type: String, trim: true },
      photoUrl: { type: String, trim: true },
    },

    verification: { type: verificationStateSchema, default: () => ({}) },
    education: { type: [educationEntrySchema], default: [] },
    experience: { type: [experienceEntrySchema], default: [] },
    preferences: { type: preferencesSchema, default: () => ({}) },

    savedJobs: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Job" }], default: [] },
    dismissedJobs: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Job" }], default: [] },

    profileCompletionPercent: { type: Number, default: 0, min: 0, max: 100 },
    strengthScore: { type: Number, default: 0, min: 0, max: 100 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CandidateProfile", candidateProfileSchema);
