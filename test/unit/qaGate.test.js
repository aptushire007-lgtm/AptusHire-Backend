// Phase 7 acceptance gates — the QA gate:
//   - invariant violation ⇒ hard INVARIANT_VIOLATION (fallback + alert path);
//   - injected fabricated evidence ⇒ the critic catches it and the enforce
//     rescore never hardens a rejection (gate law);
//   - counterfactual probe detects a REAL redactor asymmetry (name/month
//     collision) and reports zero-delta on clean inputs;
//   - off/monitor/enforce behave as documented.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const { checkInvariants } = require("../../utils/assessmentInvariants");
const { computeAssessment } = require("../../utils/evidenceScorer");
const qaGate = require("../../services/qaGateService");
const llm = require("../../services/llmService");

// ---------------------------------------------------------------------------
// Shared fixture: a small sound assessment over real spans
// ---------------------------------------------------------------------------

const TEXT = "Built REST APIs in Node.js for a clinic product. Led a team of 5 engineers.";

function fixture() {
  const rubric = {
    criteria: [
      { id: "c1", label: "Node.js backend experience", kind: "must_have", weight: 0.7 },
      { id: "c2", label: "Team leadership", kind: "must_have", weight: 0.3 },
    ],
    thresholds: { advance: 60, review: 45 },
  };
  const claims = [
    {
      id: "k1", type: "skill", subject: "candidate", predicate: "built", object: "REST APIs in Node.js",
      specificity: "specific", verificationStatus: "unverified", selfReportedOnly: true,
      spans: [{ start: 0, end: 30, quote: TEXT.slice(0, 30) }],
    },
    {
      id: "k2", type: "experience", subject: "candidate", predicate: "led", object: "team of 5",
      specificity: "quantified", verificationStatus: "unverified", selfReportedOnly: true,
      spans: [{ start: 49, end: 75, quote: TEXT.slice(49, 75) }],
    },
  ];
  const findings = [
    { criterionId: "c1", status: "satisfied", supportingClaimIds: ["k1"], reasoning: "direct", confidence: 0.9 },
    { criterionId: "c2", status: "satisfied", supportingClaimIds: ["k2"], reasoning: "direct", confidence: 0.9 },
  ];
  const assessment = computeAssessment({ rubric, claims, findings });
  return { rubric, claims, findings, assessment };
}

function candidateDoc() {
  return {
    _id: new mongoose.Types.ObjectId(),
    company: new mongoose.Types.ObjectId(),
    basicDetails: { name: "Priya Verma", email: "priya.verma@example.com", phone: "+91-00000-09999" },
    hostility: { excludedFromModel: [] },
  };
}

