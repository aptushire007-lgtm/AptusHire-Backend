// Activates a not-yet-paid tenant when billing enforcement is off.
//
// This provisions the SAME shape a paying customer gets — Subscription +
// Workspace + CompanySettings + seeded AI budget — rather than just flipping
// Company.status to "active". A half-provisioned tenant looks fine at login and
// then surfaces later as a null workspace id, an empty billing screen and an
// uncapped LLM spend, which is a worse demo than the paywall it replaced.
//
// Suspension is deliberately NOT undone. A suspended tenant is waved through the
// gates while the bypass is on, but its status stays "suspended" on disk, so
// restoring BILLING_ENFORCEMENT restores the lockout exactly as platform staff
// left it. Un-suspending remains an explicit platform-console action.

const SubscriptionPlan = require("../models/SubscriptionPlan");
const { provisionWorkspace } = require("./workspaceProvisioningService");
const { billingEnforced, demoPlanKey } = require("../utils/billingMode");

async function resolveDemoPlan() {
  return (
    (await SubscriptionPlan.findOne({ key: demoPlanKey() })) ||
    // Fall back to the most expensive seeded plan — highest limits, least likely
    // to interrupt a demo.
    (await SubscriptionPlan.findOne().sort({ "pricing.monthly": -1 }))
  );
}

/**
 * Idempotent. No-op when billing is enforced, when the tenant is already active,
 * or when it is suspended. Returns true only if it activated something.
 */
async function activateIfBypassed(company) {
  if (billingEnforced()) return false;
  if (!company || company.status === "active" || company.status === "suspended") return false;

  const plan = await resolveDemoPlan();
  if (!plan) {
    // No plans seeded. Activate anyway so the demo isn't blocked — quotaService
    // treats a tenant with no subscription row as unmetered, so this degrades to
    // "works, but the billing screen is empty" rather than a hard failure.
    console.warn(
      `[billing-bypass] no SubscriptionPlan found (run \`npm run seed:plans\`) — activating ` +
        `${company.name} with no subscription row; quotas will be unmetered.`
    );
    company.status = "active";
    await company.save();
    return true;
  }

  await provisionWorkspace({ company, plan, billingCycle: "monthly" });
  console.warn(`[billing-bypass] activated ${company.name} on the "${plan.key}" plan without payment`);
  return true;
}

module.exports = { activateIfBypassed, resolveDemoPlan };
