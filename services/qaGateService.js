// The QA gate (BUILD-PLAN Phase 7). Every evidence assessment passes through
// here before a human sees it — and FAILING the gate is a valid, honest
// outcome ("we're not confident — you decide").
//
// Components, in run order:
//   7.3 Invariants  (pure code) — violation ⇒ INVARIANT_VIOLATION thrown; the
//       caller hard-fails to the legacy engine and alerts an operator. A
//       broken pipeline must never quietly produce a hiring decision.
//   7.2 Adversarial critic — a second model whose only job is to refute
//       claims whose quote doesn't support them; refuted claims are removed
//       and the score recomputed deterministically.
//   7.1 Self-consistency — near a band boundary, re-run matching N-way (the
//       Phase 2 ensemble); low agreement routes to review, never to a verdict.
//   7.4 Counterfactual probe — swap a demographic marker pre-redaction and
//       assert the model input is byte-identical. Zero-delta is structural;
//       a difference is a redactor LEAK: alert + route to review.
//
// Gate law: the gate only ever moves candidates TOWARD human review, never
// toward auto-rejection. Modes: off | monitor (compute + log, don't route) |
// enforce (apply routing).

const llm = require("./llmService");
const usageService = require("./usageService");
const CompanySettings = require("../models/CompanySettings");
const { resolveRole } = require("../config/models");
const { CRITIC_PROMPT_VERSION, CRITIC_SYSTEM, CRITIC_SCHEMA, criticPrompt } = require("../utils/qaPrompts");
const { MATCH_SYSTEM, MATCH_SCHEMA, MATCH_PROMPT_VERSION, matchPrompt } = require("../utils/matchPrompts");
const { sanitiseFindings } = require("./evidenceMatcher");
const { computeAssessment } = require("../utils/evidenceScorer");
const { checkInvariants } = require("../utils/assessmentInvariants");
const { buildModelView } = require("../utils/promptSafety");
const { planRedactions, nameSpans, replaceNameOccurrences } = require("../utils/redactor");
const { collapseView } = require("./claimService");
const resumeDefense = require("./resumeDefenseService");

function defenseAnalyze(text) {
  return resumeDefense.analyze({ text, blocks: [], artifacts: {} });
}
const metrics = require("../utils/metrics");

const PROVIDER = "openrouter";
const BOUNDARY_MARGIN = 6;      // points from a threshold that counts as "near"
const MIN_AGREEMENT = 0.75;
// Fixed swap target, never a real candidate. ONE token, no whitespace — this is
// load-bearing: names ride inside whitespace-sensitive tokens ("linkedin.com/
// in/govind-kumar-jha-…", live 2026-08-18), and a multi-word replacement plants
// a space mid-URL, splits the URL_RE match, and surfaces as a fake "leak" that
// is really the probe's own artifact.
const COUNTERFACTUAL_NAME = "Jordanwinters";

metrics.registerMetric("ats_qa_gate_total", "counter", "QA gate outcomes by result");
metrics.registerMetric("ats_counterfactual_leaks_total", "counter", "Counterfactual probes that found a redactor leak");

function gateMode() {
  const v = (process.env.ATS_QA_GATE || "monitor").toLowerCase();
  return ["off", "monitor", "enforce"].includes(v) ? v : "monitor";
}

function sampleRate() {
  const n = Number(process.env.QA_COUNTERFACTUAL_SAMPLE_RATE);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.05;
}

// Deterministic sampling — no randomness in the pipeline. The same candidate
// is either always probed or never, which also makes incidents reproducible.
function shouldRunCounterfactual(candidateId, force) {
  if (force) return true;
  const rate = sampleRate();
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const hex = String(candidateId).slice(-4);
  const bucket = parseInt(hex, 16) % 1000;
  return bucket < rate * 1000;
}

// ---------------------------------------------------------------------------
// 7.2 — adversarial critic
// ---------------------------------------------------------------------------
async function runCritic({ claims, company }) {
  const settings = await CompanySettings.findOne({ company }).select("ai");
  const resolved = resolveRole("cheap", settings);
  const t0 = Date.now();
  const { data, usage, model, cached } = await llm.generateJSON({
    system: CRITIC_SYSTEM,
    prompt: criticPrompt(claims),
    schema: CRITIC_SCHEMA,
    maxTokens: 1024,
    model: resolved.model,
    temperature: 0,
    promptVersion: CRITIC_PROMPT_VERSION,
  });
  await usageService.recordUsage({
    company,
    kind: "match",
    provider: PROVIDER,
    model,
    usage,
    latencyMs: Date.now() - t0,
    engine: "ai",
    promptVersion: CRITIC_PROMPT_VERSION,
    cached,
  });
  const known = new Set(claims.map((c) => c.id));
  return (data.refuted || []).filter((r) => known.has(r.claimId));
}

