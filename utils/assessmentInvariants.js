// Invariant checks over a computed assessment (BUILD-PLAN Phase 7.3).
// Pure code. Any violation means the PIPELINE is broken — not the candidate —
// so the caller must hard-fail to the legacy engine and page an operator. A
// broken pipeline must never quietly produce a hiring decision.

const TOLERANCE = 0.51; // points; overall is rounded to an integer from the raw sum

/**
 * Returns [] when sound, else a list of violation strings.
 *   assessment — output of evidenceScorer.computeAssessment
 *   rubric     — the frozen rubric scored against
 *   claims     — the ClaimGraph claims array
 *   canonicalText — the immutable resume text spans index into
 */
function checkInvariants({ assessment, rubric, claims, canonicalText }) {
  const violations = [];
  const a = assessment;

  if (!(a.overallScore >= 0 && a.overallScore <= 100)) {
    violations.push(`overallScore out of range: ${a.overallScore}`);
  }

  // Decomposition: criterion points must sum to the total (pre-rounding).
  const sum = (a.criterionFindings || []).reduce((s, f) => s + (f.points || 0), 0);
  if (Math.abs(sum - a.overallRaw) > 1e-6) {
    violations.push(`criterion points sum ${sum} ≠ overallRaw ${a.overallRaw}`);
  }
  if (Math.abs(Math.round(Math.max(0, Math.min(100, a.overallRaw))) - a.overallScore) > TOLERANCE) {
    violations.push(`overallScore ${a.overallScore} does not round from raw ${a.overallRaw}`);
  }

  // Referential integrity: every cited claim exists; every cited span is a
  // literal slice of the canonical text.
  const claimsById = new Map((claims || []).map((c) => [c.id, c]));
  for (const f of a.criterionFindings || []) {
    for (const id of f.supportingClaimIds || []) {
      if (!claimsById.has(id)) violations.push(`finding ${f.criterionId} cites missing claim ${id}`);
    }
  }
  for (const e of a.topEvidence || []) {
    const claim = claimsById.get(e.claimId);
    if (!claim) {
      violations.push(`topEvidence cites missing claim ${e.claimId}`);
      continue;
    }
    const ok = (claim.spans || []).some(
      (s) => canonicalText.slice(s.start, s.end) === s.quote && e.quote === s.quote
    );
    if (!ok) violations.push(`topEvidence quote for ${e.claimId} is not a verified span`);
  }
  for (const c of claims || []) {
    for (const s of c.spans || []) {
      if (canonicalText.slice(s.start, s.end) !== s.quote) {
        violations.push(`claim ${c.id} span [${s.start},${s.end}) does not slice to its quote`);
      }
    }
  }

  // Disqualifier consistency: a satisfied disqualifier must mean fail; no
  // disqualifier may carry weight or points.
  const disqualifiers = (a.criterionFindings || []).filter((f) => f.kind === "disqualifier");
  for (const d of disqualifiers) {
    if (d.weight !== 0 || d.points !== 0) violations.push(`disqualifier ${d.criterionId} carries weight/points`);
    if (d.status === "satisfied" && a.decision !== "fail") {
      violations.push(`disqualifier ${d.criterionId} satisfied but decision is ${a.decision}`);
    }
  }

  // Band ↔ decision ↔ thresholds consistency (unless a disqualifier overrode).
  const { advance = 60, review = 45 } = rubric.thresholds || {};
  const overridden = (a.reviewReason || "").startsWith("disqualifier");
  if (!overridden) {
    const expectedBand = a.overallScore >= advance ? "advance" : a.overallScore >= review ? "review" : "decline";
    if (a.band !== expectedBand) violations.push(`band ${a.band} inconsistent with score ${a.overallScore} and thresholds`);
  }
  const bandDecision = { advance: "pass", review: "review", decline: "fail" };
  if (bandDecision[a.band] !== a.decision) violations.push(`decision ${a.decision} inconsistent with band ${a.band}`);

  // An empty claim set can never pass (guardrail from the Phase 6 property list).
  if ((claims || []).length === 0 && a.decision === "pass") {
    violations.push("empty claim set produced a pass");
  }

  return violations;
}

module.exports = { checkInvariants };
