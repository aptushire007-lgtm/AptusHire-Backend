// Golden-set integrity: the fixture composition is part of the evaluation's
// design (BUILD-PLAN Phase 1.2) — these tests stop anyone from quietly dropping
// the adversarial buckets or breaking the invariants the bias probe relies on.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { loadGoldenSet, loadJobs, BUCKET_COUNTS, VALID_OUTCOMES, VALID_FLAGS } = require("../eval/goldenSet");
const { NAME_VARIANTS } = require("../eval/bias");

const NN_BUCKET = (nn) => {
  if (nn >= 1 && nn <= 8) return "clear_pass";
  if (nn <= 16) return "clear_fail";
  if (nn <= 24) return "borderline";
  if (nn <= 28) return "keyword_stuffed";
  if (nn <= 32) return "prompt_injected";
  if (nn <= 36) return "vocab_mismatch";
  if (nn <= 40) return "career_gap";
  return null;
};

const BUCKET_FLAG = {
  keyword_stuffed: "keyword_stuffing",
  prompt_injected: "prompt_injection",
  vocab_mismatch: "vocabulary_mismatch",
  career_gap: "career_gap",
};

const BUCKET_OUTCOMES = {
  clear_pass: ["pass"],
  clear_fail: ["fail"],
  borderline: ["review"],
  keyword_stuffed: ["fail"],
  prompt_injected: ["review"],
  vocab_mismatch: ["pass"],
  career_gap: ["pass", "review"],
};

const cases = loadGoldenSet();

test("golden set has exactly 40 cases with the planned bucket composition", () => {
  assert.equal(cases.length, 40, `have ${cases.length} cases: ${cases.map((c) => c.id).join(", ")}`);
  const counts = {};
  for (const c of cases) counts[c.bucket] = (counts[c.bucket] || 0) + 1;
  assert.deepEqual(counts, BUCKET_COUNTS);
});

test("case ids follow NN-bucket-slug and NN ranges match the spec's numbering", () => {
  for (const c of cases) {
    const match = c.id.match(/^(\d{2})-([a-z_]+)-[a-z0-9-]+$/);
    assert.ok(match, `${c.id}: id must be NN-bucket-slug`);
    const nn = Number(match[1]);
    assert.equal(match[2], c.bucket, `${c.id}: filename bucket must equal expected.json bucket`);
    assert.equal(c.bucket, NN_BUCKET(nn), `${c.id}: number ${nn} belongs to bucket ${NN_BUCKET(nn)}`);
  }
});

test("labels: outcome and flags are valid and consistent with the bucket", () => {
  for (const c of cases) {
    assert.ok(VALID_OUTCOMES.has(c.expected.outcome), `${c.id}: bad outcome ${c.expected.outcome}`);
    assert.ok(Array.isArray(c.expected.flags), `${c.id}: flags must be an array`);
    for (const f of c.expected.flags) assert.ok(VALID_FLAGS.has(f), `${c.id}: unknown flag ${f}`);
    assert.ok(BUCKET_OUTCOMES[c.bucket].includes(c.expected.outcome), `${c.id}: bucket ${c.bucket} cannot have outcome ${c.expected.outcome}`);
    const requiredFlag = BUCKET_FLAG[c.bucket];
    if (requiredFlag) {
      assert.ok(c.expected.flags.includes(requiredFlag), `${c.id}: bucket ${c.bucket} requires flag ${requiredFlag}`);
    } else {
      assert.equal(c.expected.flags.length, 0, `${c.id}: bucket ${c.bucket} must have no flags`);
    }
    assert.ok(typeof c.expected.rationale === "string" && c.expected.rationale.length > 20, `${c.id}: rationale required`);
  }
});

test("candidate objects are complete and date-stable (no clock dependence)", () => {
  for (const c of cases) {
    const cand = c.candidate;
    assert.ok(cand && cand.name && cand.email && cand.phone, `${c.id}: candidate name/email/phone required`);
    assert.ok(Array.isArray(cand.skills) && cand.skills.length > 0, `${c.id}: candidate.skills required`);
    assert.ok(Array.isArray(cand.experience) && cand.experience.length > 0, `${c.id}: experience required`);
    for (const exp of cand.experience) {
      assert.match(exp.startDate, /^\d{4}-\d{2}-\d{2}$/, `${c.id}: startDate must be YYYY-MM-DD`);
      assert.match(exp.endDate, /^\d{4}-\d{2}-\d{2}$/, `${c.id}: endDate must be YYYY-MM-DD (no open ranges)`);
      assert.equal(exp.currentlyWorking, false, `${c.id}: currentlyWorking must be false — scores must not depend on the clock`);
      assert.ok(new Date(exp.startDate) < new Date(exp.endDate), `${c.id}: ${exp.company} dates out of order`);
    }
    assert.ok(!/(to|[–—-])\s*present\b/i.test(c.resumeText), `${c.id}: résumé text must not contain an open "to Present" range`);
    assert.ok(Array.isArray(cand.education) && cand.education.length > 0, `${c.id}: education required`);
  }
});

