const mongoose = require("mongoose");

const subscriptionSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, unique: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: "SubscriptionPlan", required: true },
    billingCycle: { type: String, enum: ["monthly", "yearly"], required: true },
    // Lifecycle (Phase 11.2): active/trialing → past_due at currentPeriodEnd
    // (grace period, in-app warnings) → expired after the grace window (access
    // gated by requireActiveSubscription). cancelled = user-initiated stop.
    status: { type: String, enum: ["trialing", "active", "past_due", "cancelled", "expired"], default: "active" },
    currentPeriodStart: { type: Date, required: true },
    currentPeriodEnd: { type: Date, required: true },
    expiryReminderSentAt: { type: Date },
  },
  { timestamps: true }
);

// Expiry-reminder cron scans active subscriptions ending within the reminder window
// (jobs/subscriptionExpiryJob). This is a cross-tenant system scan.
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

subscriptionSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("Subscription", subscriptionSchema);
