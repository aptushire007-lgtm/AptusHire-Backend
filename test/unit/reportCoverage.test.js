// Evidence coverage matrix + session quality. Both are pure joins/derivations over
// already-scored data, so the whole contract is assertable offline — which is the
// point: nothing here may depend on a model call.
//
// What these lock down:
//   - "not tested" is a real state and never rounds into a pass (§3 rule 5)
//   - a single contradiction is never averaged away by a sibling probe (§3 rule 4)
//   - criterion LABELS reach the recruiter, never raw ids like "c5"
//   - a degraded audio session suppresses the recommendation (§3 rule 5/6)
//   - a session we could not HEAR never produces an automated verdict, in either
//     direction, and "asked to repeat" is never part of that test (invariant 8)

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCoverageMatrix,
  computeSessionQuality,
  analyseTurnQuality,
  computeVerdict,
  audioUnreliableFrom,
  CELL,
} = require("../../utils/interviewReportEngine");
const { buildReportPdf } = require("../../services/interviewReportPdf");

const findings = [
  { criterionId: "c1", label: "Proficiency in MERN stack", kind: "must_have", weight: 0.4, status: "satisfied", supportingClaimIds: ["k1"] },
  { criterionId: "c2", label: "Knowledge of secure authentication", kind: "must_have", weight: 0.35, status: "absent", supportingClaimIds: [] },
  { criterionId: "c3", label: "Experience with Redux Toolkit", kind: "nice_to_have", weight: 0.25, status: "partial", supportingClaimIds: ["k3"] },
];

test("rows carry the criterion LABEL, not the raw id, and sort heaviest first", () => {
  const m = buildCoverageMatrix({ criterionFindings: findings, perCriterion: [], probes: [] });
  assert.deepEqual(
    m.rows.map((r) => r.label),
    ["Proficiency in MERN stack", "Knowledge of secure authentication", "Experience with Redux Toolkit"]
  );
  // The whole reason this exists: no bare "cN" may reach a recruiter.
  assert.ok(m.rows.every((r) => r.label !== r.criterionId));
});

test("an untested criterion is untested — never a pass", () => {
  const m = buildCoverageMatrix({ criterionFindings: findings, perCriterion: [], probes: [] });
  for (const row of m.rows) {
    assert.equal(row.assessment, CELL.untested);
    assert.equal(row.interview, CELL.untested);
    assert.equal(row.bucket, "insufficient");
  }
  // Nothing was tested → the full weight of the role is unspeakable-to.
  assert.equal(m.totals.insufficientWeight, 1);
  assert.equal(m.totals.provenWeight, 0);
  assert.equal(m.totals.failedWeight, 0);
});

// The point of the rebuild: a thin slice of a small paper cannot support a
// verdict, and saying so is a statement about our test, not the candidate.
test("1-of-3 items is NOT a failure — too few items to tell a wrong answer from a guess", () => {
  const m = buildCoverageMatrix({
    criterionFindings: findings,
    perCriterion: [{ criterionId: "c1", correctCount: 1, itemCount: 3 }],
    probes: [],
  });
  const row = m.rows.find((r) => r.criterionId === "c1");
  assert.equal(row.bucket, "insufficient");
  assert.equal(row.underpowered, true);
  assert.equal(m.totals.underpoweredCriteria, 1);
});

test("a decisive slice of adequate size can still fail", () => {
  const m = buildCoverageMatrix({
    criterionFindings: findings,
    perCriterion: [{ criterionId: "c1", correctCount: 1, itemCount: 8 }],
    probes: [],
  });
  assert.equal(m.rows.find((r) => r.criterionId === "c1").bucket, "failed");
});

test("all-correct on at least three items is proven", () => {
  const m = buildCoverageMatrix({
    criterionFindings: findings,
    perCriterion: [
      { criterionId: "c1", correctCount: 3, itemCount: 3 },
      { criterionId: "c2", correctCount: 2, itemCount: 2 },
    ],
    probes: [],
  });
  const by = Object.fromEntries(m.rows.map((r) => [r.criterionId, r]));
  assert.equal(by.c1.bucket, "proven");
  // Two items is below the floor even when both are right.
  assert.equal(by.c2.bucket, "insufficient");
});