test("probe anchors: present, verbatim in text, and collision-free", () => {
  for (const c of cases) {
    const a = c.probeAnchors;
    assert.ok(a && a.name && a.gradYear && a.university, `${c.id}: probeAnchors {name, gradYear, university} required`);
    assert.equal(a.name, c.candidate.name, `${c.id}: anchor name must equal candidate.name`);
    assert.ok(c.resumeText.toLowerCase().includes(a.name.toLowerCase()), `${c.id}: name anchor not found in text`);

    // gradYear: in the text, matches education, and never collides with employment years —
    // otherwise the bias probe's year substitution would mangle experience dates.
    assert.match(a.gradYear, /^\d{4}$/, `${c.id}: gradYear anchor must be a 4-digit year`);
    assert.ok(c.resumeText.includes(a.gradYear), `${c.id}: gradYear anchor not found in text`);
    assert.equal(Number(c.candidate.education[0].endYear), Number(a.gradYear), `${c.id}: education[0].endYear must equal gradYear anchor`);
    const employmentYears = new Set();
    for (const exp of c.candidate.experience) {
      employmentYears.add(exp.startDate.slice(0, 4));
      employmentYears.add(exp.endDate.slice(0, 4));
    }
    assert.ok(!employmentYears.has(a.gradYear), `${c.id}: gradYear ${a.gradYear} collides with an employment year — probe substitution would corrupt experience dates`);
    // Every line containing the gradYear must be an education line (identified by the
    // university name) so the probe's blanket year-substitution stays education-only.
    for (const line of c.resumeText.split("\n")) {
      if (line.includes(a.gradYear)) {
        assert.ok(line.includes(a.university), `${c.id}: gradYear appears on a non-education line: "${line.trim()}"`);
      }
    }

    // university: exactly once, and consistent with the candidate object.
    assert.equal(a.university, c.candidate.education[0].institution, `${c.id}: university anchor must equal education[0].institution`);
    const occurrences = c.resumeText.split(a.university).length - 1;
    assert.equal(occurrences, 1, `${c.id}: university anchor must appear exactly once (found ${occurrences})`);

    // The anchor name must not collide with this job's vocabulary — a collision
    // would make the legacy keyword engine legitimately name-sensitive and the
    // enforced name dimension would fail for a fixture reason, not an engine reason.
    const jdText = `${c.job.description} ${c.job.requirements} ${(c.job.requiredSkills || []).join(" ")}`.toLowerCase();
    for (const token of a.name.toLowerCase().split(/\s+/)) {
      assert.ok(!new RegExp(`\\b${token}\\b`).test(jdText), `${c.id}: name token "${token}" appears in the job description`);
    }
  }
});

test("bias-probe name variants never collide with any job's vocabulary", () => {
  const jobs = loadJobs();
  for (const [jobId, job] of jobs) {
    const jdText = `${job.description} ${job.requirements} ${(job.requiredSkills || []).join(" ")}`.toLowerCase();
    for (const name of NAME_VARIANTS) {
      for (const token of name.toLowerCase().split(/\s+/)) {
        assert.ok(!new RegExp(`\\b${token}\\b`).test(jdText), `probe name token "${token}" appears in job ${jobId} — variants would change keyword scores`);
      }
    }
  }
});

test("text and candidate JSON tell the same story (email, phone, employers)", () => {
  for (const c of cases) {
    assert.ok(c.resumeText.includes(c.candidate.email), `${c.id}: candidate email must appear in résumé text`);
    assert.ok(c.resumeText.includes(c.candidate.phone), `${c.id}: candidate phone must appear in résumé text`);
    for (const exp of c.candidate.experience) {
      assert.ok(c.resumeText.toLowerCase().includes(exp.company.toLowerCase()), `${c.id}: employer "${exp.company}" missing from résumé text`);
    }
  }
});

test("vocab_mismatch cases contain none of their job's required-skill tokens", () => {
  for (const c of cases.filter((x) => x.bucket === "vocab_mismatch")) {
    const haystack = [
      c.resumeText,
      (c.candidate.skills || []).join(" "),
      (c.candidate.projects || []).map((p) => `${p.title} ${p.description} ${p.techStack}`).join(" "),
    ]
      .join(" ")
      .toLowerCase();
    for (const skill of c.job.requiredSkills) {
      const re = new RegExp(`(?<![a-z0-9])${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i");
      assert.ok(!re.test(haystack), `${c.id}: required-skill token "${skill}" leaked into a vocab_mismatch fixture`);
    }
  }
});

test("keyword_stuffed cases do contain every required-skill token (the stuffing)", () => {
  for (const c of cases.filter((x) => x.bucket === "keyword_stuffed")) {
    const lower = c.resumeText.toLowerCase();
    for (const skill of c.job.requiredSkills) {
      const re = new RegExp(`(?<![a-z0-9])${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i");
      assert.ok(re.test(lower), `${c.id}: keyword_stuffed fixture must parrot "${skill}"`);
    }
  }
});
