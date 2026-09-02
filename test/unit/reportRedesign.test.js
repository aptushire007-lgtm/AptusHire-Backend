// REPORT-REDESIGN workstreams A + B1 + C5 (backend halves) — the fixes for a report where
// "6 of 7 Untested" was the DESIGNED output: probes tested only what the résumé claimed, capped
// at 4, in arrival order, and the matrix read probes alone. Every test here pins either a new
// coverage path or a guard that keeps the new path from overreaching.
//
// Pure and offline: no DB, no network, no model.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const resumeAnchors = require("../../utils/resumeAnchors");
const probeService = require("../../services/probeService");
const proctoring = require("../../utils/proctoring");
const { probePhrasingIssues } = require("../../utils/probePrompts");
const {
  buildCoverageMatrix,
  untestedCauseFor,
  CELL,
} = require("../../utils/interviewReportEngine");

// ---------------------------------------------------------------------------
// A1 — anchors bind to criteria, and a covered anchor moves a cell to partial ONLY
// ---------------------------------------------------------------------------

const CRITERIA = [
  { criterionId: "c-python", label: "Programming skills in Python", kind: "must_have", weight: 0.3, status: "absent", supportingClaimIds: [] },
  { criterionId: "c-ml", label: "Understanding of machine learning concepts", kind: "must_have", weight: 0.5, status: "satisfied", supportingClaimIds: ["cl1"] },
  { criterionId: "c-cloud", label: "Experience with cloud platforms", kind: "nice_to_have", weight: 0.2, status: "absent", supportingClaimIds: [] },
];

test("A1.1: an anchor about Python binds to the Python criterion — deterministically, weightiest tie first", () => {
  const id = resumeAnchors.criterionForAnchor({ term: "Inventory App", focus: "Python" }, CRITERIA);
  assert.equal(id, "c-python");
  // Nothing matches → unbound, exactly as before the feature.
  assert.equal(resumeAnchors.criterionForAnchor({ term: "Acme Corp", focus: "" }, CRITERIA), "");
});

function matrixWith(anchors) {
  return buildCoverageMatrix({
    criterionFindings: CRITERIA,
    perCriterion: [],
    probes: [],
    anchors,
  });
}

test("A1.2: a COVERED bound anchor moves untested → partial; asked-only and unbound anchors change nothing", () => {
  const covered = matrixWith([{ criterionId: "c-python", term: "Python", status: "covered" }]);
  const row = covered.rows.find((r) => r.criterionId === "c-python");
  assert.equal(row.interview, CELL.partial);
  assert.equal(row.anchorCovered, true);
  assert.match(row.evidence, /came up in the interview/i);

  // `asked` is not `covered` — a question that went out mid-timeout did not cover its subject.
  const asked = matrixWith([{ criterionId: "c-python", term: "Python", status: "asked" }]);
  assert.equal(asked.rows.find((r) => r.criterionId === "c-python").interview, CELL.untested);

  // THE ACCEPTANCE GATE: an anchor with no criterionId leaves the matrix byte-identical.
  const unbound = matrixWith([{ criterionId: "", term: "Python", status: "covered" }]);
  assert.deepEqual(unbound, matrixWith([]));
});

test("A1.3: an anchor can never overwrite a probe verdict — partial is its ceiling", () => {
  const m = buildCoverageMatrix({
    criterionFindings: CRITERIA,
    perCriterion: [],
    probes: [{ criterionId: "c-python", claimId: "cl9", verdict: "contradicted", question: "q", answerQuote: "a" }],
    anchors: [{ criterionId: "c-python", term: "Python", status: "covered" }],
  });
  const row = m.rows.find((r) => r.criterionId === "c-python");
  assert.equal(row.interview, CELL.contradicted, "a probe verdict outranks an anchor in both directions");
});

test("A1.4: totals.untouched counts rows with neither probe nor covered anchor", () => {
  const m = matrixWith([{ criterionId: "c-python", term: "Python", status: "covered" }]);
  assert.equal(m.totals.untouched, 2, "c-ml and c-cloud were never touched");
  assert.equal(m.totals.neverProbed, 3, "the stricter instrument metric is unchanged — anchors are not probes");
});

