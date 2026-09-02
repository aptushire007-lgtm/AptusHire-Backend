// Per-tenant LLM usage metering + budget enforcement. Every LLM call records a
// UsageEvent (cost attribution + audit trail); before a call, callers can check
// isOverBudget() so one tenant can't run up unbounded spend on the shared key.

const UsageEvent = require("../models/UsageEvent");
const tenantContext = require("../utils/tenantContext");

// Record one metered call. Best-effort — a metering failure must never break the
// interview, so errors are swallowed and logged.
async function recordUsage({ company, session, candidate, kind, provider, model, usage, latencyMs, engine, promptVersion, cached }) {
  try {
    const promptTokens = usage?.promptTokens || 0;
    const completionTokens = usage?.completionTokens || 0;
    return await UsageEvent.create({
      company,
      session,
      candidate,
      kind,
      provider,
      model,
      promptVersion,
      cached: Boolean(cached),
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costCents: usage?.costCents || 0,
      latencyMs,
      engine: engine || "ai",
    });
  } catch (err) {
    console.error("[usage] failed to record usage:", err.message);
    return null;
  }
}

// Month-to-date spend for a company, in cents. Runs as a trusted system query so the
// aggregate isn't blocked by strict tenant-guard mode; scoped explicitly by company.
async function monthToDateCents(companyId) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const rows = await tenantContext.runAsSystem(() =>
    UsageEvent.aggregate([
      { $match: { company: new (require("mongoose").Types.ObjectId)(String(companyId)), createdAt: { $gte: start } } },
      { $group: { _id: null, cents: { $sum: "$costCents" } } },
    ])
  );
  return rows[0]?.cents || 0;
}

// True when the tenant has a budget and has reached/exceeded it (and hard-capping is on).
// A budget of 0 means uncapped. hardCap=false means "warn but keep serving".
async function isOverBudget(companyId, aiSettings) {
  const budget = aiSettings?.monthlyBudgetCents || 0;
  if (!budget) return false;
  if (aiSettings?.hardCap === false) return false;
  const spent = await monthToDateCents(companyId);
  return spent >= budget;
}

module.exports = { recordUsage, monthToDateCents, isOverBudget };
