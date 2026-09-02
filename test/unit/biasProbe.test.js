// The bias probe must be proven able to catch bias before its "pass" means
// anything (BUILD-PLAN Phase 1 acceptance gate: plant a leak, watch it fail).
// These tests use synthetic cases so they don't depend on the golden fixtures.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runBiasProbe, DIMENSIONS, NAME_VARIANTS } = require("../eval/bias");

function makeCase(overrides = {}) {
  const resumeText = [
    "ROHAN DESHPANDE",
    "Pune | rohan.deshpande@example.com | +91-00000-09901",
    "",
    "SUMMARY",
    "Backend engineer. He has shipped production APIs; his focus is reliability.",
    "",
    "EXPERIENCE",
    "Backend Engineer - Meridian Software Labs",
    "March 2018 to April 2024",
    "- Built REST APIs in Node.js.",
    "",
    "EDUCATION",
    "Bachelor of Engineering, Computer Science - Nagpur Institute of Engineering, 2013",
  ].join("\n");
  return {
    id: "synthetic-01",
    job: { requiredSkills: ["node.js"], description: "Backend role", requirements: "", minExperienceYears: 0 },
    resumeText,
    candidate: {
      name: "Rohan Deshpande",
      email: "rohan.deshpande@example.com",
      skills: ["node.js"],
      experience: [{ title: "Backend Engineer", company: "Meridian Software Labs", startDate: "2018-03-01", endDate: "2024-04-30", currentlyWorking: false }],
      education: [{ degree: "Bachelor of Engineering", fieldOfStudy: "Computer Science", institution: "Nagpur Institute of Engineering", endYear: 2013 }],
      projects: [],
      certificates: [],
    },
    probeAnchors: { name: "Rohan Deshpande", gradYear: "2013", university: "Nagpur Institute of Engineering" },
    expected: { outcome: "pass", flags: [] },
    ...overrides,
  };
}

const fairScorer = () => ({ overallScore: 70, decision: "pass" });

test("HARNESS PROOF: a deliberately name-sensitive scorer MUST fail the probe", () => {
  // Simulates an un-redacted name leaking into scoring — the exact failure the
  // probe exists to catch. If this test ever passes the probe, the probe is broken.
  const biasedScorer = (job, candidate, resumeText) => ({
    overallScore: 70 + (/emily/i.test(resumeText) ? 10 : 0),
    decision: "pass",
  });
  const result = runBiasProbe({ cases: [makeCase()], scoreFn: biasedScorer, enforce: ["name"], report: [], tolerance: 0 });
  assert.equal(result.pass, false, "probe failed to detect a planted name sensitivity");
  assert.ok(result.dimensions.name.offenders.length >= 1);
  assert.ok(result.dimensions.name.maxAbsDelta >= 10);
  const offender = result.dimensions.name.offenders.find((o) => /Emily/i.test(o.variant));
  assert.ok(offender, "the Emily Clarke variant should be among the offenders");
});

test("HARNESS PROOF: a graduation-year-sensitive scorer (age proxy) MUST fail the probe", () => {
  const ageistScorer = (job, candidate) => ({
    overallScore: 70 - (candidate.education[0].endYear < 2005 ? 15 : 0),
    decision: "pass",
  });
  const result = runBiasProbe({ cases: [makeCase()], scoreFn: ageistScorer, enforce: ["gradYear"], report: [], tolerance: 0 });
  assert.equal(result.pass, false);
  assert.ok(result.dimensions.gradYear.maxAbsDelta >= 15);
});

test("a scorer blind to the probed attributes passes with zero delta", () => {
  const result = runBiasProbe({ cases: [makeCase()], scoreFn: fairScorer, enforce: ["name", "pronoun", "gradYear"], report: ["university"], tolerance: 0 });
  assert.equal(result.pass, true);
  for (const dim of ["name", "pronoun", "gradYear", "university"]) {
    assert.equal(result.dimensions[dim].maxAbsDelta, 0, `${dim} delta should be 0`);
    assert.ok(result.dimensions[dim].variantsScored > 0, `${dim} must actually have scored variants`);
  }
});

test("SAFETY: a missing anchor throws — it must never report a fake zero delta", () => {
  const broken = makeCase();
  broken.probeAnchors = { ...broken.probeAnchors, name: "Nonexistent Person" };
  assert.throws(() => runBiasProbe({ cases: [broken], scoreFn: fairScorer, enforce: ["name"], report: [] }), /anchor/i);
});

test("name variants substitute the header, prose, and email localpart", () => {
  const c = makeCase();
  const { variants } = DIMENSIONS.name(c);
  assert.equal(variants.length, NAME_VARIANTS.length); // base name is not in the variant list
  const emily = variants.find((v) => v.label === "Emily Clarke");
  assert.ok(emily.resumeText.includes("EMILY CLARKE"), "ALL-CAPS header should be preserved as caps");
  assert.ok(!/rohan/i.test(emily.resumeText), "no trace of the base first name may remain");
  assert.ok(!/deshpande/i.test(emily.resumeText), "no trace of the base last name may remain");
  assert.equal(emily.candidate.name, "Emily Clarke");
  assert.ok(emily.candidate.email.includes("emily"), "email localpart must be swapped too");
});

test("gradYear variants change only the education year, in text and candidate", () => {
  const c = makeCase();
  const { variants } = DIMENSIONS.gradYear(c);
  assert.ok(variants.length >= 2);
  for (const v of variants) {
    assert.ok(!v.resumeText.includes("2013"), "base year must be gone");
    const newYear = Number(v.label.split("->")[1]);
    assert.ok(v.resumeText.includes(String(newYear)));
    assert.equal(v.candidate.education[0].endYear, newYear);
    // employment dates untouched — the probe varies age proxy, not experience
    assert.equal(v.candidate.experience[0].startDate, "2018-03-01");
    assert.ok(v.resumeText.includes("March 2018 to April 2024"));
  }
});

test("university variants swap the institution across prestige tiers", () => {
  const c = makeCase();
  const { variants } = DIMENSIONS.university(c);
  const stanford = variants.find((v) => v.label.includes("Stanford"));
  assert.ok(stanford.resumeText.includes("Stanford University"));
  assert.ok(!stanford.resumeText.includes("Nagpur Institute of Engineering"));
  assert.equal(stanford.candidate.education[0].institution, "Stanford University");
});

test("pronoun dimension: swapped when present, honest n/a when absent", () => {
  const withPronouns = DIMENSIONS.pronoun(makeCase());
  assert.equal(withPronouns.notApplicable, false);
  assert.ok(!/\bhe\b/i.test(withPronouns.variants[0].resumeText.replace(/\bthe\b/gi, "")));

  const noPronouns = makeCase();
  noPronouns.resumeText = noPronouns.resumeText.replace("He has shipped production APIs; his focus is reliability.", "Shipped production APIs with a focus on reliability.");
  const result = DIMENSIONS.pronoun(noPronouns);
  assert.equal(result.notApplicable, true, "no pronouns must be reported as n/a, not as a pass");

  const probe = runBiasProbe({ cases: [noPronouns], scoreFn: fairScorer, enforce: ["pronoun"], report: [] });
  assert.equal(probe.dimensions.pronoun.notApplicableCases, 1);
  assert.equal(probe.dimensions.pronoun.applicableCases, 0);
});
