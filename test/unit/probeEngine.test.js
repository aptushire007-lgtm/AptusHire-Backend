// Phase 8 acceptance gates — the Claim → Probe → Verdict loop:
//   - probe phrasing neutrality is enforced in CODE (accusatory probes cannot
//     survive the sanitiser — the phrasing gate is structural, not a review);
//   - probes cite real claims only (ghosts dropped) and are capped;
//   - verdicts are cite-or-abstain: an answer quote that is not a verbatim
//     substring of the answer downgrades the verdict to inconclusive;
//   - verdict write-back moves verificationStatus, and the PURE scorer moves
//     the score in the correct direction (verified ↑, contradicted ↓);
//   - the closing condition is code: all probes covered AND minQuestions
//     reached, with maxQuestions as the ceiling;
//   - post-interview reproducibility hashes fold in the claims' verification
//     state so "same hash ⇒ same score" survives the pre/post pair.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  probePhrasingIssues,
  probePrompt,
  verdictPrompt,
  claimStatement,
} = require("../../utils/probePrompts");
const {
  sanitiseProbes,
  sanitiseVerdicts,
  applyVerdictsToClaims,
  answerTextForProbe,
  PROBE_CAP,
} = require("../../services/probeService");
const { computeAssessment, reproducibilityHash, claimsStateHash } = require("../../utils/evidenceScorer");
const { closingAllowed, questionCoversProbe } = require("../../services/aiInterviewService");
const { questionPrompt } = require("../../utils/interviewPrompts");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEXT = "Scaled a Kafka pipeline to 2M events/day. Mentored four junior engineers across two teams.";

function claimFixtures() {
  return [
    {
      id: "k1", type: "experience", subject: "candidate", predicate: "scaled", object: "Kafka pipeline",
      specificity: "vague", verificationStatus: "unverified", selfReportedOnly: true,
      spans: [{ start: 0, end: 41, quote: TEXT.slice(0, 41) }],
    },
    {
      id: "k2", type: "experience", subject: "candidate", predicate: "mentored", object: "four junior engineers",
      specificity: "vague", verificationStatus: "unverified", selfReportedOnly: true,
      spans: [{ start: 42, end: 90, quote: TEXT.slice(42, 90) }],
    },
  ];
}

function rubricFixture() {
  return {
    criteria: [
      { id: "c1", label: "Streaming infrastructure", kind: "must_have", weight: 0.7 },
      { id: "c2", label: "Mentorship", kind: "nice_to_have", weight: 0.3 },
    ],
    thresholds: { advance: 60, review: 45 },
  };
}

function findingsFixture() {
  return [
    { criterionId: "c1", status: "satisfied", supportingClaimIds: ["k1"], reasoning: "direct", confidence: 0.9 },
    { criterionId: "c2", status: "satisfied", supportingClaimIds: ["k2"], reasoning: "direct", confidence: 0.8 },
  ];
}

// ---------------------------------------------------------------------------
// Neutrality (guardrail: an accusatory probe is a defect)
// ---------------------------------------------------------------------------

test("neutral probe phrasings pass the phrasing check", () => {
  for (const q of [
    "Walk me through how you scaled the Kafka pipeline — what was the bottleneck?",
    "Tell me about mentoring the junior engineers. How did you structure it?",
    "How did you measure the 2M events/day figure?",
  ]) {
    assert.deepEqual(probePhrasingIssues(q), [], q);
  }
});

test("every accusatory pattern is flagged", () => {
  const bad = [
    ["You claim you scaled a Kafka pipeline — explain.", "you_claim"],
    ["Can you prove you mentored four engineers?", "prove"],
    ["Is it really true that you handled 2M events/day?", "is_it_true"],
    ["Did you actually build this yourself?", "did_you_really"],
    ["Your resume claims you led this work. Did you?", "resume_reference"],
    ["Be honest: how much of this was your work?", "honesty_challenge"],
    ["We doubt the throughput figure — walk us through it.", "doubt"],
    ["Please confirm that you were the tech lead.", "verify_challenge"],
  ];
  for (const [q, code] of bad) {
    assert.ok(probePhrasingIssues(q).includes(code), `${q} should flag ${code}`);
  }
});

