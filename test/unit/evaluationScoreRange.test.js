// The model must never emit the number that decides a hiring outcome.
//
// `evaluation.overallScore` is the one model-supplied integer in this system that reaches a
// decision unmediated: interviewReportEngine.computeVerdict thresholds it directly into
// ADVANCE / REVIEW / CLEAR_REJECT, and CLEAR_REJECT is stamped "Confidence: High". Its JSON schema
// declared `{ type: "integer" }` with no bounds, and makeEvaluation returned `{ ...data }`, so
// whatever integer came back became the score. `clampScore` existed but was only ever applied to
// per-answer scores.
//
// Clamping is NOT the fix, and this file pins that too. A provider returning -50 or 5000 has not
// judged the candidate harshly or generously — it has failed to answer. Clamping -50 to 0 converts
// a provider malfunction into a confident automated rejection of a real person. So an out-of-range
// score is treated as a malformed response and the deterministic fallback runs instead, which
// never emits an adverse recommendation (docs/CLAUDE.md rules 1 and 6).
//
// No DB and no network: makeEvaluation takes every dependency as an argument, so the LLM module
// and the usage meter are monkey-patched per test in the style evidenceClips/qaGate already use.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const llm = require("../../services/llmService");
const usageService = require("../../services/usageService");
const aiInterview = require("../../services/aiInterviewService");
const { EVALUATION_SCHEMA } = require("../../utils/interviewPrompts");
const { computeVerdict, INTERVIEW_PASS_THRESHOLD } = require("../../utils/interviewReportEngine");

const SCORE_FIELDS = ["overallScore", "communication", "technicalKnowledge", "problemSolving"];

const originalGenerate = llm.generateJSON;
const originalRecord = usageService.recordUsage;

// A transcript with two scored answers, so the deterministic fallback has something real to
// average and we can tell its output apart from the model's.
function makeAi() {
  return {
    turns: [
      { role: "ai", kind: "question", text: "Walk me through the migration." },
      { role: "candidate", kind: "answer", text: "We moved ingestion onto Kafka over six months.", answerScore: 70 },
      { role: "ai", kind: "question", text: "What broke?" },
      { role: "candidate", kind: "answer", text: "Consumer lag during the cutover; we shipped a replay tool.", answerScore: 80 },
    ],
  };
}

const ARGS = () => ({
  session: { _id: new mongoose.Types.ObjectId(), company: new mongoose.Types.ObjectId() },
  candidate: { _id: new mongoose.Types.ObjectId(), basicDetails: { name: "Priya Raman" } },
  job: { title: "Backend Engineer", description: "Kafka, Node, Postgres" },
  settings: null,
  ai: makeAi(),
  useAi: true,
});

const GOOD = {
  overallScore: 74,
  communication: 70,
  technicalKnowledge: 78,
  problemSolving: 72,
  strengths: ["clear ownership of the cutover"],
  weaknesses: ["thin on the rollback plan"],
  missingSkills: [],
  recommendation: "hire",
  summary: "Solid, concrete answers grounded in work they did.",
};

function stubModel(data) {
  llm.generateJSON = async () => ({
    data,
    usage: { promptTokens: 100, completionTokens: 50, costCents: 0.01 },
    model: "test/model-1",
    cached: false,
  });
}

test.beforeEach(() => {
  usageService.recordUsage = async () => {};
});

test.after(() => {
  llm.generateJSON = originalGenerate;
  usageService.recordUsage = originalRecord;
});

test("the schema itself bounds every score field to 0-100", () => {
  for (const field of SCORE_FIELDS) {
    const spec = EVALUATION_SCHEMA.properties[field];
    assert.equal(spec.type, "integer", `${field} must be an integer`);
    assert.equal(spec.minimum, 0, `${field} must declare minimum 0 — this is the provider's own guard`);
    assert.equal(spec.maximum, 100, `${field} must declare maximum 100`);
  }
});

