const mongoose = require("mongoose");

const subscriptionPlanSchema = new mongoose.Schema(
  {
    key: { type: String, enum: ["free_trial", "starter", "professional", "enterprise"], required: true, unique: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    limits: {
      maxJobs: { type: Number, required: true },
      maxRecruiters: { type: Number, required: true },
      maxAiInterviews: { type: Number, required: true },
      maxResumeParsing: { type: Number, required: true },
      storageLimitMb: { type: Number, required: true },
      // Monthly LLM budget default in cents (Phase 11.4). Seeded into the
      // tenant's CompanySettings.ai.monthlyBudgetCents at provisioning when the
      // tenant hasn't set an explicit budget. 0 = uncapped.
      aiBudgetCents: { type: Number, default: 0 },
    },

    pricing: {
      monthly: { type: Number, required: true },
      yearly: { type: Number, required: true },
    },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SubscriptionPlan", subscriptionPlanSchema);