// ---------------------------------------------------------------------------
// Probe sanitisation (cite-or-drop for probes)
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: accusatory and ghost probes cannot survive the sanitiser", () => {
  const claims = claimFixtures();
  const raw = [
    { claimId: "k1", question: "Walk me through the Kafka pipeline you scaled.", whatWouldVerify: "specific partitioning details", whatWouldContradict: "cannot describe basics" },
    { claimId: "k1", question: "Duplicate probe for the same claim.", whatWouldVerify: "x", whatWouldContradict: "y" },
    { claimId: "k2", question: "You claim you mentored four engineers — prove it.", whatWouldVerify: "x", whatWouldContradict: "y" },
    { claimId: "k999", question: "Tell me about a claim that does not exist.", whatWouldVerify: "x", whatWouldContradict: "y" },
    { claimId: "k2", question: "", whatWouldVerify: "x", whatWouldContradict: "y" },
  ];
  const { probes, dropped } = sanitiseProbes(raw, claims);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].claimId, "k1");
  assert.equal(probes[0].status, "pending");
  assert.equal(probes[0].resumeQuote, TEXT.slice(0, 41)); // the claim's cited span travels with the probe
  assert.equal(dropped.length, 4);
  assert.ok(dropped.some((d) => String(d.reason).startsWith("accusatory_phrasing")), "accusatory probe must be dropped");
  assert.ok(dropped.some((d) => d.reason === "unknown_or_duplicate_claim"), "ghost claim must be dropped");
});

test("§3.5: near-duplicate probe questions for DIFFERENT claims are deduped at seeding", () => {
  // The existing dedup above only catches the SAME claim proposed twice (unknown_or_duplicate_claim).
  // This is the gap the plan calls out: two different claims can still produce near-identical
  // question text, and nothing stopped both from surviving into the seeded probe list.
  const claims = claimFixtures();
  const raw = [
    {
      claimId: "k1",
      question: "Walk me through the Kafka pipeline you scaled to handle two million events per day.",
      whatWouldVerify: "x",
      whatWouldContradict: "y",
    },
    {
      claimId: "k2",
      question: "Can you walk me through the Kafka pipeline you scaled to handle two million events per day?",
      whatWouldVerify: "x",
      whatWouldContradict: "y",
    },
  ];
  const { probes, dropped } = sanitiseProbes(raw, claims);
  assert.equal(probes.length, 1, "the second, near-identical question is dropped even though it cites a different claim");
  assert.equal(probes[0].claimId, "k1", "the FIRST occurrence is kept, matching ask-time dedup's own precedent order");
  assert.ok(dropped.some((d) => String(d.reason).startsWith("duplicate_question")));
});

test("probes are capped so the interview stays an interview", () => {
  const claims = Array.from({ length: 8 }, (_, i) => ({
    id: `k${i + 1}`, spans: [{ start: 0, end: 5, quote: "Scale" }],
  }));
  const raw = claims.map((c) => ({
    claimId: c.id, question: `Walk me through item ${c.id}.`, whatWouldVerify: "detail", whatWouldContradict: "none",
  }));
  const { probes } = sanitiseProbes(raw, claims);
  assert.equal(probes.length, PROBE_CAP);
});

test("probe and verdict prompts carry the claim data", () => {
  const claims = claimFixtures();
  const p = probePrompt(claims);
  assert.ok(p.includes('claimId "k1"'));
  assert.ok(p.includes(TEXT.slice(0, 41)));
  const v = verdictPrompt([
    { claimId: "k1", statement: claimStatement(claims[0]), question: "Q", whatWouldVerify: "V", whatWouldContradict: "C", answerText: "A" },
  ]);
  assert.ok(v.includes("WOULD VERIFY: V"));
  assert.ok(v.includes("WOULD CONTRADICT: C"));
});

// ---------------------------------------------------------------------------
// Verdict sanitisation (cite-or-abstain for verdicts)
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: a verdict citing a fabricated answer quote is downgraded to inconclusive", () => {
  const items = [
    { claimId: "k1", answerText: "We ran Kafka with 12 partitions and tuned batch sizes to hit throughput." },
    { claimId: "k2", answerText: "I paired with each of the four engineers weekly." },
  ];
  const raw = [
    { claimId: "k1", verdict: "verified", reasoning: "described partitioning", answerQuote: "12 partitions and tuned batch sizes" },
    { claimId: "k2", verdict: "verified", reasoning: "sounds plausible", answerQuote: "I mentored them all daily with a curriculum" },
  ];
  const verdicts = sanitiseVerdicts(raw, items);
  assert.equal(verdicts.length, 2);
  const v1 = verdicts.find((v) => v.claimId === "k1");
  const v2 = verdicts.find((v) => v.claimId === "k2");
  assert.equal(v1.verdict, "verified"); // verbatim quote → stands
  assert.equal(v2.verdict, "inconclusive"); // fabricated quote → abstain
  assert.equal(v2.answerQuote, "");
  assert.ok(v2.reasoning.startsWith("Downgraded to inconclusive"));
});

