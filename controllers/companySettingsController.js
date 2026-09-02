const CompanySettings = require("../models/CompanySettings");

// Per-tenant settings a company admin can self-serve (AI interview config, DPDP/compliance
// controls, DPO contact, branding, notification + email prefs). Everything here is scoped to
// req.user.company; the tenantScope plugin also auto-injects the tenant on every query, so a
// missing/forged company can't read or edit another tenant's settings.

// --- validation helpers (controllers may throw freely; server.js turns it into 400 { error }) ---
function asBool(v) {
  return v === true || v === "true";
}

function asString(v, { max = 200, field }) {
  if (v == null) return "";
  if (typeof v !== "string") throw new Error(`${field} must be text`);
  const s = v.trim();
  if (s.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  return s;
}

function asInt(v, { min, max, field }) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${field} must be a whole number`);
  if (min != null && n < min) throw new Error(`${field} must be at least ${min}`);
  if (max != null && n > max) throw new Error(`${field} must be at most ${max}`);
  return n;
}

function asNum(v, { min, max, field }) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a number`);
  if (min != null && n < min) throw new Error(`${field} must be at least ${min}`);
  if (max != null && n > max) throw new Error(`${field} must be at most ${max}`);
  return n;
}

function asEmail(v, { field }) {
  const s = asString(v, { max: 254, field });
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error(`${field} must be a valid email`);
  return s;
}

function asHexColor(v, { field }) {
  const s = asString(v, { max: 9, field });
  if (s && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) throw new Error(`${field} must be a hex color like #1a2a44`);
  return s;
}

// The projection returned to the client — only the tenant-editable groups, never internal fields.
const EDITABLE = "ai compliance branding emailTemplatePreferences notificationPreferences dashboardPreferences";

