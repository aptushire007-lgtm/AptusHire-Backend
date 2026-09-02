// Deterministic evidence scorer (BUILD-PLAN Phase 6.2).
//
// PURE FUNCTION. No I/O, no model, no clock, no randomness. The LLM matcher
// (evidenceMatcher) supplies per-criterion STATUS verdicts and supporting
// claim ids — it never emits a number that reaches this arithmetic. Everything
// below is exhaustively unit-testable, which is exactly what a bias audit and
// a discrimination defence need.
//
//   criterionScore = statusValue(status)
//                  × specificityMultiplier(best supporting claim)
//                  × verificationMultiplier(best supporting claim)
//   overall        = Σ (criterionScore × normalisedWeight) × 100
//   disqualifier satisfied → decision "fail" with the criterion named; weights
//   bypassed entirely. A PARTIAL disqualifier verdict is ambiguity → review.
//
// The verification multiplier is the arithmetic expression of the whole
// thesis: proof beats assertion. It is why a Phase 8 interview verdict CHANGES
// the score instead of decorating the report.

const crypto = require("crypto");

const SCORER_VERSION = "2026-07-25.1";

const STATUS_VALUE = { satisfied: 1, partial: 0.5, absent: 0, contradicted: 0 };

const SPECIFICITY_MULT = { quantified: 1, specific: 0.85, vague: 0.6 };

const VERIFICATION_MULT = {
  unverified: 0.75,               // self-reported assertion, nothing checked yet
  corroborated_internally: 0.9,   // consistent with the rest of the document
  contradicted_internally: 0.5,   // internally inconsistent — weakened, probed, never zeroed by code alone
  verified_in_assessment: 0.95,   // proven by targeted test items (A3.2) — real proof, below a live probe
  contradicted_in_assessment: 0,  // targeted items majority-failed — surfaced to a human, never auto-rejects
  verified_in_interview: 1,       // proven live (Phase 8 writes this back)
  contradicted_in_interview: 0,   // proven false live
  verified_by_human: 1,           // a human interviewer probed it live and cited what they heard (RoundScorecard)
  contradicted_by_human: 0,       // disproven live by a person — routed to a human, never an auto-reject
};

// Claims supporting a criterion whose weight is at or above this share of the
// total are "high-weight" for probe generation (Phase 8 consumes these).
const HIGH_WEIGHT_FACTOR = 1.2; // ≥ 1.2 × the mean scoreable weight

function evidenceMultiplier(claim) {
  if (!claim) return SPECIFICITY_MULT.vague * VERIFICATION_MULT.unverified;
  const spec = SPECIFICITY_MULT[claim.specificity] ?? SPECIFICITY_MULT.vague;
  const ver = VERIFICATION_MULT[claim.verificationStatus] ?? VERIFICATION_MULT.unverified;
  return spec * ver;
}

/**
 * Score one assessment. Inputs:
 *   rubric     — frozen RoleRubric (criteria with normalised weights, thresholds)
 *   claims     — verified claims from the ClaimGraph (plain objects)
 *   findings   — matcher verdicts [{criterionId, status, supportingClaimIds, reasoning, confidence}]
 * Returns the full deterministic assessment payload (no persistence).
 */
