const mongoose = require("mongoose");

const candidatePreferencesSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },

    preferredJobTypes: { type: [String], default: [] },
    preferredLocations: { type: [String], default: [] },
    expectedSalaryMin: { type: Number },

    notifyByEmail: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CandidatePreferences", candidatePreferencesSchema);
