require("dotenv").config();
require("../config/dnsOverride").applyDnsOverride();
const mongoose = require("mongoose");
const SubscriptionPlan = require("../models/SubscriptionPlan");

const PLANS = [
  {
    key: "free_trial",
    name: "Free Trial",
    description: "Try the platform for 14 days with a small hiring workload.",
    limits: { maxJobs: 2, maxRecruiters: 1, maxAiInterviews: 5, maxResumeParsing: 20, storageLimitMb: 500, aiBudgetCents: 500 },
    pricing: { monthly: 0, yearly: 0 },
  },
  {
    key: "starter",
    name: "Starter",
    description: "For small teams hiring occasionally.",
    limits: { maxJobs: 10, maxRecruiters: 3, maxAiInterviews: 50, maxResumeParsing: 200, storageLimitMb: 5000, aiBudgetCents: 2500 },
    pricing: { monthly: 2999, yearly: 29990 },
  },
  {
    key: "professional",
    name: "Professional",
    description: "For growing teams with active pipelines.",
    limits: { maxJobs: 50, maxRecruiters: 10, maxAiInterviews: 300, maxResumeParsing: 1000, storageLimitMb: 25000, aiBudgetCents: 10000 },
    pricing: { monthly: 9999, yearly: 99990 },
  },
  {
    key: "enterprise",
    name: "Enterprise",
    description: "For large organizations with high-volume hiring.",
    limits: { maxJobs: 999999, maxRecruiters: 999999, maxAiInterviews: 999999, maxResumeParsing: 999999, storageLimitMb: 250000, aiBudgetCents: 50000 },
    pricing: { monthly: 29999, yearly: 299990 },
  },
];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

  for (const plan of PLANS) {
    await SubscriptionPlan.findOneAndUpdate({ key: plan.key }, plan, { upsert: true, new: true, setDefaultsOnInsert: true });
    console.log(`Upserted plan: ${plan.key}`);
  }

  await mongoose.disconnect();
  console.log("Done seeding subscription plans.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