test("missing and ghost verdicts default to inconclusive / are ignored", () => {
  const items = [{ claimId: "k1", answerText: "some answer" }];
  const verdicts = sanitiseVerdicts([{ claimId: "k999", verdict: "contradicted", reasoning: "x", answerQuote: "some" }], items);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].claimId, "k1");
  assert.equal(verdicts[0].verdict, "inconclusive");
});

// ---------------------------------------------------------------------------
// Write-back + rescore direction (the verification multiplier is the thesis)
// ---------------------------------------------------------------------------

test("verdict write-back moves verificationStatus; inconclusive leaves it alone", () => {
  const claims = claimFixtures();
  const changed = applyVerdictsToClaims(claims, [
    { claimId: "k1", verdict: "verified" },
    { claimId: "k2", verdict: "inconclusive" },
  ]);
  assert.equal(changed, 1);
  assert.equal(claims[0].verificationStatus, "verified_in_interview");
  assert.equal(claims[1].verificationStatus, "unverified");
});

test("ACCEPTANCE GATE: the post-interview score moves in the correct direction", () => {
  const rubric = rubricFixture();
  const findings = findingsFixture();

  const before = computeAssessment({ rubric, claims: claimFixtures(), findings });

  const verified = claimFixtures();
  applyVerdictsToClaims(verified, [{ claimId: "k1", verdict: "verified" }]);
  const up = computeAssessment({ rubric, claims: verified, findings });

  const contradicted = claimFixtures();
  applyVerdictsToClaims(contradicted, [{ claimId: "k1", verdict: "contradicted" }]);
  const down = computeAssessment({ rubric, claims: contradicted, findings });

  assert.ok(up.overallScore > before.overallScore, `verified must raise the score (${before.overallScore} → ${up.overallScore})`);
  assert.ok(down.overallScore < before.overallScore, `contradicted must lower the score (${before.overallScore} → ${down.overallScore})`);
  // contradicted_in_interview multiplies to exactly zero — proof beats assertion.
  const downC1 = down.criterionFindings.find((f) => f.criterionId === "c1");
  assert.equal(downC1.points, 0);
});

test("a verified claim leaves the probe feed; scores stay decomposable", () => {
  const rubric = rubricFixture();
  const findings = findingsFixture();
  const verified = claimFixtures();
  applyVerdictsToClaims(verified, [{ claimId: "k1", verdict: "verified" }]);
  const post = computeAssessment({ rubric, claims: verified, findings });
  assert.ok(!post.unverifiedHighWeightClaims.some((u) => u.claimId === "k1"), "a verified claim is no longer probe-worthy");
  const sum = post.criterionFindings.reduce((s, f) => s + f.points, 0);
  assert.equal(Math.round(sum * 10000) / 10000, post.overallRaw);
});

// ---------------------------------------------------------------------------
// Reproducibility across the pre/post pair
// ---------------------------------------------------------------------------