// ---------------------------------------------------------------------------
// 7.1 — self-consistency near band boundaries
// ---------------------------------------------------------------------------
function nearBoundary(score, thresholds) {
  const { advance = 60, review = 45 } = thresholds || {};
  return Math.abs(score - advance) <= BOUNDARY_MARGIN || Math.abs(score - review) <= BOUNDARY_MARGIN;
}

async function runSelfConsistency({ rubric, claims, company }) {
  const settings = await CompanySettings.findOne({ company }).select("ai");
  const resolved = resolveRole("reasoning", settings);
  const t0 = Date.now();
  const result = await llm.generateJSONEnsemble({
    system: MATCH_SYSTEM,
    prompt: matchPrompt({ criteria: rubric.criteria || [], claims }),
    schema: MATCH_SCHEMA,
    // Must mirror evidenceMatcher exactly: this re-runs the SAME match call N
    // times to measure agreement. A tighter cap here would make samples truncate
    // where the real matcher didn't, turning a config artefact into fake
    // "disagreement" — and disagreement routes candidates to humans (rule 4).
    maxTokens: 8192,
    timeoutMs: llm.heavyTimeoutMs(),
    model: resolved.model,
    temperature: 0,
    promptVersion: MATCH_PROMPT_VERSION,
    n: 3,
  });
  await usageService.recordUsage({
    company,
    kind: "match",
    provider: PROVIDER,
    model: resolved.model,
    usage: result.usage,
    latencyMs: Date.now() - t0,
    engine: "ai",
    promptVersion: MATCH_PROMPT_VERSION,
  });
  return { agreement: result.agreement, samples: result.samples?.length || 1 };
}

