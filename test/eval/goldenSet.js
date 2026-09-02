// Loader for the Phase 1 golden set (see test/fixtures/FIXTURES-SPEC.md).
// Hard-fails on structural problems (missing pair, bad JSON, unknown job ref) —
// a broken fixture must never silently shrink the evaluation set.

const fs = require("fs");
const path = require("path");

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");
const GOLDEN_DIR = path.join(FIXTURES_DIR, "golden");
const JOBS_DIR = path.join(FIXTURES_DIR, "jobs");

// Bucket → required case count. The composition is part of the plan, not a suggestion:
// CI asserts these exact counts so nobody quietly drops the adversarial buckets.
const BUCKET_COUNTS = {
  clear_pass: 8,
  clear_fail: 8,
  borderline: 8,
  keyword_stuffed: 4,
  prompt_injected: 4,
  vocab_mismatch: 4,
  career_gap: 4,
};

const VALID_OUTCOMES = new Set(["pass", "fail", "review"]);
const VALID_FLAGS = new Set(["keyword_stuffing", "prompt_injection", "vocabulary_mismatch", "career_gap"]);

function loadJobs() {
  const jobs = new Map();
  for (const file of fs.readdirSync(JOBS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(/\.json$/, "");
    jobs.set(id, JSON.parse(fs.readFileSync(path.join(JOBS_DIR, file), "utf8")));
  }
  return jobs;
}

function loadGoldenSet() {
  const jobs = loadJobs();
  const files = fs.existsSync(GOLDEN_DIR) ? fs.readdirSync(GOLDEN_DIR) : [];
  const stems = [...new Set(
    files
      .filter((f) => f.endsWith(".resume.txt") || f.endsWith(".expected.json"))
      .map((f) => f.replace(/\.(resume\.txt|expected\.json)$/, ""))
  )].sort();

  const cases = [];
  for (const stem of stems) {
    const resumePath = path.join(GOLDEN_DIR, `${stem}.resume.txt`);
    const expectedPath = path.join(GOLDEN_DIR, `${stem}.expected.json`);
    if (!fs.existsSync(resumePath)) throw new Error(`Fixture ${stem}: missing .resume.txt`);
    if (!fs.existsSync(expectedPath)) throw new Error(`Fixture ${stem}: missing .expected.json`);

    const resumeText = fs.readFileSync(resumePath, "utf8");
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
    } catch (err) {
      throw new Error(`Fixture ${stem}: invalid JSON in .expected.json (${err.message})`);
    }

    const job = jobs.get(meta.job);
    if (!job) throw new Error(`Fixture ${stem}: unknown job ref "${meta.job}"`);

    cases.push({
      id: stem,
      bucket: meta.bucket,
      jobId: meta.job,
      job,
      resumeText,
      candidate: meta.candidate,
      probeAnchors: meta.probeAnchors,
      expected: meta.expected,
    });
  }
  return cases;
}

module.exports = { loadGoldenSet, loadJobs, BUCKET_COUNTS, VALID_OUTCOMES, VALID_FLAGS, GOLDEN_DIR, JOBS_DIR, FIXTURES_DIR };
