// Per-candidate assembly + claim-derived difficulty tiering (ASSESSMENT-ENGINE-PLAN
// A2.2 / A3.0 / A3.1). PURE: seeded, reproducible, zero AI in the request path.
//
// A3.0 — "the AI sets the difficulty from the résumé", done on-thesis: the
// extraction already read the résumé, so the tier derives DETERMINISTICALLY from
// the candidate's own claims. Difficulty is claim-matched probing — verifying
// "8 years of React" requires the hard items; serving a senior claim easy
// questions verifies nothing. A recruiter override always wins. The mapping keys
// off claims ONLY — never any demographic or redacted attribute (bias-blind by
// construction; the counterfactual probe pins it).

const crypto = require("crypto");

// --- Seeded RNG --------------------------------------------------------------
// sha256(seedString) → xorshift32 stream. Deterministic across Node versions.

function seededRng(seedString) {
  const hash = crypto.createHash("sha256").update(seedString, "utf8").digest();
  let state = hash.readUInt32BE(0) ^ hash.readUInt32BE(4) ^ hash.readUInt32BE(8) ^ hash.readUInt32BE(12);
  if (state === 0) state = 0x9e3779b9;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000; // [0, 1)
  };
}

function seededShuffle(array, rng) {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- A3.0 claim-derived tier -------------------------------------------------

const SENIOR_LEVEL = /senior|lead|principal|staff|architect|head|director/i;
const MID_LEVEL = /mid|intermediate/i;

const TIER_YEARS = { hard: 6, medium: 2 }; // >= 6y claimed → hard; >= 2y → medium; else easy

/**
 * Derive the difficulty tier from the candidate's own extracted claims.
 * Deterministic, zero LLM cost. Returns { value, source: "claim_derived", basis }.
 * Claims may be empty (legacy tenant, no ClaimGraph) → caller falls back to the
 * paper's fixed tier, labelled as such (A3 guardrail: degrade silently to A2).
 */
function deriveTierFromClaims(claims) {
  let maxYears = 0;
  let seniorLevel = "";
  let midLevel = "";
  for (const claim of claims || []) {
    const years = Number(claim?.normalized?.years);
    if (Number.isFinite(years) && years > maxYears) maxYears = years;
    const level = claim?.normalized?.level || "";
    if (!seniorLevel && SENIOR_LEVEL.test(level)) seniorLevel = level;
    if (!midLevel && MID_LEVEL.test(level)) midLevel = level;
  }

  if (maxYears >= TIER_YEARS.hard || seniorLevel) {
    const basis = seniorLevel
      ? `claims assert a "${seniorLevel}" level${maxYears ? ` and up to ${maxYears}y experience` : ""} → hard tier`
      : `claims assert up to ${maxYears}y experience → hard tier`;
    return { value: "hard", source: "claim_derived", basis };
  }
  if (maxYears >= TIER_YEARS.medium || midLevel) {
    const basis = maxYears
      ? `claims assert up to ${maxYears}y experience → medium tier`
      : `claims assert a "${midLevel}" level → medium tier`;
    return { value: "medium", source: "claim_derived", basis };
  }
  return {
    value: "easy",
    source: "claim_derived",
    basis: maxYears
      ? `claims assert up to ${maxYears}y experience → easy tier`
      : "claims assert no quantified experience → easy tier",
  };
}

/**
 * Resolve the tier for one session (precedence: recruiter override > claim
 * derivation > paper fixed tier). `claims` may be null for legacy candidates.
 */
function resolveTier({ paper, claims, recruiterOverride }) {
  if (recruiterOverride) {
    return { value: recruiterOverride, source: "recruiter_override", basis: "set by recruiter at assignment" };
  }
  if (paper.difficultyPolicy?.mode === "claim_tiered" && Array.isArray(claims) && claims.length) {
    return deriveTierFromClaims(claims);
  }
  const fixed = paper.difficultyPolicy?.fixedTier || "medium";
  const basis =
    paper.difficultyPolicy?.mode === "claim_tiered"
      ? "no claim graph available — paper's fixed tier used (labelled degradation)"
      : "paper difficulty policy: fixed";
  return { value: fixed, source: "paper_fixed", basis };
}

// --- A2.2 / A3.1 assembly ----------------------------------------------------

// Preference order when a tier's own pool runs short: nearest difficulty first.
const TIER_FALLBACK = {
  easy: ["easy", "medium", "hard"],
  medium: ["medium", "easy", "hard"],
  hard: ["hard", "medium", "easy"],
};

/**
 * Assemble the served item set for one session. Seeded by
 * sha256(sessionId + paperVersion) — per-candidate variation, fully reproducible.
 *
 * Targeting (A3.1): items whose criterionId matches one of the candidate's
 * unverified high-weight claims are prioritized into the sample (never exceeding
 * the paper's structure), and each carries targetsClaimId.
 *
 * @param {object} paper
 * @param {string} sessionId
 * @param {string} tier                       easy|medium|hard
 * @param {Array}  targetClaims               [{ claimId, criterionId }] (may be empty)
 * @returns {Array} assembledItems            [{ itemId, sectionId, order, optionOrder, targetsClaimId }]
 */
function assemble({ paper, sessionId, tier, targetClaims = [] }) {
  const rng = seededRng(`${sessionId}|${paper.version}`);
  const tiered = paper.difficultyPolicy?.mode === "claim_tiered";
  const claimByCriterion = new Map();
  for (const t of targetClaims) {
    if (t?.criterionId && t?.claimId && !claimByCriterion.has(t.criterionId)) {
      claimByCriterion.set(t.criterionId, t.claimId);
    }
  }

  const assembled = [];
  let order = 0;

  for (const section of paper.sections || []) {
    const sectionItems = (paper.items || []).filter((i) => i.sectionId === section.id && i.status === "active");
    const wanted = Math.min(section.servedItemCount, sectionItems.length);
    if (!wanted) continue;

    // Shuffle WITHIN tier-preference ranks so the seeded variation never beats
    // the tier: a hard-tier candidate exhausts the hard pool before any medium
    // item is considered (nearest-difficulty fallback keeps a short pool from
    // silently shrinking the test below the paper's structure).
    const rankOrder = tiered ? TIER_FALLBACK[tier] || [tier] : null;
    const orderWithinRanks = (items) => {
      if (!rankOrder) return seededShuffle(items, rng);
      const out = [];
      for (const difficulty of rankOrder) {
        out.push(...seededShuffle(items.filter((i) => i.difficulty === difficulty), rng));
      }
      // Anything with an unknown difficulty label goes last, deterministically.
      out.push(...seededShuffle(items.filter((i) => !rankOrder.includes(i.difficulty)), rng));
      return out;
    };

    // Targeted items first (priority class), then the rest — sample = first
    // `wanted` of the concatenation; tier preference holds inside both classes.
    const targeted = sectionItems.filter((i) => claimByCriterion.has(i.criterionId));
    const rest = sectionItems.filter((i) => !claimByCriterion.has(i.criterionId));
    const sample = [...orderWithinRanks(targeted), ...orderWithinRanks(rest)].slice(0, wanted);

    for (const item of seededShuffle(sample, rng)) {
      const optionIds = (item.options || []).map((o) => o.id);
      assembled.push({
        itemId: item.id,
        sectionId: section.id,
        order: order++,
        // Ordering items are ALWAYS served shuffled (the sequence is the answer);
        // mcq options are shuffled per candidate so a leaked key sheet is useless.
        optionOrder: optionIds.length ? seededShuffle(optionIds, rng) : [],
        targetsClaimId: claimByCriterion.get(item.criterionId),
      });
    }
  }

  return assembled;
}

module.exports = { seededRng, seededShuffle, deriveTierFromClaims, resolveTier, assemble, TIER_YEARS };