function computeAssessment({ rubric, claims, findings }) {
  const claimsById = new Map((claims || []).map((c) => [c.id, c]));
  const findingByCriterion = new Map();
  for (const f of findings || []) {
    if (!findingByCriterion.has(f.criterionId)) findingByCriterion.set(f.criterionId, f);
  }

  const criteria = rubric.criteria || [];
  const scoreable = criteria.filter((c) => c.kind !== "disqualifier");
  const meanWeight = scoreable.length > 0 ? 1 / scoreable.length : 0;

  const criterionFindings = [];
  let overallRaw = 0;
  let disqualifierHit = null;
  let disqualifierAmbiguous = null;

  for (const criterion of criteria) {
    const finding = findingByCriterion.get(criterion.id) || {
      criterionId: criterion.id,
      status: "absent",
      supportingClaimIds: [],
      reasoning: "No verdict returned for this criterion; treated as absent (conservative default).",
      confidence: 0,
    };

    // Cite-or-abstain for matching: a positive/negative verdict with no valid
    // supporting claims degrades to absent — the matcher may not assert
    // unevidenced conclusions any more than the extractor may.
    const supporting = (finding.supportingClaimIds || []).filter((id) => claimsById.has(id));
    let status = STATUS_VALUE[finding.status] !== undefined ? finding.status : "absent";
    if (supporting.length === 0 && status !== "absent") status = "absent";

    const best = supporting.map((id) => claimsById.get(id)).sort((a, b) => evidenceMultiplier(b) - evidenceMultiplier(a))[0];

    if (criterion.kind === "disqualifier") {
      // A disqualifier criterion describes the DISQUALIFYING condition itself.
      if (status === "satisfied" && !disqualifierHit) disqualifierHit = { criterion, finding, supporting };
      if (status === "partial" && !disqualifierAmbiguous) disqualifierAmbiguous = { criterion, finding };
      criterionFindings.push({
        criterionId: criterion.id,
        label: criterion.label,
        kind: criterion.kind,
        weight: 0,
        status,
        supportingClaimIds: supporting,
        reasoning: String(finding.reasoning || "").slice(0, 2000),
        confidence: clamp01(finding.confidence),
        criterionScore: 0,
        points: 0,
      });
      continue;
    }

    const criterionScore = STATUS_VALUE[status] * evidenceMultiplier(best);
    // Round BEFORE accumulating so the stored decomposition sums to the
    // stored total exactly — the "criteria sum to the total" invariant is
    // then true by construction, not within-epsilon.
    const points = round4(criterionScore * (criterion.weight || 0) * 100);
    overallRaw += points;

    criterionFindings.push({
      criterionId: criterion.id,
      label: criterion.label,
      kind: criterion.kind,
      weight: criterion.weight || 0,
      status,
      supportingClaimIds: supporting,
      reasoning: String(finding.reasoning || "").slice(0, 2000),
      confidence: clamp01(finding.confidence),
      criterionScore: round4(criterionScore),
      points,
    });
  }

  const overallScore = Math.max(0, Math.min(100, Math.round(overallRaw)));

  // Bands from the frozen rubric's two thresholds (Phase 6.3): the middle band
  // is where humans spend their attention.
  const { advance = 60, review = 45 } = rubric.thresholds || {};
  let band = overallScore >= advance ? "advance" : overallScore >= review ? "review" : "decline";
  let decision = band === "advance" ? "pass" : band === "review" ? "review" : "fail";
  let reviewReason = band === "review" ? "score_in_review_band" : "";

  if (disqualifierHit) {
    band = "decline";
    decision = "fail";
    reviewReason = `disqualifier:${disqualifierHit.criterion.label}`;
  } else if (disqualifierAmbiguous) {
    // Ambiguous disqualifier evidence must never fail someone automatically —
    // and must never advance past a human either.
    band = "review";
    decision = "review";
    reviewReason = `disqualifier_ambiguous:${disqualifierAmbiguous.criterion.label}`;
  } else if ((claims || []).length === 0 && decision === "pass") {
    // No evidence can never mean "advance" — even under a degenerate rubric
    // whose advance threshold is 0. A human looks first.
    band = "review";
    decision = "review";
    reviewReason = "no_evidence";
  }

  // "Show your work" payload: the best quote per positively-scored criterion.
  const topEvidence = criterionFindings
    .filter((f) => f.kind !== "disqualifier" && f.supportingClaimIds.length > 0 && STATUS_VALUE[f.status] > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 5)
    .map((f) => {
      const claim = claimsById.get(f.supportingClaimIds[0]);
      const span = claim?.spans?.[0];
      return { criterionId: f.criterionId, claimId: claim?.id || "", quote: span?.quote || "" };
    })
    .filter((e) => e.quote);

  // Probe feed (Phase 8): claims carrying high-weight criteria that are
  // self-reported-only and not quantified — the résumé asserts, nothing proves.
  const highWeightCut = meanWeight * HIGH_WEIGHT_FACTOR;
  const unverifiedHighWeightClaims = [];
  for (const f of criterionFindings) {
    if (f.kind === "disqualifier" || f.weight < highWeightCut) continue;
    for (const id of f.supportingClaimIds) {
      const claim = claimsById.get(id);
      if (
        claim &&
        claim.selfReportedOnly !== false &&
        claim.verificationStatus === "unverified" &&
        claim.specificity !== "quantified" &&
        !unverifiedHighWeightClaims.some((u) => u.claimId === id)
      ) {
        unverifiedHighWeightClaims.push({ claimId: id, criterionId: f.criterionId });
      }
    }
  }

  return {
    overallScore,
    overallRaw: round4(overallRaw),
    band,
    decision,
    reviewReason,
    criterionFindings,
    topEvidence,
    unverifiedHighWeightClaims,
    scorerVersion: SCORER_VERSION,
  };
}

// Same inputs → same hash → same score, assertable in CI and demonstrable to
// an auditor (Phase 6.4). `claimsStateHash` (Phase 8) folds the claims'
// verification statuses into the basis, so a post-interview rescore — same
// résumé, same rubric, but claims now proven or disproven — gets a DIFFERENT
// hash: "same hash ⇒ same score" stays true across the pre/post pair.
function reproducibilityHash({ rubricId, rubricVersion, resumeHash, promptVersions, modelId, claimsStateHash }) {
  const parts = [rubricId, rubricVersion, resumeHash, (promptVersions || []).join("+"), modelId, SCORER_VERSION];
  if (claimsStateHash) parts.push(claimsStateHash);
  const basis = parts.join("|");
  return crypto.createHash("sha256").update(basis, "utf8").digest("hex");
}

// Order-independent digest of every claim's verification status (Phase 8).
function claimsStateHash(claims) {
  const basis = (claims || [])
    .map((c) => `${c.id}:${c.verificationStatus || "unverified"}`)
    .sort()
    .join(",");
  return crypto.createHash("sha256").update(basis, "utf8").digest("hex");
}

function clamp01(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

module.exports = {
  computeAssessment,
  reproducibilityHash,
  claimsStateHash,
  SCORER_VERSION,
  STATUS_VALUE,
  SPECIFICITY_MULT,
  VERIFICATION_MULT,
};