// ---------------------------------------------------------------------------
// 7.4 — counterfactual probe: swapped marker ⇒ byte-identical model input
// ---------------------------------------------------------------------------
function runCounterfactual({ canonicalText, candidate }) {
  const known = {
    name: candidate.basicDetails?.name,
    email: candidate.basicDetails?.email,
    phone: candidate.basicDetails?.phone,
  };
  // The full model-input pipeline per variant. The defense scan is recomputed
  // on each text — a name swap changes string length, so reusing the base
  // text's exclusion offsets would blank the wrong ranges (a probe bug this
  // probe itself caught in the live smoke).
  const input = (text, k) => {
    const report = defenseAnalyze(text);
    const exclusions = [
      ...report.excludedFromModel.map((e) => ({ start: e.start, end: e.end })),
      ...planRedactions(text, k),
    ];
    return collapseView(buildModelView(text, exclusions).view);
  };
  const base = input(canonicalText, known);

  // The swap rewrites FULL-name occurrences using the redactor's own matcher
  // (utils/redactor.replaceNameOccurrences — case-seam glue included), so the
  // probe and the redaction pass agree on what "the candidate's name" is.
  // 2026-08-18, live: "Govind Kumar JhaEmail:" (PDF style-run glue) was swapped
  // by this probe's old boundary-less regex while the redactor's strict boundary
  // let "Jha" through to the model — a REAL leak the matcher fix closed. The
  // swap stays full-name-only on purpose: a lone token the redactor blanks but
  // the swap keeps ("May" in "May 2022", candidate named May Chen) must keep
  // producing a delta, because there the redactor is destroying non-name
  // content and a human should look.
  if (!known.name || nameSpans(canonicalText, known.name, { fullNameOnly: true }).length === 0) {
    return { ran: false, identical: null, dimension: "name" };
  }
  const swappedText = replaceNameOccurrences(canonicalText, known.name, COUNTERFACTUAL_NAME);
  const swapped = input(swappedText, { ...known, name: COUNTERFACTUAL_NAME });
  return { ran: true, identical: swapped === base, dimension: "name" };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Run the QA gate over a computed (not yet persisted) assessment.
 * Returns { assessment, qa } — `assessment` may be a rescored copy (critic) or
 * re-banded to review (enforce mode). Throws Error{code:"INVARIANT_VIOLATION"}
 * when the pipeline itself is unsound.
 */
async function runGate({ assessment, rubric, claimGraph, canonicalText, candidate, force = {} }) {
  const mode = gateMode();
  const qa = {
    mode,
    outcome: "passed",
    reasons: [],
    agreement: undefined,
    criticDropped: 0,
    counterfactual: { ran: false, identical: undefined, dimension: undefined },
  };
  if (mode === "off") return { assessment, qa };

  let current = assessment;
  let claims = claimGraph.claims || [];

  // ---- 7.3 invariants (all modes; a broken pipeline is never shippable) ----
  const violations = checkInvariants({ assessment: current, rubric, claims, canonicalText });
  if (violations.length > 0) {
    metrics.incCounter("ats_qa_gate_total", { result: "invariant_violation" });
    const err = new Error(`Assessment invariant violation: ${violations.join(" · ")}`);
    err.code = "INVARIANT_VIOLATION";
    err.violations = violations;
    throw err;
  }

  // ---- 7.2 adversarial critic ----
  if (llm.isEnabled() && claims.length > 0) {
    try {
      const refuted = await runCritic({ claims, company: candidate.company });
      qa.criticDropped = refuted.length;
      if (refuted.length > 0) {
        qa.reasons.push(`critic_refuted:${refuted.map((r) => r.claimId).join(",")}`);
        if (mode === "enforce") {
          const refutedIds = new Set(refuted.map((r) => r.claimId));
          claims = claims.filter((c) => !refutedIds.has(c.id));
          const rescoreFindings = current.criterionFindings.map((f) => ({
            criterionId: f.criterionId,
            status: f.status,
            supportingClaimIds: f.supportingClaimIds.filter((id) => !refutedIds.has(id)),
            reasoning: f.reasoning,
            confidence: f.confidence,
          }));
          const before = current;
          current = computeAssessment({ rubric, claims, findings: rescoreFindings });
          // GATE LAW: the gate moves candidates toward review, never toward
          // auto-rejection. If dropping refuted evidence pushed a non-fail
          // into "fail", a human decides instead.
          if (current.decision === "fail" && before.decision !== "fail") {
            current = { ...current, band: "review", decision: "review", reviewReason: "critic_downgrade" };
          }
        }
      }
    } catch (err) {
      if (err.code === "INVARIANT_VIOLATION") throw err;
      qa.reasons.push("critic_unavailable");
    }
  }

  // ---- 7.1 self-consistency near a boundary ----
  if (llm.isEnabled() && nearBoundary(current.overallScore, rubric.thresholds)) {
    try {
      const { agreement } = await runSelfConsistency({ rubric, claims, company: candidate.company });
      qa.agreement = agreement;
      if (agreement !== undefined && agreement < MIN_AGREEMENT) {
        qa.reasons.push("low_model_agreement");
      }
    } catch (err) {
      qa.reasons.push("self_consistency_unavailable");
    }
  }

  // ---- 7.4 counterfactual probe ----
  if (shouldRunCounterfactual(candidate._id, force.counterfactual)) {
    qa.counterfactual = runCounterfactual({ canonicalText, candidate });
    if (qa.counterfactual.ran && qa.counterfactual.identical === false) {
      metrics.incCounter("ats_counterfactual_leaks_total", {});
      qa.reasons.push("counterfactual_leak");
      console.error(
        `[qaGate] COUNTERFACTUAL LEAK for candidate ${candidate._id}: swapped ${qa.counterfactual.dimension} changed the model input — redactor defect, investigate immediately`
      );
    }
  }

  // ---- routing (enforce only; and only ever TOWARD review) ----
  const routeworthy = qa.reasons.some((r) =>
    r === "low_model_agreement" || r === "counterfactual_leak"
  );
  if (routeworthy) {
    qa.outcome = "routed_review";
    if (mode === "enforce" && current.decision === "pass") {
      current = {
        ...current,
        band: "review",
        decision: "review",
        reviewReason: current.reviewReason || qa.reasons.find((r) => r === "low_model_agreement" || r === "counterfactual_leak"),
      };
    }
    if (mode === "enforce" && current.decision === "fail" && !(current.reviewReason || "").startsWith("disqualifier")) {
      // Low confidence in a decline is ALSO a human's call — the gate never
      // hardens a rejection.
      current = { ...current, band: "review", decision: "review", reviewReason: qa.reasons[0] };
    }
  }

  metrics.incCounter("ats_qa_gate_total", { result: qa.outcome });
  return { assessment: current, qa };
}

module.exports = { runGate, gateMode, nearBoundary, runCounterfactual, BOUNDARY_MARGIN, MIN_AGREEMENT };
