const mongoose = require("mongoose");

const notificationPreferenceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    emailEnabled: { type: Boolean, default: true },
    inAppEnabled: { type: Boolean, default: true },
    mutedTypes: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("NotificationPreference", notificationPreferenceSchema);