test("claimsStateHash is order-independent and status-sensitive", () => {
  const a = claimsStateHash([{ id: "k1", verificationStatus: "unverified" }, { id: "k2", verificationStatus: "unverified" }]);
  const b = claimsStateHash([{ id: "k2", verificationStatus: "unverified" }, { id: "k1", verificationStatus: "unverified" }]);
  const c = claimsStateHash([{ id: "k1", verificationStatus: "verified_in_interview" }, { id: "k2", verificationStatus: "unverified" }]);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("reproducibilityHash: omitting claimsStateHash preserves the Phase 6 hash; providing it changes it", () => {
  const base = { rubricId: "r1", rubricVersion: 1, resumeHash: "abc", promptVersions: ["p1", "p2"], modelId: "m" };
  const h1 = reproducibilityHash(base);
  const h2 = reproducibilityHash({ ...base });
  const h3 = reproducibilityHash({ ...base, claimsStateHash: "state1" });
  const h4 = reproducibilityHash({ ...base, claimsStateHash: "state2" });
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.notEqual(h3, h4);
});

// ---------------------------------------------------------------------------
// Closing condition (Phase 8.3 — code decides, the model proposes)
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: closing requires all probes covered AND minQuestions reached", () => {
  const probe = (status) => ({ claimId: "k1", status });
  assert.equal(closingAllowed({ probes: [probe("pending")], questionCount: 7, minQuestions: 5 }), false, "uncovered probe blocks closing");
  assert.equal(closingAllowed({ probes: [probe("asked")], questionCount: 3, minQuestions: 5 }), false, "below minQuestions blocks closing");
  assert.equal(closingAllowed({ probes: [probe("asked")], questionCount: 5, minQuestions: 5 }), true, "covered + min reached allows closing");
  assert.equal(closingAllowed({ probes: [], questionCount: 5, minQuestions: 5 }), true, "no probes: min alone gates");
});

test("questionPrompt: probes appear as REQUIRED COVERAGE and drive the closing instruction", () => {
  const common = {
    context: "CTX", plan: {}, turns: [], currentDifficulty: "medium",
    askedQuestions: [], questionCount: 6, minQuestions: 5, maxQuestions: 8,
  };
  const withProbes = questionPrompt({ ...common, probes: [{ claimId: "k1", question: "Walk me through the Kafka pipeline." }] });
  assert.ok(withProbes.includes("REQUIRED COVERAGE"));
  assert.ok(withProbes.includes('probeId "k1"'));
  assert.ok(withProbes.includes("Set isClosing=false."), "uncovered probes force isClosing=false");

  const covered = questionPrompt({ ...common, probes: [] });
  assert.ok(covered.includes("you may close"), "all covered + min reached offers closing");

  const mustCover = questionPrompt({ ...common, questionCount: 7, probes: [{ claimId: "k1", question: "Q" }] });
  assert.ok(mustCover.includes("cover a required topic NOW"));
});

test("answerTextForProbe finds the candidate answer that follows the probe's question turn", () => {
  const turns = [
    { role: "ai", text: "intro" },
    { role: "ai", text: "Q1" },
    { role: "candidate", text: "A1" },
    { role: "ai", text: "Q2 (probe)" },
    { role: "candidate", text: "A2 — the probe answer" },
  ];
  assert.equal(answerTextForProbe(turns, { turnIndex: 3 }), "A2 — the probe answer");
  assert.equal(answerTextForProbe(turns, { turnIndex: null }), "");
});

// ---------------------------------------------------------------------------
// questionCoversProbe — the generated question must still be ABOUT the claim
// ---------------------------------------------------------------------------
//
// questionPrompt tells the model it may reword a probe "using the suggested wording or a
// natural, equally neutral variant". Observed live: the model kept a real pending probeId but
// wrote a question about an entirely different competency — the claim-probe coverage bookkeeping
// said the English/Hindi fluency claim had been tested, and the verdict step then read the
// candidate's answer to an unrelated teamwork question as evidence about their fluency. This is
// the guard that catches that before it happens, not just the ability to notice it afterwards.

test("questionCoversProbe: a natural rewording of the same claim still counts", () => {
  const probe = { question: "Could you describe a situation where your professional fluency in English was crucial to achieving a successful outcome?" };
  assert.equal(
    questionCoversProbe("Tell me about a time your English fluency was important professionally.", probe),
    true
  );
});

test("THE FINDING — a question that drifted onto a different competency is caught", () => {
  // Real session data: probe k40 verified a résumé claim about English fluency; the question
  // actually delivered, tagged with the same probeId, asked about teamwork instead.
  const probe = { question: "Could you describe a situation where your professional fluency in English was crucial to achieving a successful outcome?" };
  assert.equal(
    questionCoversProbe(
      "Can you describe a situation where you worked as part of a multidisciplinary team and how you contributed to the team's goals?",
      probe
    ),
    false
  );
});

test("questionCoversProbe: nothing distinctive in the probe's own wording never fails the check", () => {
  assert.equal(questionCoversProbe("Anything at all", { question: "" }), true);
  assert.equal(questionCoversProbe("Anything at all", {}), true);
});
