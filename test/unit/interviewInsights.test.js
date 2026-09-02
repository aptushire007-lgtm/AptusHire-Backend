// Cognitive Insights and Communication Skills — the cite-or-drop contract.
//
// The whole value of these two panels over the thing they look like is that the
// numbers are not the model's. The model returns observations it must quote;
// code verifies the quotes against the transcript and does the arithmetic. Every
// test below exists to stop that guarantee eroding — because the moment an
// uncitable observation earns a point, the panel is indistinguishable from a
// model rating someone out of five, and there is nothing on screen to say so.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AXES,
  COGNITIVE_AXES,
  COMMUNICATION_AXES,
  INDICATOR_NAMES,
  INSIGHT_SCHEMA,
  GRAMMAR_MIN_CONFIDENCE,
  verifyObservations,
  verifyGrammarErrors,
  grammarStars,
  scoreAxis,
  scoreAnswer,
  aggregate,
  communicationEnabled,
} = require("../../utils/interviewInsights");
const { ASKS } = require("../../utils/insightPrompts");

const TRANSCRIPT =
  "I first checked the stock ledger against what the warehouse had actually counted, " +
  "and then I called the vendor to confirm the delivery window. That told us the shortfall " +
  "was upstream of us, not a picking error. I am not certain of the exact figure, but the " +
  "gap was somewhere around two thousand units.";

// A complete extraction with everything false, so each test can turn on exactly
// what it is about. A model must answer every field, which is why the schema
// requires them all.
function blank() {
  const raw = {};
  for (const n of INDICATOR_NAMES) raw[n] = { value: false, quote: "" };
  raw.grammarErrors = [];
  return raw;
}

// ---------------------------------------------------------------------------
// Cite or abstain
// ---------------------------------------------------------------------------

test("an observation the model cannot quote is dropped, not trusted", () => {
  const raw = blank();
  raw.identifiedARootCause = { value: true, quote: "the shortfall was upstream of us" };
  raw.offeredANonObviousObservation = { value: true, quote: "they displayed exceptional strategic vision" };

  const verified = verifyObservations(raw, TRANSCRIPT);
  assert.equal(verified.identifiedARootCause.value, true, "a real span survives");
  assert.equal(
    verified.offeredANonObviousObservation,
    undefined,
    "a span that is not in the transcript is removed entirely — not kept as false, which would still be a claim we did not verify"
  );
});

test("a two-word quote is not evidence — short spans match by accident", () => {
  const raw = blank();
  raw.madeAnActualDecision = { value: true, quote: "I called" };
  assert.equal(verifyObservations(raw, TRANSCRIPT).madeAnActualDecision, undefined);
});

test("a false observation needs no quote, because an absence has nothing to cite", () => {
  // Demanding a quote for "they did not do X" is how you get an invented one.
  const verified = verifyObservations(blank(), TRANSCRIPT);
  assert.equal(verified.reasonsFromPremiseToConclusion.value, false);
  assert.equal(verified.reasonsFromPremiseToConclusion.quote, "");
});

test("a hallucinated strength cannot become a point on the score", () => {
  const raw = blank();
  // All three of Insightfulness's indicators claimed, none of them citable.
  raw.offeredANonObviousObservation = { value: true, quote: "a truly remarkable systems thinker" };
  raw.generalisedFromTheSpecificCase = { value: true, quote: "he generalises with unusual skill" };
  raw.reframedTheQuestionUsefully = { value: true, quote: "reframed the problem brilliantly" };
  const { axes } = scoreAnswer(raw, TRANSCRIPT, 0.9);
  assert.equal(
    axes.insightfulness.score,
    undefined,
    "with every observation dropped there is too little left to measure, so the axis abstains rather than scoring 0 or 5"
  );
});

// ---------------------------------------------------------------------------
// Not measured is not a low score
// ---------------------------------------------------------------------------

test("under half an axis's indicators verified yields undefined, never zero", () => {
  // The distinction this file exists to preserve. A 0 says "they did this badly";
  // undefined says "we could not tell", and only one of those is true here.
  const partial = { reasonsFromPremiseToConclusion: { value: true, quote: "x" } };
  const r = scoreAxis("logicalReasoning", partial);
  assert.equal(r.score, undefined);
  assert.equal(r.available, 1);
  assert.equal(r.total, 4);
});

