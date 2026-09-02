// Demo / pilot escape hatch for the subscription gates.
//
// Normally a company workspace stays locked until a payment has been provisioned
// (Company.status "active"). During a live demo or a pre-billing pilot there is no
// Razorpay account to charge against, so every recruiter login dead-ends at
// /pricing (403 PAYMENT_REQUIRED) and every dashboard call 403s with
// COMPANY_INACTIVE. This flag lifts exactly those two gates.
//
// Fail-safe by construction: enforcement is ON unless the value is the literal
// string "off". Unset, empty, "false", "0" or a typo all keep the paywall up —
// the dangerous state is never the accidental one. Re-enabling is a single env
// change plus a restart, with no data migration to undo, because the bypass never
// rewrites a suspended tenant's status (see services/demoActivationService.js).
//
// Scope — what this does NOT touch:
//   * plan quotas (quotaService) and subscription expiry (requireActiveSubscription)
//   * anything in the rubric / claim / evidence / scoring path
//   * the Razorpay webhook, which still provisions normally if a real payment lands
function billingEnforced() {
  return String(process.env.BILLING_ENFORCEMENT || "").trim().toLowerCase() !== "off";
}

// Plan attached to workspaces auto-provisioned by the bypass. Defaults to the
// largest seeded tier so a demo is never cut short by a quota that exists only to
// price a plan — a "free_trial" demo would stop at 2 jobs and 5 AI interviews.
function demoPlanKey() {
  return (process.env.DEMO_PLAN_KEY || "enterprise").trim();
}

module.exports = { billingEnforced, demoPlanKey };
