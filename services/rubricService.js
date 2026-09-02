// Rubric Compiler orchestration (BUILD-PLAN Phase 3). Compiles a Job's JD into a
// versioned RoleRubric draft, lets the recruiter edit the draft, and freezes it
// on approval. The frozen object is what every candidate for the role is scored
// against — byte-identical for everyone, reproducible months later.
//
// Engine split (engineering rule 1): the LLM proposes criteria + relative
// importance; ALL arithmetic (weight normalisation, thresholds) and all flag
// validation (cite-or-drop) happen in code (utils/rubricEngine). Compilation
// failure degrades to a deterministic draft labelled engine:"fallback" — never a
// hard failure, never a fabricated rubric (rule 5).

const RoleRubric = require("../models/RoleRubric");
const CompanySettings = require("../models/CompanySettings");
const llm = require("./llmService");
const usageService = require("./usageService");
const { resolveRole } = require("../config/models");
const { RUBRIC_PROMPT_VERSION, RUBRIC_SYSTEM, RUBRIC_SCHEMA, rubricPrompt } = require("../utils/rubricPrompts");
const engine = require("../utils/rubricEngine");

const PROVIDER = "openrouter";

function engineEnabled() {
  const v = process.env.RUBRIC_ENGINE_ENABLED;
  return v !== "false" && v !== "0";
}

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

// Deterministic flags always run; model flags survive only with verified verbatim
// citations. Dedupe by code, deterministic detectors first (they carry the
// legally-vetted wording).
function mergeFlags(deterministic, modelAccepted, extra = []) {
  const seen = new Set();
  const out = [];
  for (const f of [...extra, ...deterministic, ...modelAccepted]) {
    if (seen.has(f.code)) continue;
    seen.add(f.code);
    out.push(f);
  }
  return out;
}

async function nextVersion(jobId) {
  const latest = await RoleRubric.findOne({ job: jobId }).sort({ version: -1 }).select("version");
  return (latest?.version || 0) + 1;
}

/**
 * Compile a draft rubric for `job`. Idempotent per JD content: if a DRAFT for
 * the identical sourceHash already exists it is returned instead of recompiled
 * (no duplicate spend, no version churn). `forceFallback` skips the LLM — used
 * by the backfill script so bulk runs never surprise-spend.
 */