// ---------------------------------------------------------------------------
// A2 — gap-probes: requirements the résumé is silent on get asked about
// ---------------------------------------------------------------------------

test("A2.1: an absent, unclaimed requirement generates a neutral gap-probe; satisfied ones do not", () => {
  const gaps = probeService.gapProbesFor(CRITERIA, 4);
  const ids = gaps.map((g) => g.criterionId);
  assert.deepEqual(ids, ["c-python", "c-cloud"], "absent+unclaimed only, weightiest first");
  for (const g of gaps) {
    assert.equal(g.isGap, true);
    assert.equal(g.claimId, `gap-${g.criterionId}`);
    assert.deepEqual(probePhrasingIssues(g.question), [], "must pass the same neutrality gate as claim-probes");
    assert.match(g.question, /if any/i, "'nothing' must be an explicitly fine answer");
    assert.doesNotMatch(g.question, /résumé|resume|cv\b/i, "never references the résumé's silence");
  }
});

test("A2.2: the label is de-jargoned into a topic", () => {
  assert.equal(probeService.gapTopicFromLabel("Experience with deep learning frameworks"), "deep learning frameworks");
  assert.equal(probeService.gapTopicFromLabel("Strong problem-solving and analytical thinking skills"), "problem-solving and analytical thinking skills");
  assert.equal(probeService.gapTopicFromLabel("Knowledge of data structures and algorithms"), "data structures and algorithms");
});

test("A2.3: THE GUARD — a gap-probe verdict can never be contradicted", () => {
  const items = [
    { claimId: "gap-c-python", isGap: true, answerText: "I have not really used it much to be honest." },
    { claimId: "cl-real", isGap: false, answerText: "I built the whole thing in React actually." },
  ];
  const verdicts = probeService.sanitiseVerdicts(
    [
      { claimId: "gap-c-python", verdict: "contradicted", answerQuote: "not really used it", reasoning: "no experience" },
      { claimId: "cl-real", verdict: "contradicted", answerQuote: "I built the whole thing in React actually.", reasoning: "claim was Node" },
    ],
    items
  );
  const gap = verdicts.find((v) => v.claimId === "gap-c-python");
  assert.equal(gap.verdict, "inconclusive", "downgraded in code, not in the prompt");
  assert.match(gap.reasoning, /not a permitted verdict/i);
  // A real claim-probe still can be contradicted — the ban is exactly as narrow as its reason.
  assert.equal(verdicts.find((v) => v.claimId === "cl-real").verdict, "contradicted");
});

test("A2.4: a gap verdict cannot reach the ClaimGraph — the claimId matches nothing", () => {
  const claims = [{ id: "cl1", verificationStatus: "unverified" }];
  const changed = probeService.applyVerdictsToClaims(claims, [
    { claimId: "gap-c-python", verdict: "verified" },
  ]);
  assert.equal(changed, 0);
  assert.equal(claims[0].verificationStatus, "unverified");
});

// ---------------------------------------------------------------------------
// A3 + A4 — the budgeted cap (flag-gated) and weight-ordered targets
// ---------------------------------------------------------------------------

test("A3.1: with no flag set, the cap is exactly the old PROBE_CAP", () => {
  delete process.env.PROBE_COVERAGE_BUDGET;
  assert.equal(probeService.probeCapFor(CRITERIA), probeService.PROBE_CAP);
});

test("A3.2: with a budget, the cap grows to reach the weight share, bounded by the ceiling", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ criterionId: `c${i}`, weight: 1 / 12 }));
  process.env.PROBE_COVERAGE_BUDGET = "0.7";
  try {
    // 12 equal criteria: 70% of weight needs ⌈0.7×12⌉ = 9 → clamped to the ceiling of 8.
    assert.equal(probeService.probeCapFor(many), probeService.PROBE_HARD_CEILING);
    // A top-heavy rubric reaches the share early and stays short.
    const topHeavy = [{ criterionId: "a", weight: 0.5 }, { criterionId: "b", weight: 0.25 }, { criterionId: "c", weight: 0.25 }];
    assert.equal(probeService.probeCapFor(topHeavy), probeService.PROBE_CAP, "2 criteria reach 0.7 but the floor is the old cap");
  } finally {
    delete process.env.PROBE_COVERAGE_BUDGET;
  }
});