test("a live probe verdict outranks the item ratio in both directions", () => {
  const m = buildCoverageMatrix({
    criterionFindings: findings,
    perCriterion: [
      { criterionId: "c1", correctCount: 3, itemCount: 3 },
      { criterionId: "c2", correctCount: 0, itemCount: 6 },
    ],
    probes: [
      { criterionId: "c1", verdict: "contradicted", question: "q", answerQuote: "No. No. No.", turnIndex: 29 },
      { criterionId: "c2", verdict: "verified", question: "q2", answerQuote: "yes, using JWT rotation", turnIndex: 4 },
    ],
  });
  const by = Object.fromEntries(m.rows.map((r) => [r.criterionId, r]));
  assert.equal(by.c1.bucket, "failed", "a contradicting exchange beats a clean item sweep");
  assert.equal(by.c2.bucket, "proven", "a verifying exchange beats a bad item sweep");
  // The exchange that drove the call travels with the row so it can be read.
  assert.equal(by.c1.decidingProbe.answerQuote, "No. No. No.");
  assert.equal(by.c1.decidingProbe.turnIndex, 29);
});

test("bucket weights are exhaustive — every criterion lands in exactly one", () => {
  const m = buildCoverageMatrix({
    criterionFindings: findings,
    perCriterion: [{ criterionId: "c1", correctCount: 3, itemCount: 3 }],
    probes: [{ criterionId: "c2", verdict: "contradicted" }],
  });
  const counted = m.buckets.proven.rows.length + m.buckets.failed.rows.length + m.buckets.insufficient.rows.length;
  assert.equal(counted, m.rows.length);
  const w = m.totals.provenWeight + m.totals.failedWeight + m.totals.insufficientWeight;
  assert.ok(Math.abs(w - 1) < 0.02, `bucket weights should sum to the rubric, got ${w}`);
});

test("every row carries a plain-language evidence line", () => {
  const m = buildCoverageMatrix({
    criterionFindings: findings,
    perCriterion: [{ criterionId: "c1", correctCount: 2, itemCount: 4 }],
    probes: [],
  });
  const row = m.rows.find((r) => r.criterionId === "c1");
  assert.equal(row.evidence, "2 of 4 assessment items · never probed in the interview");
});

test("a claim that was never made reads as 'not claimed', not as a failure", () => {
  const m = buildCoverageMatrix({ criterionFindings: findings, perCriterion: [], probes: [] });
  const secure = m.rows.find((r) => r.criterionId === "c2");
  assert.equal(secure.claimed, false);
});

test("assessment ratios map coarsely and never round a 2/4 into a pass", () => {
  const m = buildCoverageMatrix({
    criterionFindings: findings,
    perCriterion: [
      { criterionId: "c1", correctCount: 4, itemCount: 4 },
      { criterionId: "c2", correctCount: 2, itemCount: 4 },
      { criterionId: "c3", correctCount: 0, itemCount: 3 },
    ],
    probes: [],
  });
  const by = Object.fromEntries(m.rows.map((r) => [r.criterionId, r]));
  assert.equal(by.c1.assessment, CELL.verified);
  assert.equal(by.c2.assessment, CELL.partial);
  assert.equal(by.c3.assessment, CELL.contradicted);
  assert.deepEqual(by.c2.assessmentDetail, { correctCount: 2, itemCount: 4 });
});

test("one contradicted probe outweighs a verified sibling — disagreement is not averaged", () => {
  const m = buildCoverageMatrix({
    criterionFindings: findings,
    perCriterion: [],
    probes: [
      { criterionId: "c1", verdict: "verified" },
      { criterionId: "c1", verdict: "contradicted" },
    ],
  });
  assert.equal(m.rows.find((r) => r.criterionId === "c1").interview, CELL.contradicted);
});

test("a probe with no verdict yet is untested, not inconclusive", () => {
  const m = buildCoverageMatrix({ criterionFindings: findings, perCriterion: [], probes: [{ criterionId: "c1", verdict: null }] });
  assert.equal(m.rows.find((r) => r.criterionId === "c1").interview, CELL.untested);
});

test("no rubric leg → null, so pre-existing reports render unchanged", () => {
  assert.equal(buildCoverageMatrix({ criterionFindings: [], perCriterion: [], probes: [] }), null);
  assert.equal(buildCoverageMatrix({}), null);
});

// --- session quality -------------------------------------------------------

