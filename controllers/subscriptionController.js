const SubscriptionPlan = require("../models/SubscriptionPlan");
const Subscription = require("../models/Subscription");

async function listPlans(req, res) {
  const plans = await SubscriptionPlan.find({ isActive: true }).sort({ "pricing.monthly": 1 });
  res.json(plans);
}

async function getCompanySubscription(req, res) {
  if (!req.user.company) {
    return res.status(400).json({ error: "This account is not associated with a company" });
  }
  const subscription = await Subscription.findOne({ company: req.user.company }).populate("plan");
  if (!subscription) {
    return res.status(404).json({ error: "No active subscription found" });
  }
  res.json(subscription);
}

// GET /api/subscriptions/usage — plan-limit usage for the billing screen
// (Phase 11.3): per-dimension used/limit/remaining plus a nearLimit flag so the
// UI can warn BEFORE the wall, not at it.
async function getUsage(req, res) {
  if (!req.user.company) {
    return res.status(400).json({ error: "This account is not associated with a company" });
  }
  res.json(await require("../services/quotaService").usage(req.user.company));
}

module.exports = { listPlans, getCompanySubscription, getUsage };