async function compile(job, { forceFallback = false } = {}) {
  if (!engineEnabled()) {
    throw httpError(503, "Rubric engine is disabled (RUBRIC_ENGINE_ENABLED=false)", "RUBRIC_ENGINE_DISABLED");
  }

  const sourceText = engine.buildSourceText(job);
  const sourceHash = engine.sourceHashOf(job);

  const existingDraft = await RoleRubric.findOne({ job: job._id, company: job.company, sourceHash, status: "draft" });
  if (existingDraft) return existingDraft;

  let criteria = null;
  let modelFlags = [];
  let compiledBy = { engine: "fallback", model: null, promptVersion: null, at: new Date() };
  let fallbackFlags = [];

  if (!forceFallback && llm.isEnabled()) {
    try {
      const settings = await CompanySettings.findOne({ company: job.company }).select("ai");
      const resolved = resolveRole("reasoning", settings);
      const t0 = Date.now();
      const { data, usage, model, cached } = await llm.generateJSON({
        system: RUBRIC_SYSTEM,
        prompt: rubricPrompt(sourceText),
        schema: RUBRIC_SCHEMA,
        maxTokens: 2048,
        model: resolved.model,
        temperature: 0,
        promptVersion: RUBRIC_PROMPT_VERSION,
      });
      await usageService.recordUsage({
        company: job.company,
        kind: "rubric_compile",
        provider: PROVIDER,
        model,
        usage,
        latencyMs: Date.now() - t0,
        engine: "ai",
        promptVersion: RUBRIC_PROMPT_VERSION,
        cached,
      });
      const sanitised = engine.sanitiseAiCriteria(data.criteria);
      if (sanitised.length) {
        criteria = sanitised;
        const verified = engine.verifyModelFlags(data.qualityFlags, sourceText);
        modelFlags = verified.accepted;
        if (verified.dropped.length) {
          console.warn(`[rubric] dropped ${verified.dropped.length} uncited model flag(s) for job ${job._id} (cite-or-drop)`);
        }
        compiledBy = { engine: "ai", model, promptVersion: RUBRIC_PROMPT_VERSION, at: new Date() };
      } else {
        console.warn(`[rubric] AI compile returned no valid criteria for job ${job._id}; using deterministic fallback`);
      }
    } catch (err) {
      console.warn(`[rubric] AI compile failed for job ${job._id} (${err.code || err.message}); using deterministic fallback`);
    }
  }

  if (!criteria) {
    const draft = engine.deterministicDraft(job);
    criteria = draft.criteria;
    fallbackFlags = draft.qualityFlags;
  }

  const qualityFlags = mergeFlags(engine.detectQualityFlags(sourceText, { criteria }), modelFlags, fallbackFlags);

  try {
    return await RoleRubric.create({
      job: job._id,
      company: job.company,
      version: await nextVersion(job._id),
      status: "draft",
      sourceHash,
      criteria,
      thresholds: engine.defaultThresholds(job),
      compiledBy,
      qualityFlags,
    });
  } catch (err) {
    // Lost a race with a concurrent compile for the identical JD (the
    // up-front existingDraft check above can't see a request that started
    // moments after it, while the LLM call was still in flight). The DB's
    // partial unique index on (job, sourceHash, status:"draft") is what
    // actually prevents two draft rows — the loser lands here and returns the
    // winner's draft instead of erroring or leaving a duplicate behind.
    if (err?.code === 11000) {
      const winner = await RoleRubric.findOne({ job: job._id, company: job.company, sourceHash, status: "draft" });
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Apply recruiter edits to a DRAFT: criteria (relabel, retier, add, remove) and
 * thresholds.
 *
 * The client sends an importance WORD and never a weight — a client-supplied
 * `weight` is ignored outright, so there is no request shape in which a number
 * chosen outside this file can become part of a candidate's score. The tier is
 * turned into a relative multiplier here and re-normalised on every edit.
 *
 * Legacy knock-out gates (`kind: "disqualifier"`, compiled before importance
 * tiers) are carried through untouched so an in-flight draft keeps meaning what
 * it meant — they can be deleted, never created.
 */
async function updateDraft(rubricId, companyId, changes = {}) {
  const rubric = await RoleRubric.findOne({ _id: rubricId, company: companyId });
  if (!rubric) throw httpError(404, "Rubric not found");
  if (rubric.status !== "draft") {
    throw httpError(409, "Only draft rubrics can be edited — compile a new version to change an approved rubric");
  }

  if (Array.isArray(changes.criteria)) {
    const cleaned = [];
    for (const raw of changes.criteria.slice(0, engine.MAX_CRITERIA)) {
      if (!raw || typeof raw !== "object") continue;
      const label = typeof raw.label === "string" ? raw.label.trim() : "";
      const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
      if (!label || !rationale) {
        throw httpError(400, "Every criterion needs a label and a reason it exists");
      }
      const isLegacyGate = raw.kind === "disqualifier";
      if (!isLegacyGate && !engine.IMPORTANCE_KEYS.includes(raw.importance)) {
        throw httpError(400, `Every criterion needs an importance of: ${engine.IMPORTANCE_KEYS.join(", ")}`);
      }
      const base = {
        id: `c${cleaned.length + 1}`,
        label,
        rationale,
        evidenceTypes: (Array.isArray(raw.evidenceTypes) ? raw.evidenceTypes : []).filter((t) => engine.EVIDENCE_TYPES.includes(t)),
        acceptableEvidence: (Array.isArray(raw.acceptableEvidence) ? raw.acceptableEvidence : [])
          .filter((s) => typeof s === "string" && s.trim())
          .map((s) => s.trim()),
        probeHint: typeof raw.probeHint === "string" ? raw.probeHint.trim() : "",
        seniorityFloor: typeof raw.seniorityFloor === "string" ? raw.seniorityFloor.trim() : "",
      };
      cleaned.push(
        isLegacyGate
          ? { ...base, kind: "disqualifier", weight: 0 }
          : engine.applyImportance({ ...base, importance: raw.importance })
      );
    }
    rubric.criteria = engine.normaliseWeights(cleaned);
  }

  // Selectivity is normally a named preset too, so nobody has to invent a
  // cut-off. Explicit numbers stay accepted for the "custom" escape hatch.
  const preset = engine.THRESHOLD_PRESETS.find((p) => p.key === changes.thresholdPreset);
  if (preset) {
    rubric.thresholds = { advance: preset.advance, review: preset.review };
  } else if (changes.thresholds && typeof changes.thresholds === "object") {
    const advance = Math.min(100, Math.max(0, Number(changes.thresholds.advance)));
    const review = Math.min(100, Math.max(0, Number(changes.thresholds.review)));
    if (!Number.isFinite(advance) || !Number.isFinite(review)) throw httpError(400, "Thresholds must be numbers between 0 and 100");
    if (review > advance) throw httpError(400, "The review threshold cannot exceed the advance threshold");
    rubric.thresholds = { advance, review };
  }

  // Structural flags (e.g. must-have overload) can change with the edit; model
  // citations were verified at compile time and are carried forward.
  const keptModelOrCompileFlags = rubric.qualityFlags.filter((f) => !["MUST_HAVE_OVERLOAD"].includes(f.code));
  const structural = engine
    .detectQualityFlags("", { criteria: rubric.criteria })
    .filter((f) => f.code === "MUST_HAVE_OVERLOAD");
  rubric.qualityFlags = [...keptModelOrCompileFlags, ...structural];

  await rubric.save();
  return rubric;
}

/**
 * Approve & freeze a draft (the human-in-the-loop boundary: no candidate is ever
 * scored against an unapproved rubric). Archives any previously-approved version
 * of the same job — the one permitted mutation of a frozen document.
 */
async function approve(rubricId, companyId, user) {
  const rubric = await RoleRubric.findOne({ _id: rubricId, company: companyId });
  if (!rubric) throw httpError(404, "Rubric not found");
  if (rubric.status === "approved") throw httpError(409, "Rubric is already approved");
  if (rubric.status === "archived") throw httpError(409, "Archived rubrics cannot be approved — compile a new version");
  if (!rubric.criteria.length) throw httpError(400, "Cannot approve a rubric with no criteria");

  engine.normaliseWeights(rubric.criteria);
  rubric.status = "approved";
  rubric.frozenAt = new Date();
  rubric.approvedBy = { user: user._id, at: new Date() };
  await rubric.save();

  const previous = await RoleRubric.find({ job: rubric.job, company: companyId, status: "approved", _id: { $ne: rubric._id } });
  for (const old of previous) {
    old.status = "archived"; // the single change the frozen guard permits
    await old.save();
  }

  return rubric;
}

/**
 * Delete an unapproved draft. Approved/frozen/archived versions are the audit
 * artifact this whole model exists to protect — once a version could have been
 * (or was) used to score a candidate it is kept forever. Only a draft that was
 * never approved carries no candidate scores and can be removed, e.g. to clear
 * out a stale/unwanted recompile before the recruiter approves a different one.
 */
async function remove(rubricId, companyId) {
  const rubric = await RoleRubric.findOne({ _id: rubricId, company: companyId });
  if (!rubric) throw httpError(404, "Rubric not found");
  if (rubric.status !== "draft") {
    throw httpError(409, "Only a draft can be deleted — approved and archived versions are kept for the audit trail");
  }
  await RoleRubric.deleteOne({ _id: rubric._id });
  return rubric;
}

/** The rubric candidates are currently scored against: latest approved version. */
function getActiveRubric(jobId, companyId) {
  return RoleRubric.findOne({ job: jobId, company: companyId, status: "approved" }).sort({ version: -1 });
}

function listForJob(jobId, companyId) {
  return RoleRubric.find({ job: jobId, company: companyId }).sort({ version: -1 });
}

/**
 * Latest rubric status for one job — "approved" | "draft" | "archived" | "none".
 * Drives the "this job is still on the legacy engine" disclosure everywhere a
 * recruiter can see a job or a candidate scored against it (rule 5: uncertainty
 * must be visible, never rendered as a silent fallback).
 */
async function latestStatusForJob(jobId, companyId) {
  const latest = await RoleRubric.findOne({ job: jobId, company: companyId }).sort({ version: -1 }).select("status");
  return latest?.status || "none";
}

/** Batch form of latestStatusForJob, for job-list screens. */
async function latestStatusesForJobs(jobIds, companyId) {
  const rows = await RoleRubric.aggregate([
    { $match: { job: { $in: jobIds }, company: companyId } },
    { $sort: { version: -1 } },
    { $group: { _id: "$job", status: { $first: "$status" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.status]));
}

/**
 * Called after a JD edit. If this job has rubrics and the JD content actually
 * changed (sourceHash differs from the newest version), compile a fresh draft.
 * The old approved version stays active — and historical scores keep pointing at
 * it — until a human approves the new draft.
 */
async function supersede(job) {
  const latest = await RoleRubric.findOne({ job: job._id, company: job.company }).sort({ version: -1 }).select("sourceHash");
  if (!latest) return null; // job never had a rubric — nothing to supersede
  if (latest.sourceHash === engine.sourceHashOf(job)) return null;
  return compile(job);
}

module.exports = {
  engineEnabled,
  compile,
  updateDraft,
  approve,
  remove,
  getActiveRubric,
  listForJob,
  latestStatusForJob,
  latestStatusesForJobs,
  supersede,
};