const clean = [
  { role: "ai", text: "Tell me about your React experience." },
  {
    role: "candidate",
    text: "I built a dashboard in React using hooks and context for state, and memoised the expensive list rendering.",
    audioDurationMs: 22000,
    answerScore: 80,
    acoustic: { pauseRatio: 0.4, audioQuality:74 },
  },
];

test("a clean session is not flagged and keeps its recommendation", () => {
  const q = computeSessionQuality(clean);
  assert.equal(q.degraded, false);
  assert.equal(q.reasons.length, 0);
});

// Verbatim turns from the 31 Jul session, so the thresholds are held against the
// data that motivated them rather than against invented numbers.
test("the two genuinely attempted answers are NOT flagged", () => {
  const real = analyseTurnQuality([
    {
      role: "candidate",
      text: "For handling asynchronous actions in a Redux based AI chatbot, I would use Redux Toolkit createAsyncThunk as it simplifies async logic and automatically manages loading success and error states.",
      audioDurationMs: 55756,
      acoustic: { wordsPerMinute: 111, pauseRatio: 0.57, audioQuality:74 },
    },
    {
      role: "candidate",
      text: "For prompt engineering I add a persona, then assign it a task, then tell it what the output should look like.",
      audioDurationMs: 40841,
      acoustic: { wordsPerMinute: 125, pauseRatio: 0.56, audioQuality:71 },
    },
  ]);
  assert.deepEqual(real.map((t) => t.degraded), [false, false]);
});

test("long audio that transcribes to nothing is the stalled signature", () => {
  const [t] = analyseTurnQuality([
    { role: "candidate", text: "Hello?", audioDurationMs: 19045, acoustic: { wordsPerMinute: 3, pauseRatio: 0.83, audioQuality: 0 } },
  ]);
  assert.deepEqual(t.flags.sort(), ["mostly_silence", "stalled", "unusable_audio"]);
  assert.equal(t.degraded, true);
});

// Every flag on a turn describes the RECORDING. `unusable_audio` replaced a flag literally called
// `low_delivery`, rendered to recruiters as "very low delivery" — which reads as a verdict on the
// person when what it meant was that the microphone captured almost nothing. The distinction is
// the whole reason this measurement is still allowed to exist (see utils/prosody.js), so it is
// held here rather than left to whoever next edits the label.
test("turn flags describe the recording, never the candidate", () => {
  const [t] = analyseTurnQuality([
    { role: "candidate", text: "Hello?", audioDurationMs: 19045, acoustic: { wordsPerMinute: 3, pauseRatio: 0.9, audioQuality: 0 } },
  ]);
  assert.ok(!t.flags.includes("low_delivery"), "the old person-shaped flag name is gone");
  assert.equal(t.deliveryScore, undefined, "no per-turn delivery score is reported anywhere");
  // A fluent, fast, filler-free answer and a slow, hesitant one are both perfectly audible, and
  // must be indistinguishable to this code.
  const [fluent, hesitant] = analyseTurnQuality([
    { role: "candidate", text: "I led the Kafka migration across four services over about six months.", audioDurationMs: 12000, acoustic: { wordsPerMinute: 165, fillerRate: 0, pauseRatio: 0.2 } },
    { role: "candidate", text: "I led the Kafka migration across four services over about six months.", audioDurationMs: 30000, acoustic: { wordsPerMinute: 82, fillerRate: 22, pauseRatio: 0.5 } },
  ]);
  assert.deepEqual(fluent.flags, hesitant.flags, "pace and hesitation must not change a turn's flags");
  assert.equal(hesitant.degraded, false);
});

// A transcript recorded across a dropped socket is missing words, and the whole failure this
// guards against is that a hole looks exactly like a short answer. The candidate whose broadband
// dropped and the candidate who had nothing to say produce the same short paragraph; only this
// flag can tell a reviewer which one they are reading.
test("an answer recorded across a dropped connection is never a clean read", () => {
  const [t] = analyseTurnQuality([
    {
      role: "candidate",
      text: "We moved the ingestion pipeline onto Kafka over about four months.",
      audioDurationMs: 41000,
      acoustic: { wordsPerMinute: 120, pauseRatio: 0.35, audioQuality: 88 },
      connection: { drops: 1, gapMs: 5200 },
    },
  ]);
  // Everything else about this turn is healthy — good pace, clean audio, a real answer. The drop
  // is the ONLY thing wrong with it, so it is the only thing that can flag it.
  assert.deepEqual(t.flags, ["connection_dropped"]);
  assert.equal(t.degraded, true);
});

