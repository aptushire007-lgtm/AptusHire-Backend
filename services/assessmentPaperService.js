// AssessmentPaper orchestration (ASSESSMENT-ENGINE-PLAN A1.2). Compiles a frozen
// RoleRubric into a versioned AssessmentPaper draft, lets the recruiter edit the
// draft structure, and freezes it on approval — the same lifecycle discipline as
// rubricService, deliberately.
//
// Honest-degradation rule (§3.5): there is NO deterministic fallback that
// invents test questions. No approved rubric ⇒ actionable error. No LLM key ⇒
// actionable error. Never a fabricated or template paper.

const AssessmentPaper = require("../models/AssessmentPaper");
const CompanySettings = require("../models/CompanySettings");
const rubricService = require("./rubricService");
const itemGenService = require("./itemGenService");
const llm = require("./llmService");
const usageService = require("./usageService");
const { resolveRole } = require("../config/models");
const {
  BLUEPRINT_PROMPT_VERSION,
  BLUEPRINT_SYSTEM,
  BLUEPRINT_SCHEMA,
  blueprintPrompt,
} = require("../utils/assessmentPrompts");

const PROVIDER = "openrouter";

function engineEnabled() {
  const v = process.env.ASSESSMENT_ENGINE_ENABLED;
  return v !== "false" && v !== "0";
}

// Gate 2 of 4: per-tenant. Unset ⇒ enabled (the job policy default-off is the
// real behavioural gate); explicit false wins.
function tenantEnabled(settings) {
  return settings?.assessments?.enabled !== false;
}

async function assertEnabled(companyId) {
  if (!engineEnabled()) {
    throw httpError(503, "The assessment engine is disabled (ASSESSMENT_ENGINE_ENABLED=false)", "ASSESSMENT_ENGINE_DISABLED");
  }
  const settings = await CompanySettings.findOne({ company: companyId }).select("assessments ai");
  if (!tenantEnabled(settings)) {
    throw httpError(403, "Assessments are disabled for this workspace in Company Settings", "ASSESSMENTS_DISABLED_FOR_TENANT");
  }
  return settings;
}

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

async function nextVersion(jobId) {
  const latest = await AssessmentPaper.findOne({ job: jobId }).sort({ version: -1 }).select("version");
  return (latest?.version || 0) + 1;
}

// --- Deterministic blueprint normalisation (all arithmetic in code) ----------

const MIN_SECTIONS = 1;
const MAX_SECTIONS = 5;
const MIN_SERVED = 2;
const MAX_SERVED = 8;
const SEC_PER_ITEM_MIN = 45;
const SEC_PER_ITEM_MAX = 120;
const POOL_MULTIPLIER = 2; // a section's bank is at most 2× what one candidate sees

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));
}

/**
 * A section's item bank is deliberately larger than the number one candidate
 * answers: the surplus is what makes every candidate's draw different (a leaked
 * paper is worth less) and the buffer that absorbs items the blind-solve gate
 * flags. But the pool must stay TIED to the served count, in BOTH directions —
 * this is one function precisely so compile and edit cannot disagree.
 *
 * Left untied (as it was), an edit to servedItemCount silently broke one of two
 * things: lowering it burned generation budget on a pool sized for the old,
 * bigger test; raising it could leave poolItemCount BELOW servedItemCount, so the
 * section was unapprovable ("has 4 approved item(s) but serves 8") with no way to
 * fix it from the editor, because poolItemCount has no control.
 */
function normalisePool(rawPool, servedItemCount) {
  return clamp(rawPool, servedItemCount, servedItemCount * POOL_MULTIPLIER);
}

/**
 * The model proposes; code disposes. Enforces: only real criterion ids, every
 * scoreable must_have covered exactly once (uncovered ones get a catch-all
 * section), counts/times clamped, difficultyMix re-balanced to sum to
 * servedItemCount.
 */
