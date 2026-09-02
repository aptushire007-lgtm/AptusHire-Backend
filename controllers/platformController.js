// Platform console (BUILD-PLAN Phase 16) — superadmin-only operations surface.
// Two jobs: (1) the honest back-office (tenant directory, suspend/reactivate,
// and the FIRST read paths AuditLog / EmailLog / UsageEvent / Workspace have
// ever had), and (2) the AI trust dashboard — live per-tenant AI quality that
// makes "we measure our accuracy" a screen someone watches, not a marketing
// sentence.
//
// Guardrails: every mutation requires a typed `reason` (router middleware) and
// writes an AuditLog row; rubric/assessment immutability binds superadmins too
// (no endpoint here touches a score); no bulk cross-tenant PII export exists.

const mongoose = require("mongoose");
const tenantContext = require("../utils/tenantContext");
const Company = require("../models/Company");
const CompanySettings = require("../models/CompanySettings");
const Subscription = require("../models/Subscription");
const Workspace = require("../models/Workspace");
const AuditLog = require("../models/AuditLog");
const EmailLog = require("../models/EmailLog");
const UsageEvent = require("../models/UsageEvent");
const AtsAssessment = require("../models/AtsAssessment");
const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const User = require("../models/User");
const DemoRequest = require("../models/DemoRequest");
const { writeAuditLog } = require("../middleware/auditLog");
const { summarizeCounterfactuals } = require("../utils/analyticsEngine");
const demoInterviewService = require("../services/demoInterviewService");

// Platform queries are cross-tenant by design; run them in the system context
// so the tenantScope plugin's strict mode never misreads them as a leak.
const asSystem = (fn) => (req, res) => tenantContext.runAsSystem(() => fn(req, res));

function pagination(req, defLimit = 25, maxLimit = 100) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit, 10) || defLimit));
  return { page, limit, skip: (page - 1) * limit };
}

function dateRange(req, defaultDays = 30) {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - defaultDays * 86400000);
  return { from, to };
}

// ---------------------------------------------------------------------------
// 16.2 — Tenant directory
// ---------------------------------------------------------------------------

async function listTenants(req, res) {
  const { page, limit, skip } = pagination(req);
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.q) {
    const escaped = String(req.query.q).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.name = { $regex: escaped, $options: "i" };
  }

  const [companies, total] = await Promise.all([
    Company.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Company.countDocuments(filter),
  ]);

  const rows = await Promise.all(
    companies.map(async (c) => {
      const [subscription, jobs, candidates, workspace, settings] = await Promise.all([
        Subscription.findOne({ company: c._id }).populate("plan", "key name").select("status plan currentPeriodEnd").lean(),
        Job.countDocuments({ company: c._id }),
        Candidate.countDocuments({ company: c._id }),
        Workspace.findOne({ company: c._id }).select("workspaceId status").lean(),
        CompanySettings.findOne({ company: c._id }).select("ai.voiceMode").lean(),
      ]);
      return {
        id: c._id,
        name: c.name,
        companyCode: c.companyCode,
        status: c.status,
        createdAt: c.createdAt,
        city: c.city,
        country: c.country,
        subscription: subscription
          ? { status: subscription.status, plan: subscription.plan?.key, currentPeriodEnd: subscription.currentPeriodEnd }
          : null,
        workspace: workspace || null, // the first read path Workspace has ever had
        counts: { jobs, candidates },
        voiceMode: settings?.ai?.voiceMode || null,
      };
    })
  );

  res.json({ items: rows, total, page, limit });
}

async function getTenant(req, res) {
  const company = await Company.findById(req.params.id).lean();
  if (!company) return res.status(404).json({ error: "Tenant not found" });

  const [settings, subscription, workspace, admins, usage, recentAudit] = await Promise.all([
    CompanySettings.findOne({ company: company._id }).select("ai compliance proctoring careers publishing").lean(),
    Subscription.findOne({ company: company._id }).populate("plan", "key name limits").lean(),
    Workspace.findOne({ company: company._id }).lean(),
    User.find({ company: company._id, role: "admin" }).select("name email emailVerified createdAt").lean(),
    require("../services/quotaService")
      .usage(company._id)
      .catch(() => null),
    AuditLog.find({ company: company._id }).sort({ createdAt: -1 }).limit(10).select("action actorEmail createdAt statusCode").lean(),
  ]);

  res.json({ company, settings, subscription, workspace, admins, usage, recentAudit });
}