test("one dropped connection is enough to withhold the recommendation", () => {
  const q = computeSessionQuality([
    { role: "candidate", text: "A perfectly good answer about Kafka consumer groups and rebalancing.", audioDurationMs: 30000, acoustic: { wordsPerMinute: 130, pauseRatio: 0.3, audioQuality: 90 } },
    {
      role: "candidate",
      text: "The second answer, cut in half by the network.",
      audioDurationMs: 28000,
      acoustic: { wordsPerMinute: 118, pauseRatio: 0.32, audioQuality: 86 },
      connection: { drops: 1, gapMs: 7400 },
    },
  ]);
  // Not a ratio and not a threshold: a single known hole in the evidence is enough. Every other
  // degradation signature here is inferred from ambiguous audio, but this one is a recorded fact,
  // and there is no honest way to recommend against someone on a transcript we know is incomplete.
  assert.equal(q.droppedTurns, 1);
  assert.equal(q.degraded, true);
  assert.equal(q.suppressRecommendation, true);
  assert.ok(q.reasons.some((r) => /never recorded/i.test(r)));
});

test("a clean session records no connection trouble at all", () => {
  const q = computeSessionQuality([
    { role: "candidate", text: "A perfectly good answer about Kafka consumer groups and rebalancing.", audioDurationMs: 30000, acoustic: { wordsPerMinute: 130, pauseRatio: 0.3, audioQuality: 90 } },
  ]);
  assert.equal(q.droppedTurns, 0);
  assert.equal(q.suppressRecommendation, false);
});

// Sessions recorded before the rename stored the same measurement under `deliveryScore`. Their
// bad audio must still be flagged — the point of the change was to stop DISPLAYING the number as
// a judgement, not to lose the ability to say "we could not hear this answer".
test("a pre-rename session still flags its unusable audio", () => {
  const [t] = analyseTurnQuality([
    { role: "candidate", text: "Hello?", audioDurationMs: 19045, acoustic: { wordsPerMinute: 3, pauseRatio: 0.83, deliveryScore: 0 } },
  ]);
  assert.ok(t.flags.includes("unusable_audio"));
  assert.equal(t.degraded, true);
});

test("a rambling non-answer is stalled too — rate, not raw word count", () => {
  // 30 words over 38s reads as speech but is 48wpm of "could you repeat that".
  const [t] = analyseTurnQuality([
    {
      role: "candidate",
      text: "I would for an AI chatbot, I would structure the Redux Store Could you please con could you please repeat the question, please? Could you please repeat? Could you repeat that?",
      audioDurationMs: 38506,
      acoustic: { wordsPerMinute: 48, pauseRatio: 0.84, audioQuality:16 },
    },
  ]);
  assert.equal(t.degraded, true);
  assert.ok(t.flags.includes("mostly_silence"));
  assert.ok(t.flags.includes("asked_to_repeat"));
});

test("a broken audio path suppresses the recommendation rather than reporting a no-hire", () => {
  // The real shape of the 31 Jul session: long recordings, no words, repeat requests.
  const turns = [
    { role: "candidate", text: "Hello?", audioDurationMs: 19045, acoustic: { wordsPerMinute: 3, pauseRatio: 0.83, audioQuality:0 } },
    {
      role: "candidate",
      text: "Could you please repeat that?",
      audioDurationMs: 38506,
      acoustic: { wordsPerMinute: 8, pauseRatio: 0.84, audioQuality:16 },
    },
    {
      role: "candidate",
      text: "Sorry. Can you repeat that again?",
      audioDurationMs: 25026,
      acoustic: { wordsPerMinute: 34, pauseRatio: 0.88, audioQuality:3 },
    },
    { role: "candidate", text: "Nope", audioDurationMs: 3240, acoustic: { wordsPerMinute: 19, pauseRatio: 0.97, audioQuality:0 } },
  ];
  const q = computeSessionQuality(turns);
  assert.equal(q.degraded, true);
  assert.equal(q.suppressRecommendation, true);
  assert.equal(q.repeatRequests, 2);
  assert.ok(q.reasons.some((r) => /repeated/i.test(r)));
  assert.ok(q.reasons.some((r) => /almost no words/i.test(r)));
});

