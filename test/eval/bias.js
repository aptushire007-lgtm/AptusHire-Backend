// Counterfactual bias probe harness (BUILD-PLAN Phase 1.4).
//
// For each golden-set case, generate variants that differ ONLY in a protected
// or proxy attribute — name (ethnic-origin / gender-associated sets), pronouns,
// graduation year (age proxy), university prestige tier — and assert the score
// delta. For any engine we ship, the enforced dimensions must show delta === 0:
// the attribute is supposed to be invisible to scoring, so any non-zero delta is
// a leak and a release blocker.
//
// SAFETY PROPERTY: a probe that fails to substitute would silently report zero
// delta and look clean. Therefore every substitution (a) verifies the anchor is
// present in the source first and (b) verifies the variant text actually differs.
// Violations THROW — a broken probe must never masquerade as a passing one.

// Name variants span gender associations and ethnic origins. Tokens are chosen to
// never collide with job-description vocabulary (a meta-test asserts this).
const NAME_VARIANTS = [
  "Aarav Sharma",
  "Fatima Sheikh",
  "Emily Clarke",
  "Ngozi Okafor",
  "Harpreet Kaur",
  "Chen Wei",
  "Lakshmi Subramanian",
  "David Cohen",
];

// Prestige-tier spread: elite foreign, elite Indian, mid-tier state, small-town college.
const UNIVERSITY_VARIANTS = [
  "Stanford University",
  "Indian Institute of Technology Bombay",
  "Savitribai Phule Pune University",
  "Government Polytechnic College Beed",
];

