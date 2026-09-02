// Creates pre-verified DEMO login accounts directly in Mongo, bypassing the
// email-verification / OTP step. Use this when SMTP/Brevo isn't sending mail so
// you can't click a verification link (login refuses any account whose
// emailVerified is still false — see authController.login).
//
//   cd backend && npm run seed:demo
//
// Idempotent: re-running resets the passwords and re-activates the workspace.
// This is a LOCAL DEV / DEMO convenience — never run it against production data.
require("dotenv").config();
require("../config/dnsOverride").applyDnsOverride();
const crypto = require("crypto");
const mongoose = require("mongoose");

const { hashPassword } = require("../utils/passwords");
const User = require("../models/User");
const Company = require("../models/Company");
const Subscription = require("../models/Subscription");
const Workspace = require("../models/Workspace");
const CompanySettings = require("../models/CompanySettings");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const { initializeDashboard } = require("../controllers/candidateDashboardController");

// Password satisfies isStrongPassword: 8+ chars, upper, lower, number, special.
const PASSWORD = "Demo@1234";

const ADMIN = { name: "Demo Recruiter", email: "admin@demo.test", phone: "+919999999999" };
const CANDIDATE = { name: "Demo Candidate", email: "candidate@demo.test", phone: "+918888888888" };
const COMPANY = {
  name: "Demo Company",
  companySize: "11-50",
  industry: "Technology",
  country: "India",
  state: "Maharashtra",
  city: "Mumbai",
  address: "1 Demo Street",
};

// The admin login is gated behind an ACTIVE company, so we need a plan to attach
// a subscription to. Prefer a seeded plan; fall back to creating one so this
// script works even if `npm run seed:plans` was never run.
async function ensurePlan() {
  let plan = (await SubscriptionPlan.findOne({ key: "enterprise" })) || (await SubscriptionPlan.findOne());
  if (!plan) {
    plan = await SubscriptionPlan.create({
      key: "enterprise",
      name: "Enterprise",
      description: "Demo plan (auto-created by seedDemoAccounts).",
      limits: {
        maxJobs: 999999,
        maxRecruiters: 999999,
        maxAiInterviews: 999999,
        maxResumeParsing: 999999,
        storageLimitMb: 250000,
      },
      pricing: { monthly: 29999, yearly: 299990 },
    });
    console.log(`Created fallback subscription plan: ${plan.key}`);
  }
  return plan;
}

// Recreate everything workspaceProvisioningService would set up for a paid
// company, so the admin lands on a live workspace instead of the payment wall.
async function seedAdmin(plan) {
  let company = await Company.findOne({ name: COMPANY.name });
  if (!company) {
    company = await Company.create({
      companyCode: `CMP-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
      ...COMPANY,
      status: "active",
    });
  } else if (company.status !== "active") {
    company.status = "active";
    await company.save();
  }

  const passwordHash = await hashPassword(PASSWORD);
  let admin = await User.findOne({ email: ADMIN.email });
  if (!admin) {
    admin = await User.create({
      ...ADMIN,
      passwordHash,
      role: "admin",
      company: company._id,
      emailVerified: true,
    });
  } else {
    admin.set({ passwordHash, role: "admin", company: company._id, emailVerified: true });
    await admin.save();
  }

  const now = new Date();
  const end = new Date(now);
  end.setFullYear(end.getFullYear() + 1);
  await Subscription.findOneAndUpdate(
    { company: company._id },
    {
      company: company._id,
      plan: plan._id,
      billingCycle: "yearly",
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: end,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const existingWs = await Workspace.findOne({ company: company._id });
  if (!existingWs) {
    await Workspace.create({ company: company._id, workspaceId: `ws_${crypto.randomBytes(10).toString("hex")}` });
  }

  await CompanySettings.findOneAndUpdate(
    { company: company._id },
    { company: company._id },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return { admin, company };
}

async function seedCandidate() {
  const passwordHash = await hashPassword(PASSWORD);
  let user = await User.findOne({ email: CANDIDATE.email });
  if (!user) {
    user = await User.create({ ...CANDIDATE, passwordHash, role: "candidate", emailVerified: true });
  } else {
    user.set({ passwordHash, role: "candidate", emailVerified: true });
    await user.save();
  }

  // Mirror what verifyEmail does for candidates so the dashboard screen has data.
  try {
    await initializeDashboard(user._id, user.name, user.email);
  } catch (err) {
    console.warn(`  (candidate dashboard init skipped: ${err.message})`);
  }
  return user;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not set. Run this from the backend/ directory so it picks up backend/.env");
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

  const plan = await ensurePlan();
  const { admin, company } = await seedAdmin(plan);
  const candidate = await seedCandidate();

  await mongoose.disconnect();

  console.log("\n===================  DEMO ACCOUNTS READY  ===================");
  console.log("Both accounts are pre-verified — no email link needed.\n");
  console.log("ADMIN  (recruiter app  http://localhost:5173)");
  console.log(`  email:    ${admin.email}`);
  console.log(`  password: ${PASSWORD}`);
  console.log(`  company:  ${company.name} (${company.status}) — plan: ${plan.name}\n`);
  console.log("CANDIDATE  (candidate app  http://localhost:5174)");
  console.log(`  email:    ${candidate.email}`);
  console.log(`  password: ${PASSWORD}`);
  console.log("=============================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
