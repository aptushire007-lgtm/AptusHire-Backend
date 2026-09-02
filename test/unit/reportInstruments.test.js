// Phase 1/2 of the report rebuild: the claimed-vs-demonstrated subtraction, the
// verdict chip, and the deterministic résumé narrative.
//
// The thing these tests exist to prevent is the failure this codebase has
// already had once: a derived value computed separately on the screen and in the
// PDF, drifting until one payload produced two different readings behind one
// button (see `bucketPercents` in interviewReportEngine). So every case below
// asserts the ENGINE's answer, because the engine is the only place these are
// allowed to be computed.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  legMovement,
  computeEvidenceMovement,
  movementSentence,
  verdictFor,
  composeResumeNarrative,
  resumeFindingLists,
  buildCoverageMatrix,
} = require("../../utils/interviewReportEngine");

// ---------------------------------------------------------------------------
// Claimed vs. demonstrated
// ---------------------------------------------------------------------------

test("movement: the interview can raise, lower, confirm or never touch the CV's claim", () => {
  assert.equal(legMovement({ resume: "absent", interview: "verified" }), "stronger");
  assert.equal(legMovement({ resume: "verified", interview: "contradicted" }), "weaker");
  assert.equal(legMovement({ resume: "partial", interview: "partial" }), "held");
  assert.equal(legMovement({ resume: "verified", interview: "untested" }), "undemonstrated");
});

test("movement: `undemonstrated` is never quietly counted as `held`", () => {
  // This is the whole reason the fourth state exists. "No change" asserts we
  // looked and found the same thing; we did not look. Collapsing the two is how
  // an untested requirement starts reading as a confirmation.
  const m = computeEvidenceMovement([
    { weight: 0.5, resume: "verified", interview: "untested" },
    { weight: 0.5, resume: "verified", interview: "verified" },
  ]);
  assert.equal(m.undemonstrated, 1);
  assert.equal(m.held, 1);
  assert.equal(m.demonstrated, 1, "the untested row is outside the demonstrated denominator");
});

test("movement: a weaker must-have carries its weight, so severity is not just a count", () => {
  const m = computeEvidenceMovement([
    { weight: 0.6, resume: "verified", interview: "contradicted" },
    { weight: 0.05, resume: "verified", interview: "contradicted" },
  ]);
  assert.equal(m.weaker, 2);
  assert.equal(m.weakerWeight, 0.65);
});

test("movement sentence: silent when the interview demonstrated nothing at all", () => {
  // "0 of 9 requirements moved" is true and reads as a finding about the
  // candidate. It is a finding about our instrument, and the untested block says
  // so properly.
  const none = computeEvidenceMovement([{ weight: 1, resume: "verified", interview: "untested" }]);
  assert.equal(movementSentence(none), null);
  assert.equal(movementSentence(null), null);
  assert.equal(movementSentence({ criteria: 0, demonstrated: 0 }), null);
});

test("movement sentence: reads as one plain sentence over the demonstrated subset only", () => {
  const m = computeEvidenceMovement([
    { weight: 0.4, resume: "absent", interview: "verified" },
    { weight: 0.3, resume: "verified", interview: "contradicted" },
    { weight: 0.2, resume: "partial", interview: "partial" },
    { weight: 0.1, resume: "verified", interview: "untested" },
  ]);
  const s = movementSentence(m);
  assert.match(s, /Of the 3 requirements the interview actually tested/);
  assert.match(s, /1 held up better/);
  assert.match(s, /1 did not hold up/);
  assert.match(s, /1 came out the same/);
  assert.ok(!/4 requirements the interview actually tested/.test(s), "untested rows stay out of the denominator");
});

test("movement rides on the coverage matrix, so the screen and the PDF read one field", () => {
  const matrix = buildCoverageMatrix({
    criterionFindings: [
      { criterionId: "c1", label: "React", kind: "must_have", weight: 0.6, status: "absent", supportingClaimIds: [] },
      { criterionId: "c2", label: "SQL", kind: "must_have", weight: 0.4, status: "satisfied", supportingClaimIds: ["k1"] },
    ],
    perCriterion: [],
    probes: [{ criterionId: "c1", verdict: "verified", status: "assessed", question: "q", answerQuote: "a" }],
    anchors: [],
  });
  assert.equal(matrix.rows.find((r) => r.criterionId === "c1").movement, "stronger");
  assert.equal(matrix.totals.movement.stronger, 1);
  assert.equal(matrix.totals.movement.undemonstrated, 1, "c2 was never probed");
});

// ---------------------------------------------------------------------------
// The verdict chip
// ---------------------------------------------------------------------------