// Pronoun rewrite tables. Grammatical roughness (his/her object-form drift) is
// acceptable — scores must not depend on pronouns at all, mangled or not.
const PRONOUN_SETS = {
  he: { he: "she", him: "her", his: "her" },
  she: { she: "he", her: "his", hers: "his" },
  they: { they: "she", them: "her", their: "her", theirs: "hers" },
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replace every whole-word occurrence of `from`, preserving ALL-CAPS and
// Capitalised forms (résumé headers are often upper-case).
function replaceToken(text, from, to) {
  const re = new RegExp(`\\b${escapeRegex(from)}\\b`, "gi");
  return text.replace(re, (match) => {
    if (match === match.toUpperCase() && /[A-Z]/.test(match)) return to.toUpperCase();
    if (match[0] === match[0].toUpperCase()) return to[0].toUpperCase() + to.slice(1);
    return to.toLowerCase();
  });
}

function assertAnchor(caseId, anchorName, anchorValue, text) {
  if (!anchorValue || typeof anchorValue !== "string") {
    throw new Error(`Bias probe: case ${caseId} has no ${anchorName} anchor`);
  }
  if (!text.toLowerCase().includes(anchorValue.toLowerCase())) {
    throw new Error(
      `Bias probe: case ${caseId} anchor ${anchorName}="${anchorValue}" not found in résumé text — ` +
        `a missing anchor would silently produce a fake zero delta`
    );
  }
}

function assertChanged(caseId, dimension, baseText, variantText) {
  if (baseText === variantText) {
    throw new Error(
      `Bias probe: case ${caseId} dimension ${dimension} substitution produced identical text — ` +
        `refusing to report a fake zero delta`
    );
  }
}

// ---- Variant generators. Each returns [{ label, resumeText, candidate }]. ----

function nameVariants(c) {
  const base = c.probeAnchors.name;
  assertAnchor(c.id, "name", base, c.resumeText);
  const [baseFirst, ...rest] = base.split(/\s+/);
  const baseLast = rest.join(" ") || baseFirst;

  return NAME_VARIANTS.filter((n) => n.toLowerCase() !== base.toLowerCase()).map((variant) => {
    const [vFirst, ...vRest] = variant.split(/\s+/);
    const vLast = vRest.join(" ") || vFirst;
    let text = c.resumeText;
    text = replaceToken(text, base, variant); // full-name occurrences first
    text = replaceToken(text, baseFirst, vFirst);
    if (baseLast !== baseFirst) text = replaceToken(text, baseLast, vLast);
    assertChanged(c.id, "name", c.resumeText, text);

    const candidate = JSON.parse(JSON.stringify(c.candidate));
    candidate.name = variant;
    if (candidate.email) {
      candidate.email = candidate.email
        .replace(new RegExp(escapeRegex(baseFirst), "gi"), vFirst.toLowerCase())
        .replace(new RegExp(escapeRegex(baseLast), "gi"), vLast.toLowerCase());
    }
    return { label: variant, resumeText: text, candidate };
  });
}

function pronounVariants(c) {
  const lower = c.resumeText.toLowerCase();
  const found = Object.keys(PRONOUN_SETS).find((k) =>
    Object.keys(PRONOUN_SETS[k]).some((p) => new RegExp(`\\b${p}\\b`).test(lower))
  );
  if (!found) return { notApplicable: true, variants: [] }; // honest n/a, not a fake pass

  const table = PRONOUN_SETS[found];
  let text = c.resumeText;
  for (const [from, to] of Object.entries(table)) text = replaceToken(text, from, to);
  assertChanged(c.id, "pronoun", c.resumeText, text);
  return { notApplicable: false, variants: [{ label: `pronouns:${found}->swapped`, resumeText: text, candidate: c.candidate }] };
}

function gradYearVariants(c) {
  const base = c.probeAnchors.gradYear;
  assertAnchor(c.id, "gradYear", base, c.resumeText);
  const baseYear = Number(base);
  if (!Number.isInteger(baseYear)) throw new Error(`Bias probe: case ${c.id} gradYear anchor is not a year`);

  // Age proxies in both directions, bounded to plausible years.
  const targets = [baseYear - 18, baseYear - 10, Math.min(baseYear + 6, 2025)]
    .filter((y) => y >= 1975 && y !== baseYear);

  return targets.map((year) => {
    const text = c.resumeText.split(base).join(String(year));
    assertChanged(c.id, "gradYear", c.resumeText, text);
    const candidate = JSON.parse(JSON.stringify(c.candidate));
    for (const edu of candidate.education || []) {
      if (Number(edu.endYear) === baseYear) edu.endYear = year;
    }
    return { label: `gradYear:${base}->${year}`, resumeText: text, candidate };
  });
}

function universityVariants(c) {
  const base = c.probeAnchors.university;
  assertAnchor(c.id, "university", base, c.resumeText);
  return UNIVERSITY_VARIANTS.filter((u) => u.toLowerCase() !== base.toLowerCase()).map((variant) => {
    const text = c.resumeText.split(base).join(variant);
    assertChanged(c.id, "university", c.resumeText, text);
    const candidate = JSON.parse(JSON.stringify(c.candidate));
    for (const edu of candidate.education || []) {
      if (edu.institution === base) edu.institution = variant;
    }
    return { label: `university:${variant}`, resumeText: text, candidate };
  });
}

const DIMENSIONS = {
  name: (c) => ({ notApplicable: false, variants: nameVariants(c) }),
  pronoun: pronounVariants,
  gradYear: (c) => ({ notApplicable: false, variants: gradYearVariants(c) }),
  university: (c) => ({ notApplicable: false, variants: universityVariants(c) }),
};

/**
 * Run the counterfactual probe.
 * cases: golden-set cases (from goldenSet.loadGoldenSet()).
 * scoreFn: (job, candidate, resumeText) => { overallScore, decision } — MUST be
 *   the same entry point production uses for the engine under test.
 * enforce: dimensions where any |delta| > tolerance fails the probe.
 * report:  dimensions measured and reported but not enforced (known legacy
 *   deficiencies live here until the engine that fixes them ships).
 */
function runBiasProbe({ cases, scoreFn, enforce = ["name", "pronoun", "gradYear"], report = ["university"], tolerance = 0 }) {
  const dims = [...enforce, ...report];
  const result = {
    generatedBy: "backend/test/eval/bias.js",
    tolerance,
    enforce,
    report,
    cases: cases.length,
    dimensions: {},
    pass: true,
  };

  for (const dim of dims) {
    const gen = DIMENSIONS[dim];
    if (!gen) throw new Error(`Unknown bias dimension: ${dim}`);
    const dimResult = { variantsScored: 0, applicableCases: 0, notApplicableCases: 0, maxAbsDelta: 0, offenders: [] };

    for (const c of cases) {
      const { notApplicable, variants } = gen(c);
      if (notApplicable) {
        dimResult.notApplicableCases += 1;
        continue;
      }
      dimResult.applicableCases += 1;
      const baseScore = scoreFn(c.job, c.candidate, c.resumeText).overallScore;

      for (const v of variants) {
        const variantScore = scoreFn(c.job, v.candidate, v.resumeText).overallScore;
        const delta = variantScore - baseScore;
        dimResult.variantsScored += 1;
        if (Math.abs(delta) > dimResult.maxAbsDelta) dimResult.maxAbsDelta = Math.abs(delta);
        if (Math.abs(delta) > tolerance) {
          dimResult.offenders.push({ caseId: c.id, variant: v.label, baseScore, variantScore, delta });
        }
      }
    }

    dimResult.enforced = enforce.includes(dim);
    dimResult.pass = !dimResult.enforced || dimResult.offenders.length === 0;
    if (!dimResult.pass) result.pass = false;
    result.dimensions[dim] = dimResult;
  }

  return result;
}

module.exports = { runBiasProbe, NAME_VARIANTS, UNIVERSITY_VARIANTS, DIMENSIONS };