function normaliseBlueprint(rawSections, rubric) {
  const scoreable = rubric.criteria.filter((c) => c.kind !== "disqualifier");
  const validIds = new Set(scoreable.map((c) => c.id));
  const assigned = new Set();

  const sections = [];
  for (const raw of (rawSections || []).slice(0, MAX_SECTIONS)) {
    const criterionIds = (Array.isArray(raw.criterionIds) ? raw.criterionIds : [])
      .filter((id) => validIds.has(id) && !assigned.has(id));
    if (!criterionIds.length) continue;
    criterionIds.forEach((id) => assigned.add(id));

    const servedItemCount = clamp(raw.servedItemCount, MIN_SERVED, MAX_SERVED);
    const poolItemCount = normalisePool(raw.poolItemCount, servedItemCount);
    sections.push({
      id: `s${sections.length + 1}`,
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 80) : `Section ${sections.length + 1}`,
      criterionIds,
      servedItemCount,
      poolItemCount,
      difficultyMix: normaliseMix(raw.difficultyMix, servedItemCount),
      timeLimitSec: clamp(raw.timeLimitSec, servedItemCount * SEC_PER_ITEM_MIN, servedItemCount * SEC_PER_ITEM_MAX),
    });
  }

  // Guaranteed must-have coverage: anything the model missed lands in a
  // catch-all section rather than silently untested.
  const missedMustHaves = scoreable.filter((c) => c.kind === "must_have" && !assigned.has(c.id));
  if (missedMustHaves.length) {
    const served = clamp(missedMustHaves.length * 2, MIN_SERVED, MAX_SERVED);
    sections.push({
      id: `s${sections.length + 1}`,
      title: "Core requirements",
      criterionIds: missedMustHaves.map((c) => c.id),
      servedItemCount: served,
      poolItemCount: normalisePool(served * 1.5, served),
      difficultyMix: normaliseMix(null, served),
      timeLimitSec: served * 75,
    });
  }

  if (sections.length < MIN_SECTIONS) {
    throw httpError(422, "Blueprint compilation produced no usable sections — review the rubric's criteria and recompile", "BLUEPRINT_EMPTY");
  }
  return sections;
}

// difficultyMix must sum to servedItemCount; when the proposal doesn't, rebalance
// proportionally with a sensible default shape (25/50/25).
function normaliseMix(raw, servedItemCount) {
  let easy = Math.max(0, Math.round(Number(raw?.easy) || 0));
  let medium = Math.max(0, Math.round(Number(raw?.medium) || 0));
  let hard = Math.max(0, Math.round(Number(raw?.hard) || 0));
  if (easy + medium + hard !== servedItemCount) {
    easy = Math.round(servedItemCount * 0.25);
    hard = Math.round(servedItemCount * 0.25);
    medium = servedItemCount - easy - hard;
  }
  return { easy, medium, hard };
}

// --- Compile -----------------------------------------------------------------

/**
 * Compile a draft paper for `job` from its ACTIVE (approved, frozen) rubric.
 * Idempotent per rubric version: an existing draft for the same rubric version
 * is returned instead of recompiled (no duplicate spend, no version churn).
 */