test("an empty interview is not retroactively called degraded", () => {
  const q = computeSessionQuality([]);
  assert.equal(q.degraded, false);
  assert.equal(q.total, 0);
});

// --- PDF parity ------------------------------------------------------------

function reportWith(extra) {
  return {
    candidate: { name: "Ada Lovelace", email: "ada@example.com" },
    job: { title: "Junior MERN Stack Developer" },
    stage: "ai_interview_completed",
    stageLabel: "AI interview completed",
    hasInterview: false,
    assessment: null,
    ...extra,
  };
}

test("the PDF renders the coverage groups without an interview", () => {
  const coverage = buildCoverageMatrix({
    criterionFindings: findings,
    perCriterion: [{ criterionId: "c1", correctCount: 3, itemCount: 3 }],
    probes: [],
  });
  const pdf = buildReportPdf(reportWith({ coverage: { ...coverage, rubricVersion: 2 } }));
  assert.ok(Buffer.isBuffer(pdf) && pdf.length > 0);
  const text = pdf.toString("latin1");
  assert.ok(text.includes("The role, by what we can prove"));
  assert.ok(text.includes("PROVEN"));
  assert.ok(text.includes("NOT TESTED"));
});

test("the PDF prints criterion labels, never raw ids", () => {
  const coverage = buildCoverageMatrix({ criterionFindings: findings, perCriterion: [], probes: [] });
  const pdf = buildReportPdf(
    reportWith({
      coverage,
      assessment: {
        decision: { action: "sent" },
        session: {
          status: "completed",
          result: {
            scoredAt: new Date("2026-07-31T17:53:58Z"),
            totalItems: 4,
            totalCorrect: 3,
            perCriterion: [{ criterionId: "c1", correctCount: 3, itemCount: 4 }],
            claimVerdicts: [],
          },
        },
      },
    })
  );
  const text = pdf.toString("latin1");
  assert.ok(text.includes("Proficiency in MERN stack"), "expected the criterion label in the PDF");
});

test("the PDF states a withheld recommendation instead of printing a decision", () => {
  const pdf = buildReportPdf(
    reportWith({
      hasInterview: true,
      coverage: null,
      interview: {
        status: "completed",
        engine: "ai",
        questionCount: 4,
        transcript: [],
        evaluation: null,
        sessionQuality: computeSessionQuality([
          { role: "candidate", text: "Hello?", audioDurationMs: 19045, acoustic: { pauseRatio: 0.9, audioQuality:0 } },
          { role: "candidate", text: "Sorry, can you repeat that?", audioDurationMs: 25026, acoustic: { pauseRatio: 0.88, audioQuality:3 } },
          { role: "candidate", text: "Could you repeat the question please?", audioDurationMs: 30000, acoustic: { pauseRatio: 0.9, audioQuality:2 } },
        ]),
        recommendedAction: { action: "Re-interview", justification: "withheld", suppressed: true },
      },
    })
  );
  const text = pdf.toString("latin1");
  assert.ok(text.includes("Recommendation withheld"));
  assert.ok(text.includes("DEGRADED SESSION"));
});


// ---------------------------------------------------------------------------
// The audio guard: a session we could not hear is not a verdict about anybody
// ---------------------------------------------------------------------------
//
// The regression these lock down was live. `computeSessionQuality` correctly detected a broken
// audio path and the controller correctly suppressed `recommendedAction` — but the VERDICT was
// computed before any of that was consulted, so it still came back CLEAR_REJECT at High
// confidence, and `interviewReportPdf.verdictBanner` prints the verdict full-bleed at the top of
// page one. The candidate whose microphone died got a PDF headed "CLEAR REJECT".
//
// This is the same shape as the withdrawal bug (ended_early auto-rejecting the people who used
// the exit) and the abandonment bug before it. Third instance, same rule: our fault never costs
// the candidate.

// An answer that captured 12s of audio and almost no words — the signature of a dead mic.
const stalledTurn = (text = "uh") => ({
  role: "candidate",
  text,
  audioDurationMs: 12000,
  acoustic: { wordsPerMinute: 8, pauseRatio: 0.9, audioQuality: 6 },
});
// A real answer, cleanly recorded.
const goodTurn = (text = "We ran three Kafka brokers and rebalanced consumer groups on deploy.") => ({
  role: "candidate",
  text,
  audioDurationMs: 30000,
  acoustic: { wordsPerMinute: 130, pauseRatio: 0.3, audioQuality: 90 },
});

