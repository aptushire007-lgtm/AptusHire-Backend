// Claim extraction orchestration (BUILD-PLAN Phase 5) — résumé → ClaimGraph.
//
// Pipeline (every step's owner in brackets):
//   canonical text  [Phase 4 ingest — immutable]
//     → exclusions   = hostility spans [defense] + bias redactions [redactor]
//     → model view   = same-length blanked string [promptSafety — offsets keep]
//     → model text   = whitespace-collapsed view [what the LLM receives]
//     → raw claims   [LLM, rubric-blind, quotes only — claimPrompts]
//     → verified     [spanVerifier: cite-or-drop IN CODE]
//     → normalised   [skillOntology: vocabulary mismatch cannot reject]
//     → consistency  [claimConsistency: contradictions + gaps, in code]
//     → ClaimGraph   [persisted; reused by resumeHash while prompt unchanged]
//
// The LLM never sees: the rubric, the job, the candidate's name/contacts,
// graduation years, university brands, or content the defense flagged.

const crypto = require("crypto");
const ClaimGraph = require("../models/ClaimGraph");
const CompanySettings = require("../models/CompanySettings");
const llm = require("./llmService");
const usageService = require("./usageService");
const { resolveRole } = require("../config/models");
const { CLAIM_PROMPT_VERSION, CLAIM_SYSTEM, CLAIM_SCHEMA, claimPrompt } = require("../utils/claimPrompts");
const { buildModelView } = require("../utils/promptSafety");
const { planRedactions, REDACTOR_VERSION } = require("../utils/redactor");
const { verifyClaims } = require("../utils/spanVerifier");
const { canonicalizeSkill, cleanTerm, ontologyVersion } = require("../utils/skillOntology");
const { analyzeTimeline } = require("../utils/claimConsistency");

const PROVIDER = "openrouter";

function isEnabled() {
  const v = process.env.CLAIM_ENGINE_ENABLED;
  return v !== "false" && v !== "0" && llm.isEnabled();
}

function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