test("verdict chip: the interview's own verdict becomes the word beside the gauge", () => {
  assert.deepEqual(verdictFor({ instrument: "interview", verdict: { verdict: "ADVANCE" } }), {
    key: "ADVANCE",
    label: "Advance",
    tone: "positive",
  });
  assert.equal(verdictFor({ instrument: "interview", verdict: { verdict: "REVIEW" } }).label, "Needs review");
});

test("verdict chip: an unmeasurable session never wears a confident word", () => {
  // The Honest Reading Rule, decided once here rather than at each place it is
  // drawn. A degraded session that still computed an ADVANCE must not print it.
  const chip = verdictFor({ instrument: "interview", verdict: { verdict: "ADVANCE" }, measurable: false });
  assert.equal(chip.key, "WITHHELD");
  assert.equal(chip.tone, "neutral");
});

test("verdict chip: the skills assessment gets NO chip, at any score", () => {
  // There is no approved pass mark on a skills paper. Inventing one would assert
  // a global cutoff for "good", which is the one thing this product refuses to
  // do — nothing is scored against an abstract standard, only against the role's
  // own approved rubric.
  assert.equal(verdictFor({ instrument: "assessment" }), null);
  assert.equal(verdictFor({ instrument: "assessment", band: "advance" }), null);
});

test("verdict chip: the résumé band maps across, and an unknown band prints nothing", () => {
  assert.equal(verdictFor({ instrument: "resume", band: "advance" }).label, "Advance");
  assert.equal(verdictFor({ instrument: "resume", band: "decline" }).label, "Clear reject");
  assert.equal(verdictFor({ instrument: "resume", band: undefined }), null);
});

// ---------------------------------------------------------------------------
// The résumé narrative — composed, never generated
// ---------------------------------------------------------------------------

const FINDINGS = [
  { criterionId: "c1", label: "React", kind: "must_have", weight: 0.4, status: "satisfied", reasoning: "Five years shipping React." },
  { criterionId: "c2", label: "GraphQL", kind: "must_have", weight: 0.3, status: "partial", reasoning: "" },
  { criterionId: "c3", label: "Team leadership", kind: "must_have", weight: 0.2, status: "absent", reasoning: "" },
  { criterionId: "c4", label: "Rust", kind: "nice_to_have", weight: 0.1, status: "contradicted", reasoning: "Dates overlap another role." },
];

test("résumé narrative: counts what the findings say and names the biggest silences", () => {
  const s = composeResumeNarrative(FINDINGS);
  assert.match(s, /Against the 4 requirements/);
  assert.match(s, /1 requirement outright and 1 in part/);
  assert.match(s, /says nothing about Team leadership/);
  assert.match(s, /1 requirement is contradicted/);
});

test("résumé narrative: always closes by saying a CV is only a claim", () => {
  // The single most important sentence on that card. A screening score is a read
  // on a document the candidate wrote, and the report must never let it be read
  // as verification.
  assert.match(composeResumeNarrative(FINDINGS), /A CV is a claim — none of this is verified until it is probed\./);
});

test("résumé narrative: no findings means no sentence, not a filler one", () => {
  assert.equal(composeResumeNarrative([]), null);
  assert.equal(composeResumeNarrative(null), null);
});

test("résumé narrative: invents nothing — every label it prints came from the findings", () => {
  const s = composeResumeNarrative(FINDINGS);
  const labels = s.match(/React|GraphQL|Team leadership|Rust/g) || [];
  const known = new Set(FINDINGS.map((f) => f.label));
  for (const l of labels) assert.ok(known.has(l), `${l} is not a rubric label`);
});

test("résumé lists: recommendations are named next-round probes, not adjectives", () => {
  const { strengths, gaps, recommendations } = resumeFindingLists(FINDINGS);
  assert.deepEqual(strengths, ["React — Five years shipping React."]);
  assert.equal(gaps.length, 2, "absent and contradicted are both gaps");
  // Forward-looking and specific — the shape a recruiter can hand to whoever
  // runs the next round.
  assert.match(recommendations[0], /^Ask for one specific example of GraphQL/);
  assert.ok(
    recommendations.every((r) => /^Ask /.test(r)),
    "every recommendation is an instruction to the next human"
  );
});

test("résumé lists: nice-to-haves never generate a next-round probe", () => {
  // Probe slots are scarce. Spending one on a nice-to-have while a must-have
  // goes untested is the wrong trade, and the list is what a human works from.
  const { recommendations } = resumeFindingLists(FINDINGS);
  assert.ok(!recommendations.some((r) => r.includes("Rust")));
});

test("résumé lists: a satisfied criterion is never recommended for probing", () => {
  const { recommendations } = resumeFindingLists(FINDINGS);
  assert.ok(!recommendations.some((r) => r.includes("React")));
});
