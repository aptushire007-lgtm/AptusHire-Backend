const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate" },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    type: {
      type: String,
      enum: [
        "welcome",
        "interview_invite",
        "application_submitted",
        "ats_result_pass",
        "ats_result_fail",
        // Assessment stage sits between ATS and interview (assessmentService,
        // assessmentReminderJob). Omitting these made every invite/resend throw
        // in notifyCandidate *before* the email dispatch, so the candidate got
        // no link at all — see test/unit/notificationTypes.test.js.
        "assessment_invite",
        "assessment_reminder",
        "assessment_completed",
        "interview_reminder",
        "interview_completed",
        "next_round_scheduled",
        "offer_letter",
        "rejection",
        "stage_changed",
        "offer_accepted",
        "joined",
        "profile_updated",
        "password_changed",
      ],
      required: true,
    },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true },
    read: { type: Boolean, default: false },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

// A logged-in candidate's notifications are keyed by user OR by owned application ids,
// always listed newest-first (notificationController). These compounds replace the
// redundant single-field candidate/user indexes.
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ candidate: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