test("a well-formed evaluation is passed through untouched", async () => {
  stubModel({ ...GOOD });
  const out = await aiInterview.makeEvaluation(ARGS());
  assert.equal(out.generatedBy, "ai");
  assert.equal(out.overallScore, 74);
  assert.equal(out.recommendation, "hire");
});

// One case per way a provider can hand back something that is not a score. Labelled rather than
// stringified because JSON.stringify renders NaN and undefined as "null" — which would have
// collided three cases into one name and hidden whichever of them regressed.
//
// `null`, `undefined` and `""` are the dangerous ones and the reason the guard tests
// `typeof === "number"` instead of coercing: Number(null) and Number("") are both 0, and 0 is a
// legal score, so a coercing check turns a MISSING evaluation into the lowest possible one — which
// computeVerdict reads as CLEAR_REJECT · confidence High. An absence must never become a rejection.
const UNUSABLE = [
  ["far above the scale", 5000],
  ["negative", -50],
  ["one over", 101],
  ["one under", -1],
  ["NaN", Number.NaN],
  ["null", null],
  ["undefined", undefined],
  ["a numeric string", "82"],
  ["an empty string", ""],
  ["a boolean", false],
];

for (const [label, bad] of UNUSABLE) {
  test(`overallScore: ${label} never becomes a score — the deterministic fallback runs instead`, async () => {
    stubModel({ ...GOOD, overallScore: bad });
    const out = await aiInterview.makeEvaluation(ARGS());

    assert.equal(out.generatedBy, "fallback", "an unusable score must not be dressed up as an AI evaluation");
    // The fallback computes the overall in CODE from the per-answer scores: mean(70, 80).
    assert.equal(out.overallScore, 75);
    // And it never carries an adverse call (rule 6).
    assert.equal(out.recommendation, "review");
    assert.notEqual(out.overallScore, bad);
  });
}

test("an unusable value in ANY of the four score fields degrades the whole evaluation", async () => {
  for (const field of SCORE_FIELDS) {
    stubModel({ ...GOOD, [field]: 420 });
    const out = await aiInterview.makeEvaluation(ARGS());
    assert.equal(out.generatedBy, "fallback", `${field} out of range must not be kept`);
  }
});

// The reason all of the above matters, stated as the property it protects.
test("ACCEPTANCE GATE: no out-of-range model output can produce an automated rejection", async () => {
  for (const [label, bad] of [["negative", -50], ["NaN", Number.NaN], ["null", null], ["empty string", ""], ["undefined", undefined]]) {
    stubModel({ ...GOOD, overallScore: bad, recommendation: "no_hire" });
    const out = await aiInterview.makeEvaluation(ARGS());

    const verdict = computeVerdict({
      responsiveCount: 2,
      totalAnswers: 2,
      declinedCount: 0,
      endedEarly: false,
      halted: false,
      abandoned: false,
      integrityTerminated: false,
      audioUnreliable: false,
      engineRan: out.generatedBy === "ai",
      overallScore: out.overallScore,
    });

    assert.notEqual(verdict.verdict, "CLEAR_REJECT", `overallScore: ${label} must never reach an automated rejection`);
    assert.equal(out.recommendation, "review");
  }

  // Control: the guard has not simply disabled rejection. A genuine, in-range low score still
  // reaches CLEAR_REJECT, because that is a measurement and this file is not about softening it.
  stubModel({ ...GOOD, overallScore: INTERVIEW_PASS_THRESHOLD - 25, recommendation: "no_hire" });
  const real = await aiInterview.makeEvaluation(ARGS());
  assert.equal(real.generatedBy, "ai");
  const realVerdict = computeVerdict({
    responsiveCount: 2,
    totalAnswers: 2,
    declinedCount: 0,
    endedEarly: false,
    halted: false,
    abandoned: false,
    integrityTerminated: false,
    audioUnreliable: false,
    engineRan: true,
    overallScore: real.overallScore,
  });
  assert.equal(realVerdict.verdict, "CLEAR_REJECT");
});
