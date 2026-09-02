// Deterministic round-scorecard engine (human interview rounds). PURE: no I/O,
// no clock, no model. (frozen rubric × one interviewer's observations) → roll-up.
//
// Engineering rule 1 applied to PEOPLE. The interviewer supplies per-criterion
// judgements and the evidence behind them; this file does every piece of
// arithmetic. Nobody hands us a total — not the model, not the interviewer. A
// paper scorecard with a hand-summed "18/25" on it is an opinion about a
// candidate; this is a computation over recorded observations, and
// reproducibilityHash asserts it: same observations ⇒ same number, months later,
// in a discrimination claim.
//
// Design decisions that ARE the product:
//   - A rating without evidence is not a rating. `validateSubmission` rejects a
//     scored criterion whose note is empty — cite-or-abstain, applied to humans
//     exactly as spanVerifier applies it to the model.
//   - `not_assessed` is a first-class, DEFAULT outcome. An interviewer who did
//     not probe something must be able to say so; a form that forces a number on
//     an untested criterion manufactures evidence, which is worse than a gap.
//   - The roll-up covers only what was actually assessed, and reports its own
//     coverage. Below MIN_COVERAGE the score is WITHHELD rather than rendered —
//     a number derived from one of six criteria is not comparable to one derived
//     from six, and showing it anyway would be the placeholder-as-measurement
//     failure rule 5 exists to prevent.
//   - Disqualifiers carry no rating row. They are facts, not judgement calls; an
//     interviewer who discovers one records it as a `decline` with a reason,
//     which is a human adverse action with a name on it (rule 6), never a
//     code-computed gate firing off a Likert score.

const crypto = require("crypto");

const ENGINE_VERSION = "scorecard-engine-2026-08-01.1";

const RATING_MIN = 1;
const RATING_MAX = 5;

// Recruiter-facing anchors. Exported so the form, the PDF, and the ledger cannot
// drift into three different vocabularies for the same number.
const RATING_LABELS = {
  5: "Exceptional",
  4: "Above average",
  3: "Average",
  2: "Satisfactory",
  1: "Unsatisfactory",
};

const DECISIONS = ["advance", "hold", "decline"];
const ADVERSE_DECISIONS = ["decline"];
const CLAIM_VERDICTS = ["verified", "contradicted", "inconclusive"];

// Below this share of assessable rubric weight, no score is emitted.
const MIN_COVERAGE = 0.5;

// --- evidence hierarchy ------------------------------------------------------
// A human who probed a claim live is the strongest evidence the system can hold,
// so human verdicts sit at the top of the hierarchy declared in ClaimGraph.js.
// `contradicted_by_human` is 0 like every other contradiction — it weakens the
// score to nothing and routes to a person; it never auto-rejects anyone.
const HUMAN_VERIFICATION_STATUS = {
  verified: "verified_by_human",
  contradicted: "contradicted_by_human",
  inconclusive: null, // an inconclusive round leaves the claim exactly as it was
};

// Rank governs write-back precedence: a verdict may only overwrite one of
// STRICTLY lower rank. Two humans landing on the same claim therefore never
// silently overwrite each other — equal rank means the disagreement survives and
// gets routed (rule 4), which is the entire point of running more than one round.
const VERIFICATION_RANK = {
  unverified: 0,
  corroborated_internally: 1,
  contradicted_internally: 1,
  verified_in_assessment: 2,
  contradicted_in_assessment: 2,
  verified_in_interview: 3,
  contradicted_in_interview: 3,
  verified_by_human: 4,
  contradicted_by_human: 4,
};

