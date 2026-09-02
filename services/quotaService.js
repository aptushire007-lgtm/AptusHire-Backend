// Plan-limit enforcement (BUILD-PLAN Phase 11.1). The seeded SubscriptionPlan
// limits were schema-required and enforced NOWHERE — the business model was
// decorative. This service makes them real.
//
// Rules:
//   - Quotas block at the START of a unit of work, never mid-flight — an
//     in-progress interview is never killed by a limit.
//   - A block is a 429 with a machine-readable reason + an AuditLog row.
//     Silent failure churns customers; a wall with no explanation is a bug.
//   - A tenant with NO subscription row is NOT blocked here — company status
//     gates (requireActiveCompany) own that case. Quotas only bind tenants to
//     the plan they actually bought.

const Subscription = require("../models/Subscription");
const Job = require("../models/Job");
const User = require("../models/User");
const Candidate = require("../models/Candidate");
const InterviewSession = require("../models/InterviewSession");
const AuditLog = require("../models/AuditLog");

const DIMENSIONS = {
  jobs: { limitKey: "maxJobs", label: "job postings", window: "total" },
  recruiters: { limitKey: "maxRecruiters", label: "recruiter accounts", window: "total" },
  aiInterviews: { limitKey: "maxAiInterviews", label: "AI interviews this billing period", window: "period" },
  resumeParsing: { limitKey: "maxResumeParsing", label: "resume screenings this billing period", window: "period" },
  storageMb: { limitKey: "storageLimitMb", label: "storage (MB)", window: "total" },
  // ASSESSMENT-ENGINE-PLAN §7: counts STARTED sessions only — invitations that
  // expire untouched consume neither quota nor money. Enforced at start, never
  // mid-flight. Plans without a maxAssessments limit are simply unmetered.
  assessments: { limitKey: "maxAssessments", label: "skills assessments this billing period", window: "period" },
  // LIVEKIT-REALTIME-PLAN §4: a FAIRNESS cap, not a billing one — how many realtime voice
  // interviews a tenant may run at the same moment, so one company's hiring drive cannot starve
  // the shared worker fleet. Plans without maxConcurrentRealtime fall back to the deployment
  // default (LIVEKIT_MAX_CONCURRENT_SESSIONS) in livekitController rather than being unmetered.
  concurrentRealtime: { limitKey: "maxConcurrentRealtime", label: "concurrent live voice interviews", window: "concurrent" },
};

async function planContext(companyId) {
  const subscription = await Subscription.findOne({ company: companyId }).populate("plan");
  if (!subscription || !subscription.plan) return null;
  const periodStart =
    subscription.currentPeriodStart instanceof Date
      ? subscription.currentPeriodStart
      : new Date(new Date().setUTCDate(1));
  return { subscription, plan: subscription.plan, periodStart };
}

async function measureUsage(companyId, dimension, periodStart) {
  switch (dimension) {
    case "jobs":
      return Job.countDocuments({ company: companyId });
    case "recruiters":
      return User.countDocuments({ company: companyId, role: "admin" });
    case "aiInterviews":
      return InterviewSession.countDocuments({ company: companyId, "aiInterview.startedAt": { $gte: periodStart } });
    case "assessments":
      return require("../models/AssessmentSession").countDocuments({ company: companyId, startedAt: { $gte: periodStart } });
    case "resumeParsing":
      return Candidate.countDocuments({ company: companyId, createdAt: { $gte: periodStart }, resumePath: { $ne: null } });
    case "concurrentRealtime":
      // Live right now = started inside the crash-recovery window and not yet metered closed.
      // Mirrors livekitService.activeSessionCount — keep the two queries identical.
      return InterviewSession.countDocuments({
        company: companyId,
        "aiInterview.realtimeStartedAt": { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        "aiInterview.realtimeMeteredAt": null,
      });
    case "storageMb": {
      const rows = await Candidate.aggregate([
        { $match: { company: companyId } },
        { $group: { _id: null, bytes: { $sum: { $ifNull: ["$resumeSizeBytes", 0] } } } },
      ]);
      return Math.round(((rows[0]?.bytes || 0) / (1024 * 1024)) * 100) / 100;
    }
    default:
      throw new Error(`Unknown quota dimension "${dimension}"`);
  }
}

/**
 * Check one dimension. `incoming` is what the pending action would add
 * (1 for counts, MB for storage). Returns
 * { allowed, limit, used, remaining, planKey } — allowed=true with null limit
 * when the tenant has no subscription/plan.
 */
async function check(companyId, dimension, { incoming = 1 } = {}) {
  const dim = DIMENSIONS[dimension];
  if (!dim) throw new Error(`Unknown quota dimension "${dimension}"`);
  const ctx = await planContext(companyId);
  if (!ctx) return { allowed: true, limit: null, used: null, remaining: null, planKey: null };

  const limit = ctx.plan.limits?.[dim.limitKey];
  if (!Number.isFinite(limit)) return { allowed: true, limit: null, used: null, remaining: null, planKey: ctx.plan.key };

  const used = await measureUsage(companyId, dimension, ctx.periodStart);
  const remaining = Math.max(0, limit - used);
  return { allowed: used + incoming <= limit, limit, used, remaining, planKey: ctx.plan.key };
}

/**
 * Enforce: throw a machine-readable 429 (and write an AuditLog row) when the
 * pending action would exceed the plan limit.
 */
async function enforce(companyId, dimension, { incoming = 1, actor } = {}) {
  const result = await check(companyId, dimension, { incoming });
  if (result.allowed) return result;

  const dim = DIMENSIONS[dimension];
  try {
    await AuditLog.create({
      company: companyId,
      actorUserId: actor?._id,
      actorEmail: actor?.email,
      action: "quota.blocked",
      resourceType: "quota",
      resourceId: dimension,
      meta: { dimension, limit: result.limit, used: result.used, planKey: result.planKey },
    });
  } catch (err) {
    console.error("[quota] audit write failed:", err.message);
  }

  const e = new Error(
    `Plan limit reached: ${result.used}/${result.limit} ${dim.label} on the ${result.planKey} plan. Upgrade to continue.`
  );
  e.status = 429;
  e.code = "QUOTA_EXCEEDED";
  e.quota = { dimension, limit: result.limit, used: result.used, planKey: result.planKey };
  throw e;
}

/** Usage overview for the admin billing screen (approaching-limit warnings). */
async function usage(companyId) {
  const ctx = await planContext(companyId);
  if (!ctx) return { planKey: null, dimensions: [] };
  const dimensions = [];
  for (const [dimension, dim] of Object.entries(DIMENSIONS)) {
    const limit = ctx.plan.limits?.[dim.limitKey];
    if (!Number.isFinite(limit)) continue;
    const used = await measureUsage(companyId, dimension, ctx.periodStart);
    dimensions.push({
      dimension,
      label: dim.label,
      window: dim.window,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      nearLimit: limit > 0 && used / limit >= 0.8,
    });
  }
  return {
    planKey: ctx.plan.key,
    planName: ctx.plan.name,
    status: ctx.subscription.status,
    currentPeriodEnd: ctx.subscription.currentPeriodEnd,
    dimensions,
  };
}

module.exports = { check, enforce, usage, DIMENSIONS };
