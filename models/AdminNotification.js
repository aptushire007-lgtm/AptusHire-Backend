const mongoose = require("mongoose");

const adminNotificationSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    type: {
      type: String,
      enum: [
        "email_verified",
        "workspace_ready",
        "payment_success",
        "payment_failed",
        "invoice_generated",
        "subscription_renewal",
        "new_candidate_applied",
        "ats_completed",
        // Assessment stage. `assessment_contradiction` and `assessment_softlock`
        // are the §3 rule 4/6 human-routing signals and are dispatched with
        // `.catch(() => {})`, so an enum miss silently swallowed the one alert
        // that is supposed to pull a human in.
        "assessment_decision_needed",
        "assessment_contradiction",
        "assessment_softlock",
        // Dispatched from the STAGE_NOTIFICATIONS table, where the throw is NOT
        // caught — a missing entry aborted applyTransition("assessment_completed")
        // itself, so submitting an assessment failed outright.
        "assessment_completed",
        // Human interview rounds (RoundScorecard). `scorecard_contradiction` and
        // `scorecard_disagreement` are the rule 4 routing signals: a person
        // disproved a claim, or a person and the engine reached materially
        // different conclusions. Neither is ever resolved by averaging.
        "scorecard_submitted",
        "scorecard_contradiction",
        "scorecard_disagreement",
        "candidate_shortlisted",
        "candidate_rejected",
        "candidate_stage_changed",
        "candidate_selected",
        "candidate_joined",
        "job_filled",
        "offer_accepted",
        "interview_completed",
        "ai_report_ready",
        // Anti-cheating hard stop (interview side) — mirrors assessment_softlock's role, dispatched
        // with `.catch(() => {})` the same way, see aiInterviewService.terminateForIntegrityViolation.
        "interview_integrity_terminated",
        "password_changed",
        "system_alert",
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

// Notification list, newest-first (adminNotificationController.listMine). Leading company
// also covers the tenant-scope plugin's injected equality (redundant single-field index dropped).
adminNotificationSchema.index({ company: 1, createdAt: -1 });
// Unread badge count (adminNotificationController.unreadCount).
adminNotificationSchema.index({ company: 1, read: 1 });

adminNotificationSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("AdminNotification", adminNotificationSchema);
