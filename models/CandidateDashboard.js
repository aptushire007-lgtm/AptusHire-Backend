const mongoose = require("mongoose");

const candidateDashboardSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },

    initializedAt: { type: Date, default: Date.now },
    welcomeNotificationSent: { type: Boolean, default: false },
    layoutPreferences: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CandidateDashboard", candidateDashboardSchema);
