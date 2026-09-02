const crypto = require("crypto");
const Subscription = require("../models/Subscription");
const Workspace = require("../models/Workspace");
const CompanySettings = require("../models/CompanySettings");
const { notifyAdmin } = require("./notificationService");

function generateWorkspaceId() {
  return `ws_${crypto.randomBytes(10).toString("hex")}`;
}

function computePeriodEnd(start, billingCycle) {
  const end = new Date(start);
  if (billingCycle === "yearly") {
    end.setFullYear(end.getFullYear() + 1);
  } else {
    end.setMonth(end.getMonth() + 1);
  }
  return end;
}

async function provisionWorkspace({ company, plan, billingCycle }) {
  const now = new Date();

  const subscription = await Subscription.findOneAndUpdate(
    { company: company._id },
    {
      company: company._id,
      plan: plan._id,
      billingCycle,
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: computePeriodEnd(now, billingCycle),
    },
    { upsert: true, new: true }
  );

  let workspace = await Workspace.findOne({ company: company._id });
  if (!workspace) {
    workspace = await Workspace.create({ company: company._id, workspaceId: generateWorkspaceId() });
  }

  const settings = await CompanySettings.findOneAndUpdate(
    { company: company._id },
    { company: company._id },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // AI cost as a plan dimension (Phase 11.4): seed the tenant's monthly LLM
  // budget from the plan default so the unit economics hold out of the box.
  // Only when unset (0 = uncapped) — a tenant's own explicit setting wins.
  const planBudget = plan?.limits?.aiBudgetCents;
  if (planBudget && !(settings.ai?.monthlyBudgetCents > 0)) {
    settings.ai = { ...(settings.ai?.toObject?.() || settings.ai || {}), monthlyBudgetCents: planBudget };
    await settings.save();
  }

  company.status = "active";
  await company.save();

  await notifyAdmin({
    companyId: company._id,
    type: "workspace_ready",
    title: "Workspace activated",
    message: `Your ${company.name} workspace is now active on the ${plan.name} plan.`,
    email: { template: "workspaceReadyEmailTemplate", args: (admin) => [company, admin.name] },
  });

  return { subscription, workspace };
}

module.exports = { provisionWorkspace };
