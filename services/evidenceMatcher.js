// Evidence matcher (BUILD-PLAN Phase 6.1) — the ONE narrow LLM judgement in
// the scoring path: per criterion, does this evidence satisfy it, resting on
// which claims. All arithmetic lives in utils/evidenceScorer (pure JS).
//
// Code-side sanitisation (cite-or-abstain, engineering rule 2):
//   - findings for unknown criteria are dropped;
//   - supportingClaimIds are filtered to claims that exist;
//   - any non-absent verdict left with zero valid claims degrades to absent;
//   - exactly one finding per criterion (first wins), missing → absent.

const CompanySettings = require("../models/CompanySettings");
const llm = require("./llmService");
const usageService = require("./usageService");
const { resolveRole } = require("../config/models");
const { MATCH_PROMPT_VERSION, MATCH_SYSTEM, MATCH_SCHEMA, matchPrompt } = require("../utils/matchPrompts");

const PROVIDER = "openrouter";
const STATUSES = new Set(["satisfied", "partial", "absent", "contradicted"]);

/** Pure sanitiser (exported for tests). */
function sanitiseFindings(rawFindings, rubric, claims) {
  const claimIds = new Set((claims || []).map((c) => c.id));
  const byCriterion = new Map();
  for (const f of rawFindings || []) {
    if (!f || typeof f !== "object") continue;
    if (byCriterion.has(f.criterionId)) continue;
    const criterion = (rubric.criteria || []).find((c) => c.id === f.criterionId);
    if (!criterion) continue;

    const supportingClaimIds = (Array.isArray(f.supportingClaimIds) ? f.supportingClaimIds : []).filter((id) =>
      claimIds.has(id)
    );
    let status = STATUSES.has(f.status) ? f.status : "absent";
    if (supportingClaimIds.length === 0 && status !== "absent") status = "absent";

    byCriterion.set(f.criterionId, {
      criterionId: f.criterionId,
      status,
      supportingClaimIds,
      reasoning: String(f.reasoning || "").slice(0, 2000),
      confidence: Math.max(0, Math.min(1, Number(f.confidence) || 0)),
    });
  }

  // Every criterion gets a finding; unanswered ones are absent (conservative).
  const findings = [];
  for (const c of rubric.criteria || []) {
    findings.push(
      byCriterion.get(c.id) || {
        criterionId: c.id,
        status: "absent",
        supportingClaimIds: [],
        reasoning: "No verdict returned for this criterion.",
        confidence: 0,
      }
    );
  }
  return findings;
}

/**
 * Run the matcher for (frozen rubric × verified claims). One batched call.
 * Throws on LLM failure — the caller owns the fallback decision.
 */
async function matchEvidence({ rubric, claimGraph, company, usageKind = "match" }) {
  const claims = claimGraph.claims || [];
  const settings = await CompanySettings.findOne({ company }).select("ai");
  const resolved = resolveRole("reasoning", settings);

  const t0 = Date.now();
  const { data, usage, model, cached } = await llm.generateJSON({
    system: MATCH_SYSTEM,
    prompt: matchPrompt({ criteria: rubric.criteria || [], claims }),
    schema: MATCH_SCHEMA,
    // One reasoned finding per criterion over the full claim set — a 10-criterion
    // rubric against ~80 claims. Same truncation/timeout class as claim
    // extraction, and on the slower `reasoning` model.
    maxTokens: 8192,
    timeoutMs: llm.heavyTimeoutMs(),
    model: resolved.model,
    temperature: 0,
    promptVersion: MATCH_PROMPT_VERSION,
  });
  await usageService.recordUsage({
    company,
    kind: usageKind,
    provider: PROVIDER,
    model,
    usage,
    latencyMs: Date.now() - t0,
    engine: "ai",
    promptVersion: MATCH_PROMPT_VERSION,
    cached,
  });

  return { findings: sanitiseFindings(data.findings, rubric, claims), model, promptVersion: MATCH_PROMPT_VERSION };
}

module.exports = { matchEvidence, sanitiseFindings, MATCH_PROMPT_VERSION };