test("an adverse observation deducts without shrinking the scale", () => {
  // Being marked down must not also shrink the denominator, or a candidate with
  // one flaw and three strengths outscores one with three strengths and no flaw.
  const clean = {
    reasonsFromPremiseToConclusion: { value: true, quote: "a" },
    stepsAreOrdered: { value: true, quote: "b" },
    conclusionFollowsFromTheSteps: { value: true, quote: "c" },
    containsANonSequitur: { value: false, quote: "" },
  };
  const flawed = { ...clean, containsANonSequitur: { value: true, quote: "d" } };
  assert.equal(scoreAxis("logicalReasoning", clean).score, 5);
  assert.ok(scoreAxis("logicalReasoning", flawed).score < 5);
  assert.equal(scoreAxis("logicalReasoning", flawed).score, 3.5, "100% earned less a 30-point penalty");
});

test("the score expands to its evidence — every point carries the span that earned it", () => {
  const obs = {
    reasonsFromPremiseToConclusion: { value: true, quote: "I first checked the stock ledger" },
    stepsAreOrdered: { value: true, quote: "and then I called the vendor" },
    conclusionFollowsFromTheSteps: { value: false, quote: "" },
    containsANonSequitur: { value: true, quote: "that told us the shortfall" },
  };
  const r = scoreAxis("logicalReasoning", obs);
  assert.equal(r.observations.length, 3, "only TRUE observations carry a quote worth showing");
  assert.ok(r.observations.every((o) => o.quote));
  const adverse = r.observations.filter((o) => o.adverse);
  assert.equal(adverse.length, 1, "the one that cost points is marked as such");
  assert.equal(adverse[0].indicator, "containsANonSequitur");
});

// ---------------------------------------------------------------------------
// Grammar — the axis where the instrument itself is biased
// ---------------------------------------------------------------------------

test("grammar is withheld when the transcription cannot be trusted", () => {
  // The central fairness guard. Below the confidence floor we cannot tell the
  // candidate's error from the recogniser's, and the recogniser's errors fall
  // hardest on accented speech — so we decline to guess rather than charge them.
  const raw = blank();
  raw.grammarErrors = [{ quote: "I first checked the stock ledger", kind: "tense" }];

  const trusted = scoreAnswer(raw, TRANSCRIPT, 0.9).axes.grammar;
  const untrusted = scoreAnswer(raw, TRANSCRIPT, 0.4).axes.grammar;

  assert.ok(typeof trusted.score === "number");
  assert.equal(untrusted.score, undefined, "not a perfect score, and not a bad one — no score");
  assert.equal(untrusted.reason, "transcription_unreliable");
});

test("an absent confidence figure is treated as untrustworthy, not as good", () => {
  // A missing number must never default to "the transcript was fine". Silence
  // about quality is not evidence of quality.
  const raw = blank();
  raw.grammarErrors = [{ quote: "I first checked the stock ledger", kind: "tense" }];
  assert.equal(scoreAnswer(raw, TRANSCRIPT, undefined).axes.grammar.score, undefined);
  assert.equal(verifyGrammarErrors(raw, TRANSCRIPT, undefined).errors.length, 0);
});

test("excluded spans are counted and reported, never silently dropped", () => {
  // "We ignored six spans we could not trust" is information the reviewer needs
  // in order to know how much the rating is actually over.
  const raw = blank();
  raw.grammarErrors = [
    { quote: "I first checked the stock ledger", kind: "tense" },
    { quote: "and then I called the vendor", kind: "agreement" },
  ];
  const out = scoreAnswer(raw, TRANSCRIPT, 0.5).axes.grammar;
  assert.equal(out.excluded, 2);
});

test("an invented grammar error is discarded like any other uncitable claim", () => {
  const raw = blank();
  raw.grammarErrors = [{ quote: "I has went to the warehouse", kind: "tense" }];
  const { errors } = verifyGrammarErrors(raw, TRANSCRIPT, 0.95);
  assert.equal(errors.length, 0, "the span is not in the transcript, so it never happened");
});

test("a short answer is not a writing sample", () => {
  // Two clumsy clauses in fifteen words is a 13% error rate that means nothing.
  const short = "We had a shortfall and I called them.";
  const raw = blank();
  raw.grammarErrors = [{ quote: "We had a shortfall", kind: "article" }];
  assert.equal(scoreAnswer(raw, short, 0.99).axes.grammar.reason, "answer_too_short");
});

test("grammar bands run the right way and a clean answer tops out", () => {
  assert.equal(grammarStars(0), 5);
  assert.ok(grammarStars(2) > grammarStars(8));
  assert.equal(grammarStars(40), 1, "the floor is 1, not 0 — the scale is stars");
});

// ---------------------------------------------------------------------------
// Aggregation and the rubric gate
// ---------------------------------------------------------------------------