async function setTenantStatus(req, res, status) {
  const company = await Company.findById(req.params.id);
  if (!company) return res.status(404).json({ error: "Tenant not found" });
  const previous = company.status;
  company.status = status;
  await company.save();

  writeAuditLog({
    req,
    company: company._id,
    action: status === "suspended" ? "platform.tenant.suspend" : "platform.tenant.reactivate",
    resourceType: "Company",
    resourceId: String(company._id),
    meta: { reason: req.body.reason, previousStatus: previous },
  });

  res.json({ id: company._id, status: company.status });
}

// Suspension drives the existing Company.status machinery — requireActiveCompany
// locks the tenant's admins out on their next request; reactivation restores.
const suspendTenant = (req, res) => setTenantStatus(req, res, "suspended");
const reactivateTenant = (req, res) => setTenantStatus(req, res, "active");

// The per-tenant voice pipeline rollout lever (livekitService.isEnabled), previously
// CLI-only via scripts/setVoiceMode.js. Same semantics: an explicit "turn_based"/"livekit"
// pins the tenant to exactly one pipeline; "" (empty string from the dropdown's "Platform
// default" option) unsets it back to the VOICE_MODE env default. Mirrors the validation in
// companySettingsController.js's updateSettings so a superadmin and a recruiter can never
// write a value the model's enum would reject.
async function setTenantVoiceMode(req, res) {
  const company = await Company.findById(req.params.id);
  if (!company) return res.status(404).json({ error: "Tenant not found" });

  const mode = String(req.body.voiceMode || "").trim().toLowerCase();
  if (mode && !["turn_based", "livekit"].includes(mode)) {
    return res.status(400).json({ error: 'Voice mode must be "turn_based" or "livekit"' });
  }

  const update = mode ? { $set: { "ai.voiceMode": mode } } : { $unset: { "ai.voiceMode": "" } };
  await CompanySettings.findOneAndUpdate({ company: company._id }, update, { upsert: true });

  writeAuditLog({
    req,
    company: company._id,
    action: "platform.tenant.voiceMode",
    resourceType: "CompanySettings",
    resourceId: String(company._id),
    meta: { reason: req.body.reason, voiceMode: mode || null },
  });

  res.json({ id: company._id, voiceMode: mode || null });
}

// ---------------------------------------------------------------------------
// 16.3 — Read paths for the write-only models
// ---------------------------------------------------------------------------

async function listAuditLogs(req, res) {
  const { page, limit, skip } = pagination(req);
  const filter = {};
  if (req.query.company && mongoose.isValidObjectId(req.query.company)) filter.company = req.query.company;
  if (req.query.actorEmail) filter.actorEmail = String(req.query.actorEmail).trim().toLowerCase();
  if (req.query.action) {
    const escaped = String(req.query.action).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.action = { $regex: `^${escaped}`, $options: "i" };
  }
  const { from, to } = dateRange(req, 30);
  filter.createdAt = { $gte: from, $lte: to };

  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ items, total, page, limit });
}

// The "did the OTP actually send?" debugger — previously answerable only by
// grepping Mongo by hand. Bodies are excluded: metadata is enough to debug
// delivery, and email bodies can carry tokens/links.
async function listEmailLogs(req, res) {
  const { page, limit, skip } = pagination(req);
  const filter = {};
  if (req.query.to) filter.to = String(req.query.to).trim().toLowerCase();
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.category) filter.category = String(req.query.category);
  if (req.query.company && mongoose.isValidObjectId(req.query.company)) filter.company = req.query.company;
  const { from, to } = dateRange(req, 30);
  filter.createdAt = { $gte: from, $lte: to };

  const [items, total] = await Promise.all([
    EmailLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select("-html -text -__v").lean(),
    EmailLog.countDocuments(filter),
  ]);
  res.json({ items, total, page, limit });
}