async function compileBlueprint(job) {
  const settings = await assertEnabled(job.company);

  const rubric = await rubricService.getActiveRubric(job._id, job.company);
  if (!rubric) {
    throw httpError(
      409,
      "This job has no approved rubric yet. Approve a Scoring Rubric first — the assessment is compiled from it, criterion by criterion.",
      "NO_APPROVED_RUBRIC"
    );
  }

  const existingDraft = await AssessmentPaper.findOne({
    job: job._id,
    company: job.company,
    rubric: rubric._id,
    rubricVersion: rubric.version,
    status: "draft",
  });
  if (existingDraft) return existingDraft;

  if (!llm.isEnabled()) {
    // §3.5 — no fabricated paper, ever. The feature is unavailable and says so.
    throw httpError(
      503,
      "Assessment generation needs the AI engine (no LLM key is configured). There is deliberately no template fallback — a test paper is only ever generated from your rubric.",
      "ASSESSMENT_LLM_UNAVAILABLE"
    );
  }
  if (await usageService.isOverBudget(job.company, settings?.ai)) {
    throw httpError(429, "This workspace's monthly AI budget is exhausted — raise the budget cap to compile assessment papers", "AI_BUDGET_EXHAUSTED");
  }

  const scoreable = rubric.criteria.filter((c) => c.kind !== "disqualifier");
  if (!scoreable.length) {
    throw httpError(422, "The approved rubric has no scoreable criteria to build an assessment from", "RUBRIC_NOT_ASSESSABLE");
  }

  const resolved = resolveRole("reasoning", settings);
  const t0 = Date.now();
  const { data, usage, model, cached } = await llm.generateJSON({
    system: BLUEPRINT_SYSTEM,
    prompt: blueprintPrompt(scoreable),
    schema: BLUEPRINT_SCHEMA,
    maxTokens: 1536,
    model: resolved.model,
    temperature: 0,
    promptVersion: BLUEPRINT_PROMPT_VERSION,
  });
  await usageService.recordUsage({
    company: job.company,
    kind: "assessment_blueprint",
    provider: PROVIDER,
    model,
    usage,
    latencyMs: Date.now() - t0,
    engine: "ai",
    promptVersion: BLUEPRINT_PROMPT_VERSION,
    cached,
  });

  const sections = normaliseBlueprint(data.sections, rubric);

  return AssessmentPaper.create({
    job: job._id,
    company: job.company,
    rubric: rubric._id,
    rubricVersion: rubric.version,
    version: await nextVersion(job._id),
    status: "draft",
    sections,
    items: [],
    timing: { mode: "per_section" },
    compiledBy: { engine: "ai", model, promptVersion: BLUEPRINT_PROMPT_VERSION, at: new Date() },
  });
}

// --- Draft editing -----------------------------------------------------------

/**
 * Recruiter edits to a DRAFT: section counts/times/titles, difficulty policy,
 * instructions, integrity defaults. Items are edited only through itemGenService
 * (regeneration), never free-typed — a hand-typed item has no blind-solve
 * provenance.
 */
async function updateDraft(paperId, companyId, changes = {}) {
  const paper = await AssessmentPaper.findOne({ _id: paperId, company: companyId });
  if (!paper) throw httpError(404, "Assessment paper not found");
  if (paper.status !== "draft") {
    throw httpError(409, "Only draft papers can be edited — generate a new version to change an approved paper");
  }

  if (Array.isArray(changes.sections)) {
    const byId = new Map(changes.sections.filter((s) => s && s.id).map((s) => [s.id, s]));
    for (const section of paper.sections) {
      const edit = byId.get(section.id);
      if (!edit) continue;
      if (typeof edit.title === "string" && edit.title.trim()) section.title = edit.title.trim().slice(0, 80);
      if (edit.servedItemCount !== undefined) {
        section.servedItemCount = clamp(edit.servedItemCount, MIN_SERVED, MAX_SERVED);
        section.difficultyMix = normaliseMix(edit.difficultyMix || section.difficultyMix, section.servedItemCount);
        // Resize the bank with the test — see normalisePool for why leaving this
        // behind breaks the section in both directions.
        section.poolItemCount = normalisePool(section.poolItemCount, section.servedItemCount);
      } else if (edit.difficultyMix) {
        section.difficultyMix = normaliseMix(edit.difficultyMix, section.servedItemCount);
      }
      if (edit.timeLimitSec !== undefined) {
        section.timeLimitSec = clamp(edit.timeLimitSec, section.servedItemCount * SEC_PER_ITEM_MIN, section.servedItemCount * SEC_PER_ITEM_MAX);
      }
    }
    paper.markModified("sections");
  }

  if (changes.difficultyPolicy && typeof changes.difficultyPolicy === "object") {
    const mode = changes.difficultyPolicy.mode;
    if (!["fixed", "claim_tiered"].includes(mode)) throw httpError(400, "difficultyPolicy.mode must be fixed or claim_tiered");
    const fixedTier = changes.difficultyPolicy.fixedTier || paper.difficultyPolicy.fixedTier || "medium";
    if (!AssessmentPaper.DIFFICULTIES.includes(fixedTier)) throw httpError(400, "Invalid fixedTier");
    paper.difficultyPolicy = { mode, fixedTier };
  }

  if (typeof changes.instructions === "string") paper.instructions = changes.instructions.trim().slice(0, 5000);

  if (changes.integrityDefaults && typeof changes.integrityDefaults === "object") {
    const d = changes.integrityDefaults;
    if (typeof d.proctoring === "boolean") paper.integrityDefaults.proctoring = d.proctoring;
    if (d.softLock && typeof d.softLock === "object") {
      if (typeof d.softLock.enabled === "boolean") paper.integrityDefaults.softLock.enabled = d.softLock.enabled;
      if (d.softLock.flagThreshold !== undefined) {
        paper.integrityDefaults.softLock.flagThreshold = clamp(d.softLock.flagThreshold, 1, 20);
      }
      if (d.softLock.action === "pause" || d.softLock.action === "auto_submit") {
        paper.integrityDefaults.softLock.action = d.softLock.action;
      }
    }
  }

  await paper.save();
  return paper;
}