// Ensure a settings doc always exists (older companies may predate provisioning). Upsert with
// schema defaults so the admin form is never blank.
async function ensureSettings(companyId) {
  return CompanySettings.findOneAndUpdate(
    { company: companyId },
    { $setOnInsert: { company: companyId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).select(EDITABLE);
}

async function getSettings(req, res) {
  const settings = await ensureSettings(req.user.company);
  res.json(settings);
}

// Partial update: only the groups/fields present in the body are applied (PATCH semantics),
// each validated + whitelisted so a client can't set arbitrary paths. Set via doc.set(path,…)
// so Mongoose reliably tracks the nested change.
async function updateSettings(req, res) {
  const settings = await ensureSettings(req.user.company);
  const body = req.body || {};
  const changed = [];

  function set(path, value) {
    settings.set(path, value);
    changed.push(path);
  }

  if (body.ai && typeof body.ai === "object") {
    const ai = body.ai;
    if ("model" in ai) set("ai.model", asString(ai.model, { max: 100, field: "AI model" }));
    if ("monthlyBudgetCents" in ai)
      set("ai.monthlyBudgetCents", asInt(ai.monthlyBudgetCents, { min: 0, max: 100000000, field: "Monthly budget" }));
    if ("hardCap" in ai) set("ai.hardCap", asBool(ai.hardCap));
    if ("temperature" in ai) set("ai.temperature", asNum(ai.temperature, { min: 0, max: 2, field: "Temperature" }));
    if ("atsEngine" in ai) {
      const mode = asString(ai.atsEngine, { max: 10, field: "ATS engine" }).toLowerCase();
      if (mode && !["legacy", "shadow", "live"].includes(mode)) {
        throw new Error('ATS engine must be "legacy", "shadow" or "live"');
      }
      // Empty string ⇒ unset ⇒ the ATS_ENGINE env default applies (evidenceAtsService.resolveEngineMode).
      set("ai.atsEngine", mode || undefined);
    }
    if ("voiceMode" in ai) {
      // The per-tenant pipeline switch (livekitService.isEnabled). An explicit value pins the
      // tenant to exactly one pipeline; empty string ⇒ unset ⇒ the VOICE_MODE env default
      // applies. This is THE designed rollout lever — one tenant at a time, no deploy.
      const mode = asString(ai.voiceMode, { max: 12, field: "Voice mode" }).toLowerCase();
      if (mode && !["turn_based", "livekit"].includes(mode)) {
        throw new Error('Voice mode must be "turn_based" or "livekit"');
      }
      set("ai.voiceMode", mode || undefined);
    }
  }

  if (body.compliance && typeof body.compliance === "object") {
    const c = body.compliance;
    if ("aiConsentRequired" in c) set("compliance.aiConsentRequired", asBool(c.aiConsentRequired));
    if ("autoRejectAllowed" in c) set("compliance.autoRejectAllowed", asBool(c.autoRejectAllowed));
    if ("retentionDays" in c)
      set("compliance.retentionDays", asInt(c.retentionDays, { min: 1, max: 3650, field: "Retention days" }));
    if (c.dpo && typeof c.dpo === "object") {
      if ("name" in c.dpo) set("compliance.dpo.name", asString(c.dpo.name, { max: 120, field: "DPO name" }));
      if ("email" in c.dpo) set("compliance.dpo.email", asEmail(c.dpo.email, { field: "DPO email" }));
      if ("phone" in c.dpo) set("compliance.dpo.phone", asString(c.dpo.phone, { max: 40, field: "DPO phone" }));
    }
  }

  if (body.branding && typeof body.branding === "object") {
    const b = body.branding;
    if ("useCustomBranding" in b) set("branding.useCustomBranding", asBool(b.useCustomBranding));
    if ("primaryColor" in b) set("branding.primaryColor", asHexColor(b.primaryColor, { field: "Primary color" }));
  }

  if (body.emailTemplatePreferences && typeof body.emailTemplatePreferences === "object") {
    const e = body.emailTemplatePreferences;
    if ("useDefaultTemplates" in e) set("emailTemplatePreferences.useDefaultTemplates", asBool(e.useDefaultTemplates));
    if ("replyToEmail" in e) set("emailTemplatePreferences.replyToEmail", asEmail(e.replyToEmail, { field: "Reply-to email" }));
  }

  if (body.notificationPreferences && typeof body.notificationPreferences === "object") {
    const n = body.notificationPreferences;
    if ("emailOnNewApplication" in n) set("notificationPreferences.emailOnNewApplication", asBool(n.emailOnNewApplication));
    if ("emailOnAtsResult" in n) set("notificationPreferences.emailOnAtsResult", asBool(n.emailOnAtsResult));
    if ("emailOnInterviewCompleted" in n)
      set("notificationPreferences.emailOnInterviewCompleted", asBool(n.emailOnInterviewCompleted));
  }

  if (body.dashboardPreferences && typeof body.dashboardPreferences === "object") {
    const d = body.dashboardPreferences;
    if ("defaultView" in d) set("dashboardPreferences.defaultView", asString(d.defaultView, { max: 40, field: "Default view" }));
  }

  if (changed.length === 0) {
    return res.status(400).json({ error: "No recognized settings fields to update" });
  }

  await settings.save();

  // Enrich the audit trail — compliance/retention/DPO changes are security-relevant. The global
  // auditLog middleware records the mutation; this names it and captures which fields changed.
  req.audit = {
    action: "company_settings.update",
    resourceType: "CompanySettings",
    resourceId: settings._id,
    meta: { fields: changed },
  };

  res.json(await CompanySettings.findById(settings._id).select(EDITABLE));
}

// ---------------------------------------------------------------------------
// Phase 15 — distribution: careers URLs + tenant board credentials
// ---------------------------------------------------------------------------

// GET /api/company-settings/careers-info — the tenant's public URLs (careers
// page, aggregator feed, sitemap), minting the slug lazily on first ask.
async function getCareersInfo(req, res) {
  const Company = require("../models/Company");
  const careersService = require("../services/careersService");
  const company = await Company.findById(req.user.company);
  if (!company) return res.status(404).json({ error: "Company not found" });
  const slug = await careersService.ensureCompanySlug(company);
  const base = require("../utils/corsOrigins").publicBaseUrl();
  res.json({
    slug,
    careersUrl: `${base}/careers/${slug}`,
    feedUrl: `${base}/feeds/${slug}/jobs.xml`,
    sitemapUrl: `${base}/feeds/${slug}/sitemap.xml`,
  });
}

// GET /api/company-settings/board-credentials — configured/not per board.
// NEVER returns secret material (boardCredentialService.status only).
async function listBoardCredentials(req, res) {
  const { listDrivers } = require("../services/connectors");
  const boardCredentialService = require("../services/boardCredentialService");
  const out = [];
  for (const d of listDrivers()) {
    if (!d.needsCredential) continue;
    out.push({ ...d, ...(await boardCredentialService.status(req.user.company, d.key)) });
  }
  res.json({ boards: out });
}

// PUT /api/company-settings/board-credentials/:board  body: { secrets: {...} }
// Write-only: the response confirms configuration, never echoes the secrets.
async function saveBoardCredential(req, res) {
  const { getDriver } = require("../services/connectors");
  const boardCredentialService = require("../services/boardCredentialService");
  const driver = getDriver(req.params.board);
  if (!driver || !driver.needsCredential) return res.status(404).json({ error: "Unknown board" });

  const secrets = req.body?.secrets;
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets) || Object.keys(secrets).length === 0) {
    return res.status(400).json({ error: "secrets object is required" });
  }
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v !== "string" || v.length > 500 || k.length > 60) {
      return res.status(400).json({ error: "secrets must be short text values" });
    }
  }

  await boardCredentialService.saveCredential(req.user.company, driver.key, secrets);
  req.audit = {
    action: "board_credential.save",
    resourceType: "BoardCredential",
    resourceId: driver.key,
    meta: { board: driver.key, fields: Object.keys(secrets) }, // field NAMES only, never values
  };
  res.json(await boardCredentialService.status(req.user.company, driver.key));
}

// DELETE /api/company-settings/board-credentials/:board — disconnect wipes the
// stored secrets entirely.
async function deleteBoardCredential(req, res) {
  const boardCredentialService = require("../services/boardCredentialService");
  const deleted = await boardCredentialService.deleteCredential(req.user.company, req.params.board);
  req.audit = { action: "board_credential.delete", resourceType: "BoardCredential", resourceId: req.params.board };
  res.json({ deleted: deleted > 0 });
}

// POST /api/company-settings/board-credentials/:board/test — round-trips the
// stored credentials against the board's account endpoint.
async function testBoardCredential(req, res) {
  const { getDriver } = require("../services/connectors");
  const boardCredentialService = require("../services/boardCredentialService");
  const driver = getDriver(req.params.board);
  if (!driver || typeof driver.testConnection !== "function") {
    return res.status(404).json({ error: "This board does not support connection tests" });
  }
  const secrets = await boardCredentialService.loadSecrets(req.user.company, driver.key);
  if (!secrets) return res.status(400).json({ error: "No credentials configured for this board" });
  try {
    await driver.testConnection(secrets);
    await boardCredentialService.recordTest(req.user.company, driver.key, true);
    res.json({ ok: true });
  } catch (err) {
    await boardCredentialService.recordTest(req.user.company, driver.key, false);
    res.status(502).json({ ok: false, error: boardCredentialService.maskError(err.message, secrets) });
  }
}

module.exports = {
  getSettings,
  updateSettings,
  getCareersInfo,
  listBoardCredentials,
  saveBoardCredential,
  deleteBoardCredential,
  testBoardCredential,
};