function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function stableStringify(value) {
  if (value === null || value === undefined || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/** Criteria that get a rating row: scoreable only (see header on disqualifiers). */
function ratableCriteria(rubric) {
  return (rubric?.criteria || []).filter((c) => c.kind !== "disqualifier");
}

/**
 * Does `incoming` outrank what the claim already carries? Pure, exported, and
 * the ONLY place precedence is decided — the service asks this rather than
 * reimplementing the hierarchy.
 */
function outranks(existingStatus, incomingStatus) {
  const existing = VERIFICATION_RANK[existingStatus] ?? 0;
  const incoming = VERIFICATION_RANK[incomingStatus] ?? 0;
  return incoming > existing;
}

function isBlank(text) {
  return typeof text !== "string" || !text.trim();
}

/**
 * Validate one interviewer's submission against the frozen rubric.
 * Returns { errors: [string], rows: [normalised row] }. `errors` non-empty ⇒ the
 * caller rejects the submission whole; a partially-valid scorecard is not a
 * thing, because the half that validated would render as if it were complete.
 */
function validateSubmission({ rubric, ratings, decision, decisionReason }) {
  const errors = [];
  const ratable = new Map(ratableCriteria(rubric).map((c) => [c.id, c]));
  const seen = new Set();
  const rows = [];

  for (const raw of ratings || []) {
    const criterionId = String(raw?.criterionId || "").trim();
    const criterion = ratable.get(criterionId);
    if (!criterion) {
      errors.push(`Unknown or non-ratable criterion "${criterionId}" — the rubric this scorecard was opened against has no such row`);
      continue;
    }
    if (seen.has(criterionId)) {
      errors.push(`Criterion "${criterionId}" appears more than once`);
      continue;
    }
    seen.add(criterionId);

    const notAssessed = Boolean(raw?.notAssessed);
    const hasRating = raw?.rating !== null && raw?.rating !== undefined && raw?.rating !== "";
    const note = typeof raw?.note === "string" ? raw.note.trim() : "";

    if (notAssessed && hasRating) {
      errors.push(`"${criterion.label}" is marked not assessed but also carries a rating — pick one`);
      continue;
    }
    if (!notAssessed && !hasRating) {
      errors.push(`"${criterion.label}" has neither a rating nor a "not assessed" mark`);
      continue;
    }

    let rating = null;
    if (hasRating) {
      rating = Number(raw.rating);
      if (!Number.isInteger(rating) || rating < RATING_MIN || rating > RATING_MAX) {
        errors.push(`"${criterion.label}" has rating ${raw.rating} — must be a whole number ${RATING_MIN}–${RATING_MAX}`);
        continue;
      }
      // The rule the whole artifact rests on.
      if (isBlank(note)) {
        errors.push(`"${criterion.label}" is rated ${rating} with no evidence — record what you observed, or mark it not assessed`);
        continue;
      }
    }

    const claimVerdicts = [];
    for (const cv of raw?.claimVerdicts || []) {
      const claimId = String(cv?.claimId || "").trim();
      const verdict = String(cv?.verdict || "").trim();
      if (!claimId) continue;
      if (!CLAIM_VERDICTS.includes(verdict)) {
        errors.push(`Claim "${claimId}" has verdict "${verdict}" — must be one of ${CLAIM_VERDICTS.join(", ")}`);
        continue;
      }
      const cvNote = typeof cv?.note === "string" ? cv.note.trim() : "";
      // A verdict that moves a claim must cite something; inconclusive changes
      // nothing downstream, so it is allowed to stand bare.
      if (verdict !== "inconclusive" && isBlank(cvNote)) {
        errors.push(`Claim "${claimId}" is marked ${verdict} with no evidence — quote what the candidate said, or mark it inconclusive`);
        continue;
      }
      claimVerdicts.push({ claimId, verdict, note: cvNote });
    }

    rows.push({
      criterionId,
      rating,
      notAssessed: notAssessed || rating === null,
      note,
      claimVerdicts: claimVerdicts.sort((a, b) => a.claimId.localeCompare(b.claimId)),
    });
  }

  if (!DECISIONS.includes(decision)) {
    errors.push(`Decision must be one of ${DECISIONS.join(" / ")}`);
  }
  // Rule 6: an adverse action carries a human's stated reason, always.
  if (ADVERSE_DECISIONS.includes(decision) && isBlank(decisionReason)) {
    errors.push("A decline must record why — this is an adverse action and it needs a stated reason");
  }

  return { errors, rows: rows.sort((a, b) => a.criterionId.localeCompare(b.criterionId)) };
}

/**
 * Weighted roll-up over the criteria this interviewer actually assessed.
 *
 * Rating → credit is linear: 1 ⇒ 0.0, 5 ⇒ 1.0 (i.e. (r-1)/4). Stated explicitly
 * because it is a policy choice, not a law of arithmetic — a "1" means the
 * criterion earned nothing, not that the candidate is worth 20% on it.
 *
 * Weights are renormalised across assessed criteria so an interviewer who
 * covered 3 of 6 is not silently penalised for the 3 they left to another round.
 * `coverage` is the share of ratable rubric weight that carries a rating; below
 * MIN_COVERAGE the score is withheld (null) and `withheldReason` says why.
 */
function computeRollup({ rubric, rows }) {
  const ratable = ratableCriteria(rubric);
  const byId = new Map(ratable.map((c) => [c.id, c]));
  const totalWeight = ratable.reduce((sum, c) => sum + (Number(c.weight) || 0), 0);

  const perCriterion = [];
  let assessedWeight = 0;
  let creditWeight = 0;

  for (const row of rows || []) {
    const criterion = byId.get(row.criterionId);
    if (!criterion) continue;
    const weight = Number(criterion.weight) || 0;
    if (row.notAssessed || row.rating === null) {
      perCriterion.push({ criterionId: row.criterionId, label: criterion.label, weight, rating: null, notAssessed: true, credit: null });
      continue;
    }
    const credit = (row.rating - RATING_MIN) / (RATING_MAX - RATING_MIN);
    assessedWeight += weight;
    creditWeight += weight * credit;
    perCriterion.push({ criterionId: row.criterionId, label: criterion.label, weight, rating: row.rating, notAssessed: false, credit });
  }

  const coverage = totalWeight > 0 ? assessedWeight / totalWeight : 0;
  const withheld = coverage < MIN_COVERAGE;

  return {
    perCriterion: perCriterion.sort((a, b) => a.criterionId.localeCompare(b.criterionId)),
    coverage,
    assessedCount: perCriterion.filter((p) => !p.notAssessed).length,
    ratableCount: ratable.length,
    // 0–100 on the same scale as every other score in the platform.
    score: withheld || assessedWeight === 0 ? null : Math.round((creditWeight / assessedWeight) * 100),
    withheldReason: withheld
      ? `Only ${Math.round(coverage * 100)}% of this role's rubric weight was assessed in this round (minimum ${Math.round(
          MIN_COVERAGE * 100
        )}% for a comparable score) — the per-criterion ratings below stand on their own.`
      : "",
    engineVersion: ENGINE_VERSION,
  };
}

/**
 * The calibration signal (Phase 10 / A5.3). Recorded only when the human rated
 * blind and the engine had a score to compare against; `null` deltas are honest
 * absences, never zeroes.
 */
function computeDisagreement({ engineScore, humanScore }) {
  const engine = Number.isFinite(engineScore) ? engineScore : null;
  const human = Number.isFinite(humanScore) ? humanScore : null;
  if (engine === null || human === null) {
    return { engineScore: engine, humanScore: human, delta: null, direction: "unavailable" };
  }
  const delta = human - engine;
  return {
    engineScore: engine,
    humanScore: human,
    delta,
    direction: delta === 0 ? "agree" : delta > 0 ? "human_higher" : "human_lower",
  };
}

/**
 * Same-inputs-same-output proof for the roll-up. Hashes the frozen rubric
 * version, the observations, and the engine version — deliberately NOT the
 * interviewer or the timestamp, so re-running the identical observations
 * reproduces the identical number.
 */
function reproducibilityHash({ rubricVersion, rows, rollup }) {
  const observations = stableStringify(
    (rows || []).map((r) => ({ c: r.criterionId, r: r.rating, n: r.notAssessed, v: r.claimVerdicts.map((x) => [x.claimId, x.verdict]) }))
  );
  return sha256(`${rubricVersion}|${observations}|${rollup.score ?? "withheld"}|${ENGINE_VERSION}`);
}

/**
 * Flatten a submission's claim verdicts into write-back instructions. Pure —
 * the service applies these against the ClaimGraph and enforces precedence with
 * `outranks`. Inconclusive verdicts are dropped here: they carry no status.
 */
function claimWriteBacks(rows) {
  const out = [];
  for (const row of rows || []) {
    for (const cv of row.claimVerdicts || []) {
      const status = HUMAN_VERIFICATION_STATUS[cv.verdict];
      if (!status) continue;
      out.push({ claimId: cv.claimId, criterionId: row.criterionId, verdict: cv.verdict, status, note: cv.note });
    }
  }
  return out.sort((a, b) => a.claimId.localeCompare(b.claimId));
}

module.exports = {
  ENGINE_VERSION,
  RATING_MIN,
  RATING_MAX,
  RATING_LABELS,
  DECISIONS,
  CLAIM_VERDICTS,
  MIN_COVERAGE,
  HUMAN_VERIFICATION_STATUS,
  VERIFICATION_RANK,
  ratableCriteria,
  outranks,
  validateSubmission,
  computeRollup,
  computeDisagreement,
  reproducibilityHash,
  claimWriteBacks,
  stableStringify,
};