// --- Approve & freeze --------------------------------------------------------

async function approve(paperId, companyId, user) {
  const paper = await AssessmentPaper.findOne({ _id: paperId, company: companyId });
  if (!paper) throw httpError(404, "Assessment paper not found");
  if (paper.status === "approved") throw httpError(409, "Paper is already approved");
  if (paper.status === "archived") throw httpError(409, "Archived papers cannot be approved — generate a new version");
  // Only a LIVE run blocks approval. A run whose process died must not hold the
  // paper hostage — the pool it left behind is still valid, and the section
  // coverage check below is the real gate on whether it is enough to approve.
  if (itemGenService.isRunActive(paper.generationRun)) {
    throw httpError(409, "Item generation is still running — approve once it finishes");
  }

  // Every section must actually be servable from its ACTIVE pool. Flagged items
  // don't count — an item the blind solvers disagreed on is not test-ready.
  for (const section of paper.sections) {
    const active = paper.items.filter((i) => i.sectionId === section.id && i.status === "active").length;
    if (active < section.servedItemCount) {
      throw httpError(
        409,
        `Section "${section.title}" has ${active} approved item(s) but serves ${section.servedItemCount}. Generate or fix flagged items first.`
      );
    }
  }

  paper.status = "approved";
  paper.frozenAt = new Date();
  paper.approvedBy = { user: user._id, at: new Date() };
  await paper.save();

  const previous = await AssessmentPaper.find({ job: paper.job, company: companyId, status: "approved", _id: { $ne: paper._id } });
  for (const old of previous) {
    old.status = "archived"; // the single top-level change the frozen guard permits
    await old.save();
  }

  return paper;
}

/** The paper candidates are currently assessed against: latest approved version. */
function getActivePaper(jobId, companyId) {
  return AssessmentPaper.findOne({ job: jobId, company: companyId, status: "approved" }).sort({ version: -1 });
}

function listForJob(jobId, companyId) {
  return AssessmentPaper.find({ job: jobId, company: companyId }).sort({ version: -1 });
}

async function latestStatusForJob(jobId, companyId) {
  const latest = await AssessmentPaper.findOne({ job: jobId, company: companyId }).sort({ version: -1 }).select("status");
  return latest?.status || "none";
}

module.exports = {
  engineEnabled,
  tenantEnabled,
  assertEnabled,
  normalisePool,
  POOL_MULTIPLIER,
  compileBlueprint,
  updateDraft,
  approve,
  getActivePaper,
  listForJob,
  latestStatusForJob,
};