// Usage rollups per tenant/kind — the platform-wide cost + activity view.
async function usageRollup(req, res) {
  const { from, to } = dateRange(req, 30);
  const match = { createdAt: { $gte: from, $lte: to } };
  if (req.query.company && mongoose.isValidObjectId(req.query.company)) {
    match.company = new mongoose.Types.ObjectId(req.query.company);
  }

  const byCompanyKind = await UsageEvent.aggregate([
    { $match: match },
    {
      $group: {
        _id: { company: "$company", kind: "$kind" },
        calls: { $sum: 1 },
        totalTokens: { $sum: "$totalTokens" },
        costCents: { $sum: "$costCents" },
        cached: { $sum: { $cond: ["$cached", 1, 0] } },
        fallback: { $sum: { $cond: [{ $eq: ["$engine", "fallback"] }, 1, 0] } },
      },
    },
    { $sort: { costCents: -1 } },
    { $limit: 500 },
  ]);

  const companyIds = [...new Set(byCompanyKind.map((r) => String(r._id.company)))];
  const companies = await Company.find({ _id: { $in: companyIds } }).select("name").lean();
  const nameById = Object.fromEntries(companies.map((c) => [String(c._id), c.name]));

  res.json({
    from,
    to,
    rows: byCompanyKind.map((r) => ({
      company: r._id.company,
      companyName: nameById[String(r._id.company)] || "(unknown)",
      kind: r._id.kind,
      calls: r.calls,
      totalTokens: r.totalTokens,
      costCents: Math.round(r.costCents * 100) / 100,
      cached: r.cached,
      fallback: r.fallback,
    })),
  });
}

// Platform read path for demo-request leads (written by the public Phase 13 form).
async function listDemoRequests(req, res) {
  const { page, limit, skip } = pagination(req);
  const [items, total] = await Promise.all([
    DemoRequest.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    DemoRequest.countDocuments({}),
  ]);
  res.json({ items, total, page, limit });
}

// ---------------------------------------------------------------------------
// 16.4 — AI trust dashboard
// ---------------------------------------------------------------------------

async function trustDashboard(req, res) {
  const { from, to } = dateRange(req, 30);
  const range = { $gte: from, $lte: to };

  const llm = require("../services/llmService");

  const assessments = await AtsAssessment.find({ createdAt: range })
    .select("company qa mode band decision")
    .lean();

  const gate = { passed: 0, routed_review: 0, hard_failed: 0 };
  let agreementSum = 0;
  let agreementN = 0;
  const byCompany = new Map();
  for (const a of assessments) {
    if (gate[a.qa?.outcome] !== undefined) gate[a.qa.outcome] += 1;
    if (typeof a.qa?.agreement === "number") {
      agreementSum += a.qa.agreement;
      agreementN += 1;
    }
    const key = String(a.company);
    const row = byCompany.get(key) || { assessments: 0, review: 0 };
    row.assessments += 1;
    if (a.band === "review" || a.qa?.outcome === "routed_review") row.review += 1;
    byCompany.set(key, row);
  }

  // Engine mix on live candidates: how often the labelled fallback carried a
  // decision (uncertainty must be VISIBLE — this is where we watch it).
  const engineMix = await Candidate.aggregate([
    { $match: { createdAt: range, "ats.engine": { $exists: true } } },
    { $group: { _id: "$ats.engine", n: { $sum: 1 } } },
  ]);

  const spendByKind = await UsageEvent.aggregate([
    { $match: { createdAt: range } },
    {
      $group: {
        _id: "$kind",
        calls: { $sum: 1 },
        costCents: { $sum: "$costCents" },
        fallback: { $sum: { $cond: [{ $eq: ["$engine", "fallback"] }, 1, 0] } },
      },
    },
    { $sort: { costCents: -1 } },
  ]);

  const companyIds = [...byCompany.keys()];
  const companies = await Company.find({ _id: { $in: companyIds } }).select("name").lean();
  const nameById = Object.fromEntries(companies.map((c) => [String(c._id), c.name]));

  res.json({
    from,
    to,
    breaker: llm.breakerState(), // Phase 2 circuit-breaker state, live
    assessments: {
      total: assessments.length,
      gate,
      reviewRate: assessments.length ? Math.round((gate.routed_review / assessments.length) * 1000) / 1000 : null,
      meanEnsembleAgreement: agreementN ? Math.round((agreementSum / agreementN) * 1000) / 1000 : null,
      counterfactuals: summarizeCounterfactuals(assessments),
    },
    engineMix: Object.fromEntries(engineMix.map((r) => [r._id, r.n])),
    spendByKind: spendByKind.map((r) => ({
      kind: r._id,
      calls: r.calls,
      costCents: Math.round(r.costCents * 100) / 100,
      fallback: r.fallback,
    })),
    tenants: [...byCompany.entries()]
      .map(([id, row]) => ({
        company: id,
        companyName: nameById[id] || "(unknown)",
        assessments: row.assessments,
        reviewRate: row.assessments ? Math.round((row.review / row.assessments) * 1000) / 1000 : null,
      }))
      .sort((a, b) => b.assessments - a.assessments)
      .slice(0, 50),
  });
}