test("A4.1: probe targets are ranked by criterion weight, stable on ties", () => {
  const targets = [
    { claim: { id: "x" }, criterionId: "c-cloud" },
    { claim: { id: "y" }, criterionId: "c-ml" },
    { claim: { id: "z" }, criterionId: "c-python" },
    { claim: { id: "w" }, criterionId: "c-cloud" },
  ];
  const ranked = probeService.rankTargetsByCriterionWeight(targets, CRITERIA);
  assert.deepEqual(
    ranked.map((t) => t.claim.id),
    ["y", "z", "x", "w"],
    "0.5 first, then 0.3, then the two 0.2s in arrival order"
  );
});

// ---------------------------------------------------------------------------
// B1 — correlated flags collapse to findings, labelled, band withheld on fault
// ---------------------------------------------------------------------------

test("B1.1: many raw events collapse to distinct findings WITH the collapse labelled (§10.4)", () => {
  const counts = { gaze_away: 40, tab_switch: 20, face_absent: 7 };
  const out = proctoring.collapseForDisplay(counts);
  assert.equal(out.distinctFindings, 3);
  assert.equal(out.totalEvents, 67);
  assert.match(out.collapsedNote, /67 raw events collapsed to 3 distinct findings/);
  assert.equal(out.bandWithheld, false);
});

test("B1.2: a session with a technical fault withholds the band and attributes camera noise to the fault", () => {
  const out = proctoring.collapseForDisplay({ face_absent: 12, camera_lost: 3, paste: 1 }, { technicalFault: true });
  assert.equal(out.bandWithheld, true);
  assert.match(out.bandWithheldReason, /not the candidate/i);
  const byType = new Map(out.findings.map((f) => [f.type, f]));
  assert.equal(byType.get("face_absent").attributedToFault, true);
  assert.equal(byType.get("camera_lost").attributedToFault, true);
  assert.equal(byType.get("paste").attributedToFault, false, "conduct events are never blamed on the fault");
});

// ---------------------------------------------------------------------------
// C5 — every untested row carries a machine-readable cause
// ---------------------------------------------------------------------------

test("C5.1: the cause taxonomy — silence, slot, audio, unresolved, anchor-only; null once tested", () => {
  const base = { probeVerdicts: [], probeCount: 0, claimed: false, anchorCovered: false, audioUnreliable: false };
  assert.equal(untestedCauseFor(base), "resume_silent");
  assert.equal(untestedCauseFor({ ...base, claimed: true }), "no_probe_slot");
  assert.equal(untestedCauseFor({ ...base, anchorCovered: true }), "anchor_only");
  assert.equal(untestedCauseFor({ ...base, probeCount: 1 }), "asked_unresolved");
  assert.equal(untestedCauseFor({ ...base, probeCount: 1, audioUnreliable: true }), "asked_audio_failed");
  assert.equal(untestedCauseFor({ ...base, probeCount: 1, probeVerdicts: ["verified"] }), null);
});

test("C5.2: every untested matrix row carries a non-empty cause (the acceptance gate)", () => {
  const m = buildCoverageMatrix({
    criterionFindings: CRITERIA,
    perCriterion: [],
    probes: [{ criterionId: "c-ml", claimId: "cl1", question: "q", status: "asked" }],
    anchors: [],
  });
  for (const row of m.rows) {
    if (row.interview === CELL.untested || (row.probeCount > 0 && !row.decidingProbe)) {
      assert.ok(row.untestedCause, `row ${row.criterionId} must say why it went untested`);
    }
  }
  assert.equal(m.rows.find((r) => r.criterionId === "c-ml").untestedCause, "asked_unresolved");
  assert.equal(m.rows.find((r) => r.criterionId === "c-python").untestedCause, "resume_silent");
});
