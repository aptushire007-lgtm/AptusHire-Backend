// Model registry (BUILD-PLAN Phase 2.5). Every LLM call site resolves its model
// through a named ROLE here — a bare model string must never float in business
// logic. Why: a silent vendor upgrade (or a hurried hotfix that swaps a model id
// inline) must not be able to change hiring outcomes without an explicit version
// bump here and a re-baselined eval run (`npm run test:eval`).
//
// Each role pins an explicit model id AND the prompt version of the template
// family that role runs, so an artifact stamped {role, model, promptVersion} is
// reproducible months later in a legal context.
//
// Resolution order for the model id:
//   1. per-tenant per-role override   — CompanySettings.ai.models[role]
//   2. per-tenant legacy override     — CompanySettings.ai.model (interview role
//      only; that is the field's documented historical meaning)
//   3. environment override           — AI_INTERVIEW_MODEL / LLM_MODEL_<ROLE>
//   4. the pinned default below

const { PROMPT_VERSION: INTERVIEW_PROMPT_VERSION } = require("../utils/interviewPrompts");

// Read env at call time so tests and ops config changes apply without restart.
function roles() {
  return {
    // The live AI interviewer (plan / question / evaluation turns).
    interview: {
      model: process.env.AI_INTERVIEW_MODEL || "openai/gpt-4o-mini",
      promptVersion: INTERVIEW_PROMPT_VERSION,
    },
    // Structured extraction over documents (Phase 4 ClaimGraph, Phase 3 rubric
    // parsing). Cheap, schema-strict, temperature 0.
    extraction: {
      model: process.env.LLM_MODEL_EXTRACTION || "openai/gpt-4o-mini",
      promptVersion: null, // set by the phase that first ships an extraction prompt
    },
    // Multi-step reasoning over extracted evidence (Phase 5 matching, Phase 3
    // JD-quality analysis). No live call site yet; pinned ahead of Phase 3.
    reasoning: {
      model: process.env.LLM_MODEL_REASONING || "openai/gpt-4o",
      promptVersion: null,
    },
    // High-volume low-stakes calls (dedup hints, title normalisation).
    cheap: {
      model: process.env.LLM_MODEL_CHEAP || "openai/gpt-4o-mini",
      promptVersion: null,
    },
  };
}

/**
 * Resolve the model id + prompt version for a named role, applying per-tenant
 * overrides from CompanySettings. Throws on an unknown role — a typo'd role
 * must fail loudly, not silently fall back to some default model.
 */
function resolveRole(role, companySettings) {
  const entry = roles()[role];
  if (!entry) throw new Error(`Unknown LLM role "${role}" — add it to config/models.js`);
  const ai = companySettings?.ai || {};
  const tenantModel = ai.models?.[role] || (role === "interview" ? ai.model : undefined);
  return {
    role,
    model: (tenantModel || "").trim() || entry.model,
    promptVersion: entry.promptVersion,
  };
}

module.exports = { resolveRole, roles };