// Collapse the view into what the model reads. IMPORTANT: this must be a pure
// function of the view — the bias guarantee is that two variants with the same
// view bytes produce the same model input.
function collapseView(view) {
  return view
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * PURE pipeline core (exported for offline tests): everything between the
 * canonical text and the persistable ClaimGraph payload, given the raw model
 * output. No I/O, no DB, no clock beyond `at`.
 */
function buildGraphPayload({ canonicalText, exclusions, rawClaims, meta }) {
  const { view } = buildModelView(canonicalText, exclusions);
  const { claims: verified, droppedClaims, droppedSpans, truncated } = verifyClaims(rawClaims, canonicalText, view);

  const claims = verified.map((raw, i) => {
    const rawSkill = cleanTerm(raw.normalized?.skill || "");
    const canonical = rawSkill ? canonicalizeSkill(rawSkill) : null;
    return {
      id: `k${i + 1}`,
      type: raw.type,
      subject: String(raw.subject || "").slice(0, 300),
      predicate: String(raw.predicate || "").slice(0, 300),
      object: String(raw.object || "").slice(0, 300),
      normalized: {
        skill: canonical || rawSkill || "",
        rawSkill: rawSkill || "",
        years: Number.isFinite(Number(raw.normalized?.years)) ? Number(raw.normalized.years) : 0,
        level: String(raw.normalized?.level || "").slice(0, 100),
        domain: String(raw.normalized?.domain || "").slice(0, 100),
        startDate: String(raw.normalized?.startDate || "").slice(0, 20),
        endDate: String(raw.normalized?.endDate || "").slice(0, 20),
      },
      spans: raw.spans,
      confidence: Math.min(1, Math.max(0, Number(raw.confidence) || 0)),
      specificity: ["vague", "specific", "quantified"].includes(raw.specificity) ? raw.specificity : "vague",
      verificationStatus: "unverified",
      selfReportedOnly: true,
    };
  });

  const { internalContradictions, timelineGaps } = analyzeTimeline(claims, { nowMonth: meta?.nowMonth });

  // Claims implicated in an internal contradiction are marked — the scorer
  // (Phase 6) treats contradicted_internally via the verification multiplier,
  // and the QA gate routes them toward probes, never auto-penalties.
  const contradictedIds = new Set(internalContradictions.flatMap((c) => c.claimIds));
  for (const c of claims) {
    if (contradictedIds.has(c.id) && c.type !== "employment_period") {
      c.verificationStatus = "contradicted_internally";
    }
  }

  return {
    claims,
    internalContradictions,
    timelineGaps,
    stats: { droppedClaims, droppedSpans, truncated },
  };
}

/**
 * Extract (or reuse) the ClaimGraph for a candidate. Reuse key: same
 * resumeHash + promptVersion + ontologyVersion + redactorVersion — any of
 * those changing means the graph must be rebuilt to stay reproducible.
 */
async function extractForCandidate(candidate, job) {
  if (!isEnabled()) {
    const err = new Error("Claim engine is disabled");
    err.code = "CLAIM_ENGINE_DISABLED";
    throw err;
  }
  const canonicalText = candidate.resumeText || "";
  if (!canonicalText.trim()) {
    const err = new Error("No resume text to extract claims from");
    err.code = "NO_RESUME_TEXT";
    throw err;
  }
  const resumeHash = candidate.resumeHash || sha256(canonicalText);

  const existing = await ClaimGraph.findOne({
    candidate: candidate._id,
    company: candidate.company,
    resumeHash,
    "extraction.promptVersion": CLAIM_PROMPT_VERSION,
    "extraction.ontologyVersion": ontologyVersion(),
    "extraction.redactorVersion": REDACTOR_VERSION,
  }).sort({ createdAt: -1 });
  if (existing) return existing;

  const exclusions = [
    ...(candidate.hostility?.excludedFromModel || []).map((e) => ({ start: e.start, end: e.end })),
    ...planRedactions(canonicalText, {
      name: candidate.basicDetails?.name,
      email: candidate.basicDetails?.email,
      phone: candidate.basicDetails?.phone,
    }),
  ];
  const { view } = buildModelView(canonicalText, exclusions);
  const modelText = collapseView(view);

  const settings = await CompanySettings.findOne({ company: candidate.company }).select("ai");
  const resolved = resolveRole("extraction", settings);

  const t0 = Date.now();
  const { data, usage, model, cached } = await llm.generateJSON({
    system: CLAIM_SYSTEM,
    prompt: claimPrompt(modelText),
    schema: CLAIM_SCHEMA,
    // A whole résumé decomposes into ~80 atomic claims, each carrying spans,
    // normalisation and verbatim quotes: measured 5.4k completion tokens for a
    // 9k-char CV. The old 4096 cap truncated mid-JSON on every real résumé, and
    // the truncated parse surfaced as a generic error that dropped the candidate
    // to the legacy keyword scorer. Sized with headroom for long CVs.
    maxTokens: 16384,
    timeoutMs: llm.heavyTimeoutMs(),
    model: resolved.model,
    temperature: 0,
    promptVersion: CLAIM_PROMPT_VERSION,
  });
  await usageService.recordUsage({
    company: candidate.company,
    kind: "claim_extract",
    provider: PROVIDER,
    model,
    usage,
    latencyMs: Date.now() - t0,
    engine: "ai",
    promptVersion: CLAIM_PROMPT_VERSION,
    cached,
  });

  const payload = buildGraphPayload({ canonicalText, exclusions, rawClaims: data.claims });
  if (payload.stats.droppedClaims > 0) {
    console.warn(
      `[claims] dropped ${payload.stats.droppedClaims} uncitable claim(s) and ${payload.stats.droppedSpans} span(s) ` +
        `for candidate ${candidate._id} (cite-or-drop)`
    );
  }

  return ClaimGraph.create({
    candidate: candidate._id,
    job: job._id,
    company: candidate.company,
    resumeHash,
    claims: payload.claims,
    internalContradictions: payload.internalContradictions,
    timelineGaps: payload.timelineGaps,
    extraction: {
      engine: "ai",
      model,
      promptVersion: CLAIM_PROMPT_VERSION,
      ontologyVersion: ontologyVersion(),
      redactorVersion: REDACTOR_VERSION,
      samples: 1,
      at: new Date(),
      droppedClaims: payload.stats.droppedClaims,
      droppedSpans: payload.stats.droppedSpans,
    },
  });
}

module.exports = { isEnabled, extractForCandidate, buildGraphPayload, collapseView };