test("a session whose audio failed returns REVIEW, never CLEAR_REJECT", () => {
  // 10 of 15 answers unheard — the live session that exposed this.
  const turns = [...Array(10)].map(() => stalledTurn()).concat([...Array(5)].map(() => goodTurn()));
  const q = computeSessionQuality(turns);
  assert.equal(q.audioUnreliable, true);

  const v = computeVerdict({
    responsiveCount: 5,
    totalAnswers: 15,
    engineRan: true,
    overallScore: 70,
    audioUnreliable: q.audioUnreliable,
  });
  // Without the guard this is the `responsiveCount / totalAnswers < 0.5` branch:
  // CLEAR_REJECT at High confidence, on evidence that is entirely about our own audio path.
  assert.equal(v.verdict, "REVIEW");
  assert.equal(v.confidence, "Low");
  assert.match(v.reason, /could not answer.*could not hear/i);
  assert.match(v.reason, /must not count against them/i);
});

test("the audio guard withholds an ADVANCE too, not only a rejection", () => {
  // Symmetry matters: if we could not hear them, a good score is not a measurement either.
  const v = computeVerdict({
    responsiveCount: 9,
    totalAnswers: 10,
    engineRan: true,
    overallScore: 95,
    audioUnreliable: true,
  });
  assert.equal(v.verdict, "REVIEW");
  assert.notEqual(v.verdict, "ADVANCE");
});

test("asking for a repeat is NOT an audio failure and never touches the verdict", () => {
  // Invariant 8. Repeat frequency tracks accent, hearing and bandwidth — it is excluded from every
  // score, and it must not reach a verdict in either direction either. A candidate who asked twice
  // and answered well must still be able to reach ADVANCE.
  const turns = [
    goodTurn("Sorry, could you repeat that? Right — we sharded by tenant id and backfilled nightly."),
    goodTurn("Can you say that again? Yes — the retry budget was capped at three attempts per job."),
    goodTurn(),
    goodTurn(),
  ];
  const q = computeSessionQuality(turns);
  assert.equal(q.repeatRequests, 2);
  // The broad flag still rises — the report should carry a note.
  assert.equal(q.degraded, true);
  // The narrow one must not.
  assert.equal(q.audioUnreliable, false);

  const v = computeVerdict({
    responsiveCount: 4,
    totalAnswers: 4,
    engineRan: true,
    overallScore: 82,
    audioUnreliable: q.audioUnreliable,
  });
  assert.equal(v.verdict, "ADVANCE");
});

test("one dropped connection is enough — no ratio, no threshold", () => {
  const turns = [
    goodTurn(),
    goodTurn(),
    goodTurn(),
    { ...goodTurn("The answer, cut in half by the network."), connection: { drops: 1, gapMs: 7400 } },
  ];
  // 1 of 4 is well under the 0.4 share, so this passes only because a recorded hole in the
  // evidence is treated as sufficient on its own — matching computeSessionQuality's existing rule.
  assert.equal(audioUnreliableFrom(analyseTurnQuality(turns)), true);
});

test("two stalled answers are enough, even in a long session", () => {
  const turns = [stalledTurn(), stalledTurn(), ...Array(18)].map((t) => t || goodTurn());
  assert.equal(audioUnreliableFrom(analyseTurnQuality(turns)), true);
});

test("a single bad answer in a clean session is not an audio failure", () => {
  // One stalled turn out of ten is a candidate who paused, not a broken microphone. Firing here
  // would withhold verdicts on ordinary interviews and make the guard meaningless.
  const turns = [stalledTurn(), ...Array(9)].map((t) => t || goodTurn());
  assert.equal(audioUnreliableFrom(analyseTurnQuality(turns)), false);
});

test("a clean session is untouched by the guard", () => {
  const turns = [goodTurn(), goodTurn(), goodTurn()];
  const q = computeSessionQuality(turns);
  assert.equal(q.audioUnreliable, false);
  const v = computeVerdict({ responsiveCount: 3, totalAnswers: 3, engineRan: true, overallScore: 40, audioUnreliable: q.audioUnreliable });
  // Still reachable: a genuinely low score on a session we heard perfectly well.
  assert.equal(v.verdict, "CLEAR_REJECT");
});