const envBackup = {};
beforeEach(() => {
  envBackup.gate = process.env.ATS_QA_GATE;
  envBackup.rate = process.env.QA_COUNTERFACTUAL_SAMPLE_RATE;
  envBackup.llmKeyPresent = llm.isEnabled;
});
afterEach(() => {
  if (envBackup.gate === undefined) delete process.env.ATS_QA_GATE;
  else process.env.ATS_QA_GATE = envBackup.gate;
  if (envBackup.rate === undefined) delete process.env.QA_COUNTERFACTUAL_SAMPLE_RATE;
  else process.env.QA_COUNTERFACTUAL_SAMPLE_RATE = envBackup.rate;
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

test("invariants: a sound assessment has zero violations", () => {
  const { rubric, claims, assessment } = fixture();
  assert.deepEqual(checkInvariants({ assessment, rubric, claims, canonicalText: TEXT }), []);
});

test("invariants: corrupted totals, ghost claims, and unverifiable spans are all caught", () => {
  const { rubric, claims, assessment } = fixture();

  const badScore = { ...assessment, overallScore: 140 };
  assert.ok(checkInvariants({ assessment: badScore, rubric, claims, canonicalText: TEXT }).some((v) => /out of range/.test(v)));

  const badSum = { ...assessment, overallRaw: assessment.overallRaw + 5 };
  assert.ok(checkInvariants({ assessment: badSum, rubric, claims, canonicalText: TEXT }).some((v) => /sum/.test(v)));

  const ghost = {
    ...assessment,
    criterionFindings: assessment.criterionFindings.map((f, i) =>
      i === 0 ? { ...f, supportingClaimIds: ["kGHOST"] } : f
    ),
  };
  assert.ok(checkInvariants({ assessment: ghost, rubric, claims, canonicalText: TEXT }).some((v) => /missing claim/.test(v)));

  const tamperedClaims = claims.map((c, i) => (i === 0 ? { ...c, spans: [{ start: 0, end: 10, quote: "NOT THE TEXT" }] } : c));
  assert.ok(
    checkInvariants({ assessment, rubric, claims: tamperedClaims, canonicalText: TEXT }).some((v) => /does not slice/.test(v))
  );
});

test("ACCEPTANCE GATE: an injected invariant violation triggers the hard INVARIANT_VIOLATION fallback", async () => {
  process.env.ATS_QA_GATE = "monitor";
  const { rubric, claims, assessment } = fixture();
  const corrupted = { ...assessment, overallScore: 999 };
  await assert.rejects(
    qaGate.runGate({
      assessment: corrupted,
      rubric,
      claimGraph: { claims },
      canonicalText: TEXT,
      candidate: candidateDoc(),
    }),
    (err) => err.code === "INVARIANT_VIOLATION" && /out of range/.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// Gate modes + critic
// ---------------------------------------------------------------------------

test("gate off: assessment passes through untouched", async () => {
  process.env.ATS_QA_GATE = "off";
  const { rubric, claims, assessment } = fixture();
  const { assessment: out, qa } = await qaGate.runGate({
    assessment, rubric, claimGraph: { claims }, canonicalText: TEXT, candidate: candidateDoc(),
  });
  assert.equal(out, assessment);
  assert.equal(qa.mode, "off");
});

test("ACCEPTANCE GATE: a fabricated claim is caught by the critic; enforce rescores but never hardens to fail", async () => {
  process.env.ATS_QA_GATE = "enforce";
  process.env.QA_COUNTERFACTUAL_SAMPLE_RATE = "0";
  const { rubric, claims, findings } = fixture();

  // Inject a fabricated high-value claim the matcher "believed".
  const fabricated = {
    id: "k3", type: "experience", subject: "candidate", predicate: "architected", object: "a Fortune 500 platform",
    specificity: "quantified", verificationStatus: "unverified", selfReportedOnly: true,
    spans: [{ start: 0, end: 30, quote: TEXT.slice(0, 30) }], // span exists but does NOT assert this
  };
  const allClaims = [...claims, fabricated];
  const boostedFindings = findings.map((f) =>
    f.criterionId === "c1" ? { ...f, supportingClaimIds: ["k3"] } : f
  );
  const assessment = computeAssessment({ rubric, claims: allClaims, findings: boostedFindings });

  // Stub the LLM: the critic refutes k3; anything else fails loudly.
  const origGenerate = llm.generateJSON;
  const origEnabled = llm.isEnabled;
  llm.generateJSON = async ({ system }) => {
    assert.match(system, /adversarial evidence auditor/i);
    return { data: { refuted: [{ claimId: "k3", reason: "quote does not assert this" }] }, usage: {}, model: "stub", cached: false };
  };
  llm.isEnabled = () => true;
  // The critic path also records usage + reads CompanySettings — stub those.
  const usageService = require("../../services/usageService");
  const CompanySettings = require("../../models/CompanySettings");
  const origRecord = usageService.recordUsage;
  const origFindOne = CompanySettings.findOne;
  usageService.recordUsage = async () => {};
  CompanySettings.findOne = () => ({ select: () => Promise.resolve(null) });

  try {
    const { assessment: out, qa } = await qaGate.runGate({
      assessment, rubric, claimGraph: { claims: allClaims }, canonicalText: TEXT, candidate: candidateDoc(),
    });
    assert.equal(qa.criticDropped, 1, "the fabricated claim must be refuted");
    assert.ok(qa.reasons.some((r) => r.startsWith("critic_refuted:k3")));
    // c1 lost its only support → rescored down. Gate law: worst allowed
    // outcome of a critic downgrade is REVIEW, never an automated fail.
    assert.ok(out.overallScore < assessment.overallScore, "score must drop after refutation");
    assert.notEqual(out.decision, "fail");
  } finally {
    llm.generateJSON = origGenerate;
    llm.isEnabled = origEnabled;
    usageService.recordUsage = origRecord;
    CompanySettings.findOne = origFindOne;
  }
});

test("monitor mode: critic findings are logged but the assessment is not altered", async () => {
  process.env.ATS_QA_GATE = "monitor";
  process.env.QA_COUNTERFACTUAL_SAMPLE_RATE = "0";
  const { rubric, claims, assessment } = fixture();

  const origGenerate = llm.generateJSON;
  const origEnabled = llm.isEnabled;
  llm.generateJSON = async () => ({ data: { refuted: [{ claimId: "k1", reason: "r" }] }, usage: {}, model: "stub", cached: false });
  llm.isEnabled = () => true;
  const usageService = require("../../services/usageService");
  const CompanySettings = require("../../models/CompanySettings");
  const origRecord = usageService.recordUsage;
  const origFindOne = CompanySettings.findOne;
  usageService.recordUsage = async () => {};
  CompanySettings.findOne = () => ({ select: () => Promise.resolve(null) });

  try {
    const { assessment: out, qa } = await qaGate.runGate({
      assessment, rubric, claimGraph: { claims }, canonicalText: TEXT, candidate: candidateDoc(),
    });
    assert.equal(qa.criticDropped, 1);
    assert.equal(out.overallScore, assessment.overallScore, "monitor mode must not change the score");
    assert.equal(out.decision, assessment.decision);
  } finally {
    llm.generateJSON = origGenerate;
    llm.isEnabled = origEnabled;
    usageService.recordUsage = origRecord;
    CompanySettings.findOne = origFindOne;
  }
});

// ---------------------------------------------------------------------------
// Counterfactual probe
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: counterfactual probe reports zero delta on a clean résumé", () => {
  const candidate = candidateDoc();
  const text = "Priya Verma\nBuilt REST APIs in Node.js.\nLed a team of 5 engineers.";
  const result = qaGate.runCounterfactual({ canonicalText: text, candidate, hostilityExclusions: [] });
  assert.equal(result.ran, true);
  assert.equal(result.identical, true, "clean input must produce byte-identical redacted views");
});

test("ACCEPTANCE GATE: a real redactor asymmetry (name = month word) is DETECTED, not hidden", () => {
  // Candidate literally named "May" — the redactor blanks the date token
  // "May" in the base but not in the swapped variant. That asymmetry is a
  // genuine leak signal and must surface.
  const candidate = candidateDoc();
  candidate.basicDetails.name = "May Chen";
  const text = "May Chen\nBackend engineer.\nAcme Corp — May 2022 to June 2023.\nBuilt REST APIs.";
  const result = qaGate.runCounterfactual({ canonicalText: text, candidate, hostilityExclusions: [] });
  assert.equal(result.ran, true);
  assert.equal(result.identical, false, "the asymmetric month/name collision must be detected");
});

// The 2026-08-18 live leak (candidate 6a841d79…), pinned. PDF extraction glues
// style runs, so the header arrived as "Govind Kumar JhaEmail:" — the redactor's
// strict `(?![A-Za-z0-9])` boundary let the glued surname through to the model,
// and the probe's old boundary-less swap regex rewrote it, reporting the miss.
test("REGRESSION 2026-08-18: a name glued to the next label by PDF extraction is redacted AND probe-clean", () => {
  const { planRedactions } = require("../../utils/redactor");
  const candidate = candidateDoc();
  candidate.basicDetails.name = "Govind Kumar Jha";
  candidate.basicDetails.email = "govindkrjha21@example.com";
  const text =
    "Govind Kumar JhaEmail: govindkrjha21@example.com\nGwalior, India\nBuilt REST APIs in Node.js.";

  // The substantive half: the glued surname must be inside a redaction span.
  const gluedJha = text.indexOf("JhaEmail");
  const spans = planRedactions(text, candidate.basicDetails);
  assert.ok(
    spans.some((s) => s.start <= gluedJha && s.end >= gluedJha + 3),
    "the glued surname must not survive redaction"
  );

  // The probe half: with redactor and swap agreeing on the seam, zero delta.
  const result = qaGate.runCounterfactual({ canonicalText: text, candidate, hostilityExclusions: [] });
  assert.equal(result.ran, true);
  assert.equal(result.identical, true, "a correctly-redacted glued name must not read as a leak");
});

// Same incident, second false-alarm class: the candidate's name rides inside a
// whitespace-sensitive token (their LinkedIn slug). A multi-word counterfactual
// replacement would plant a space mid-URL, split the URL_RE match, and report
// the probe's own artifact as a leak — the swap target must stay one token.
test("REGRESSION 2026-08-18: a name inside a URL slug does not trip the probe", () => {
  const candidate = candidateDoc();
  candidate.basicDetails.name = "Govind Kumar Jha";
  const text =
    "Govind Kumar Jha\nLinkedIn: linkedin.com/in/govind-kumar-jha-a64804255\nBuilt REST APIs in Node.js.";
  const result = qaGate.runCounterfactual({ canonicalText: text, candidate, hostilityExclusions: [] });
  assert.equal(result.ran, true);
  assert.equal(result.identical, true, "a URL the redactor fully blanks in both variants is not a leak");
});

test("counterfactual sampling is deterministic per candidate", () => {
  process.env.QA_COUNTERFACTUAL_SAMPLE_RATE = "0.05";
  const { nearBoundary } = qaGate;
  assert.equal(nearBoundary(58, { advance: 60, review: 45 }), true);
  assert.equal(nearBoundary(80, { advance: 60, review: 45 }), false);
  assert.equal(nearBoundary(47, { advance: 60, review: 45 }), true);
});
