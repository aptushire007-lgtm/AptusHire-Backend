// Subscription lifecycle (BUILD-PLAN Phase 11.2). Before this, expiry did
// nothing: the cron sent a reminder, `past_due` was never set, and no request
// path read currentPeriodEnd. Now: a daily transition pass moves lapsed
// subscriptions active → past_due (grace) → expired, and
// `requireActiveSubscription` (middleware/auth.js) gates mutating recruiter
// requests once expired — reads stay available (read-only mode, clear
// messaging, never data lockout).

const Subscription = require("../models/Subscription");
const { notifyAdmin } = require("./notificationService");

function graceDays() {
  const n = Number(process.env.SUBSCRIPTION_GRACE_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : 7;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure: where a subscription stands right now.
 *   "none"    — no subscription (company-status gates own this case)
 *   "active"  — inside the paid period (or cancelled-but-not-yet-ended)
 *   "grace"   — past the period end, inside the grace window
 *   "expired" — past grace; mutating access is gated
 */
function assess(subscription, now = new Date()) {
  if (!subscription || !subscription.currentPeriodEnd) return "none";
  const end = new Date(subscription.currentPeriodEnd).getTime();
  if (now.getTime() <= end) return "active";
  if (now.getTime() <= end + graceDays() * DAY_MS) return "grace";
  return "expired";
}

/**
 * Daily transition pass (called from the expiry cron). Sets past_due at period
 * end and expired after grace, notifying the tenant's admins at each step.
 */
async function runTransitions(now = new Date()) {
  // active/trialing whose period has ended → past_due
  const lapsed = await Subscription.find({
    status: { $in: ["active", "trialing"] },
    currentPeriodEnd: { $lt: now },
  });
  for (const sub of lapsed) {
    sub.status = "past_due";
    await sub.save();
    await notifyAdmin({
      companyId: sub.company,
      type: "subscription_renewal",
      title: "Subscription past due",
      message: `Your subscription period has ended. You have ${graceDays()} day(s) of grace before access becomes read-only — renew to avoid interruption.`,
      meta: { subscriptionId: sub._id, status: "past_due" },
    }).catch(() => {});
  }

  // past_due beyond the grace window → expired
  const graceCutoff = new Date(now.getTime() - graceDays() * DAY_MS);
  const dead = await Subscription.find({ status: "past_due", currentPeriodEnd: { $lt: graceCutoff } });
  for (const sub of dead) {
    sub.status = "expired";
    await sub.save();
    await notifyAdmin({
      companyId: sub.company,
      type: "subscription_renewal",
      title: "Subscription expired",
      message: "Your subscription has expired. Your workspace is now read-only — renew to restore full access. Your data is retained per your retention policy.",
      meta: { subscriptionId: sub._id, status: "expired" },
    }).catch(() => {});
  }

  return { pastDue: lapsed.length, expired: dead.length };
}

module.exports = { assess, runTransitions, graceDays };