// ---------------------------------------------------------------------------
// 16.5 — Demo interview links (a working /interview/:token to hand a prospect
// or tester, without routing them through a real tenant's apply/ATS pipeline).
// ---------------------------------------------------------------------------

async function listDemoInterviews(req, res) {
  const { page, limit } = pagination(req);
  const data = await demoInterviewService.listDemoInterviewLinks({ page, limit });
  res.json(data);
}

async function createDemoInterview(req, res) {
  const { reason, jobTitle, jobDescription, expiresInDays, linkBase } = req.body;
  const result = await demoInterviewService.createDemoInterviewLink({
    label: reason,
    jobTitle,
    jobDescription,
    expiresInDays,
    linkBase,
  });

  writeAuditLog({
    req,
    action: "platform.demoInterview.create",
    resourceType: "InterviewSession",
    resourceId: result.sessionId,
    meta: { reason, jobTitle: result.jobTitle, candidateId: result.candidateId },
  });

  res.json(result);
}

async function reissueDemoInterview(req, res) {
  const result = await demoInterviewService.reissueDemoInterviewLink(req.params.id, { linkBase: req.body.linkBase });
  if (!result) return res.status(404).json({ error: "Demo interview not found" });

  writeAuditLog({
    req,
    action: "platform.demoInterview.reissue",
    resourceType: "InterviewSession",
    resourceId: result.sessionId,
    meta: { reason: req.body.reason },
  });

  res.json(result);
}

async function revokeDemoInterview(req, res) {
  const result = await demoInterviewService.revokeDemoInterviewLink(req.params.id);
  if (!result) return res.status(404).json({ error: "Demo interview not found" });

  writeAuditLog({
    req,
    action: "platform.demoInterview.revoke",
    resourceType: "InterviewSession",
    resourceId: result.sessionId,
    meta: { reason: req.body.reason },
  });

  res.json(result);
}

module.exports = {
  listTenants: asSystem(listTenants),
  getTenant: asSystem(getTenant),
  suspendTenant: asSystem(suspendTenant),
  reactivateTenant: asSystem(reactivateTenant),
  setTenantVoiceMode: asSystem(setTenantVoiceMode),
  listAuditLogs: asSystem(listAuditLogs),
  listEmailLogs: asSystem(listEmailLogs),
  usageRollup: asSystem(usageRollup),
  listDemoRequests: asSystem(listDemoRequests),
  trustDashboard: asSystem(trustDashboard),
  listDemoInterviews: asSystem(listDemoInterviews),
  createDemoInterview: asSystem(createDemoInterview),
  reissueDemoInterview: asSystem(reissueDemoInterview),
  revokeDemoInterview: asSystem(revokeDemoInterview),
};