test("an empty session does not trip the guard", () => {
  assert.equal(audioUnreliableFrom([]), false);
  assert.equal(audioUnreliableFrom(undefined), false);
});

test("the earlier guards still win — halted outranks broken audio", () => {
  // Ordering is not cosmetic: the reason shown to the recruiter has to name the RIGHT fault, and
  // "we stopped this interview" is a more specific fact than "we could not hear it".
  const v = computeVerdict({ responsiveCount: 0, totalAnswers: 5, halted: true, audioUnreliable: true, engineRan: true });
  assert.equal(v.verdict, "REVIEW");
  assert.match(v.reason, /outside its approved script/i);
});

// ---------------------------------------------------------------------------
// The displayed percentage, and why it is computed here rather than at each surface.
//
// The admin screen renormalised (`pctOf(weight / total)`) while the PDF printed the raw weight
// (`Math.round(w * 100)`). Same payload, one download button, two different sets of numbers — and
// because the bucket weights above are rounded to 2dp, the PDF's three could total 99% or 101% of
// a role while the screen's totalled 100%. Both files carried a comment claiming parity with the
// other. `pct` is now the single source and both surfaces print it verbatim.
// ---------------------------------------------------------------------------

test("bucket percentages always total exactly 100", () => {
  const m = buildCoverageMatrix({ criterionFindings: findings, perCriterion: [], probes: [] });
  const pcts = ["proven", "failed", "insufficient"].map((k) => m.buckets[k].pct);
  assert.equal(
    pcts.reduce((s, v) => s + v, 0),
    100,
    "three numbers a recruiter is invited to add up have to add up"
  );
  assert.ok(pcts.every((p) => Number.isInteger(p) && p >= 0 && p <= 100));
});

test("thirds: the case raw rounding could never make total 100", () => {
  // Three equal criteria, one landing in each bucket. Raw, each weight rounds to 0.33 and the PDF
  // printed 33 + 33 + 33 = 99% of a role.
  const thirds = [
    { criterionId: "c1", label: "One", kind: "must_have", weight: 1 / 3, status: "satisfied", supportingClaimIds: ["k1"] },
    { criterionId: "c2", label: "Two", kind: "must_have", weight: 1 / 3, status: "absent", supportingClaimIds: [] },
    { criterionId: "c3", label: "Three", kind: "must_have", weight: 1 / 3, status: "partial", supportingClaimIds: ["k3"] },
  ];
  const m = buildCoverageMatrix({
    criterionFindings: thirds,
    perCriterion: [],
    // A bucket is decided by evidence, not by the résumé status — so the spread has to come from
    // probe verdicts. c3 is left unprobed, which is what "insufficient" means.
    probes: [
      { criterionId: "c1", verdict: "verified" },
      { criterionId: "c2", verdict: "contradicted" },
    ],
  });

  const pcts = ["proven", "failed", "insufficient"].map((k) => m.buckets[k].pct);
  assert.deepEqual(
    pcts.map((p) => p > 0),
    [true, true, true],
    "fixture must actually spread across all three buckets or this test proves nothing"
  );
  assert.equal(pcts.reduce((s, v) => s + v, 0), 100);
  // Largest remainder, so exactly one bucket carries the leftover point rather than all three
  // being visibly wrong.
  assert.deepEqual([...pcts].sort((a, b) => a - b), [33, 33, 34]);
});

test("an empty rubric yields no matrix at all — there is nothing to take a percentage of", () => {
  // The division-by-zero case never reaches bucketPercents: with no criteria there is no matrix.
  assert.equal(buildCoverageMatrix({ criterionFindings: [], perCriterion: [], probes: [] }), null);
});

test("the PDF prints the engine's percentage, not one of its own", () => {
  const m = buildCoverageMatrix({ criterionFindings: findings, perCriterion: [], probes: [] });
  const text = buildReportPdf(reportWith({ coverage: m })).toString("latin1");
  // Every non-empty bucket's percentage must appear as printed by the engine. If the PDF ever
  // re-derives, one of these stops matching.
  for (const k of ["proven", "failed", "insufficient"]) {
    if (m.buckets[k].weight > 0) {
      assert.ok(
        text.includes(`${m.buckets[k].pct}%`),
        `the PDF must print the engine's ${k} percentage (${m.buckets[k].pct}%)`
      );
    }
  }
});