test("aggregate reports what each axis is over, so a star cannot outrun its evidence", () => {
  const raw = blank();
  raw.identifiedARootCause = { value: true, quote: "the shortfall was upstream of us" };
  raw.proposedAConcreteAction = { value: true, quote: "I called the vendor to confirm" };
  const scored = scoreAnswer(raw, TRANSCRIPT, 0.9);

  const out = aggregate([
    { role: "candidate", kind: "answer", insights: scored },
    { role: "candidate", kind: "answer", insights: scored },
    { role: "ai", kind: "question", text: "ignored" },
    { role: "candidate", kind: "answer", declined: true, insights: scored },
  ]);

  assert.equal(out.answersScored, 2, "the declined answer and the question are not readings");
  const ps = out.cognitive.find((a) => a.axis === "problemSolving");
  assert.equal(ps.answersTotal, 2);
  assert.ok(ps.observations.length > 0, "the quotes travel with the aggregate");
});

test("an answer too short to observe anything from scores nothing, not zero", () => {
  // Found by this test rather than by review: without a word floor, a six-word
  // answer scored 0/5 on Vocabulary and Coherence. The model answered "no" to
  // every observable, correctly, and code turned four noes into a zero,
  // correctly — and the result was still a measurement of how short an answer
  // the QUESTION invited, printed under the candidate's name.
  const empty = scoreAnswer(blank(), "We had a shortfall.", 0.99);
  for (const axis of Object.keys(empty.axes)) {
    assert.equal(empty.axes[axis].score, undefined, `${axis} must abstain on a six-word answer`);
  }
  assert.equal(aggregate([{ role: "candidate", kind: "answer", insights: empty }]), null);
});

test("a panel where nothing could be measured is null, not a row of zeroes", () => {
  const raw = blank();
  raw.identifiedARootCause = { value: true, quote: "the shortfall was upstream of us" };
  // Long enough to observe, but the audio was poor — so grammar abstains while
  // the axes that do not depend on transcription quality still read.
  const scored = scoreAnswer(raw, TRANSCRIPT, 0.2);
  const out = aggregate([{ role: "candidate", kind: "answer", insights: scored }]);
  assert.equal(out.communication.find((a) => a.axis === "grammar").score, undefined);
  assert.equal(out.communication.find((a) => a.axis === "grammar").reason, "transcription_unreliable");
  assert.ok(out.cognitive.some((a) => a.score !== undefined), "the cognitive axes still read");
});

test("aggregate returns null rather than an empty shell when there is nothing at all", () => {
  assert.equal(aggregate([]), null);
  assert.equal(aggregate(null), null);
  assert.equal(aggregate([{ role: "candidate", kind: "answer" }]), null, "a turn with no insights is not a reading");
});

test("communication is off unless a human declared it AND wrote down why", () => {
  // Job-relatedness is the entire legal basis for assessing how someone
  // communicates. A declaration with no stated reason is not a declaration.
  assert.equal(communicationEnabled(null), false);
  assert.equal(communicationEnabled({ spokenCommunication: { enabled: true } }), false, "no justification");
  assert.equal(communicationEnabled({ spokenCommunication: { enabled: true, justification: "   " } }), false);
  assert.equal(communicationEnabled({ spokenCommunication: { enabled: true, justification: "Client-facing role." } }), true);
});

test("a candidate's exclusion request always wins", () => {
  const rubric = { spokenCommunication: { enabled: true, justification: "Client-facing role." } };
  assert.equal(communicationEnabled(rubric, { excluded: true }), false);
});

// ---------------------------------------------------------------------------
// The contract itself
// ---------------------------------------------------------------------------

test("the schema asks for no numbers at all", () => {
  // The moment a numeric field appears here, the model is rating someone again
  // and every guarantee above is decorative.
  const json = JSON.stringify(INSIGHT_SCHEMA);
  assert.ok(!/"type"\s*:\s*"(number|integer)"/.test(json), "no numeric field may exist in the extraction contract");
});

test("every indicator is actually asked of the model", () => {
  // An indicator with no question in the prompt is one the model answers by
  // guessing, and a guess that gets cited by coincidence still scores.
  const unasked = INDICATOR_NAMES.filter((n) => !ASKS[n]);
  assert.deepEqual(unasked, [], "these indicators are scored but never asked");
});

test("the panels are the ones the report renders, and grammar is the only special case", () => {
  assert.equal(COGNITIVE_AXES.length, 8);
  assert.equal(COMMUNICATION_AXES.length, 5);
  assert.ok(COMMUNICATION_AXES.includes("grammar"));
  const special = Object.keys(AXES).filter((a) => AXES[a].special);
  assert.deepEqual(special, ["grammar"]);
});

test("the grammar confidence floor is high enough to mean something", () => {
  assert.ok(GRAMMAR_MIN_CONFIDENCE >= 0.7, "a floor below 0.7 is not a gate, it is a formality");
});
