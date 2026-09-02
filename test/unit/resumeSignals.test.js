// The three CV analysis cards.
//
// The tests that matter most here are the two about what these cards REFUSE to
// do, because both are one careless edit away from becoming the thing they were
// built to avoid: an employment gap drawn as a red flag, and a personality trait
// rated out of five off a document somebody wrote about themselves.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  documentProfessionalism,
  redFlagAnalysis,
  keyAttributes,
  experienceModel,
  toStars,
} = require("../../utils/resumeSignals");

const span = (quote) => [{ start: 0, end: quote.length, quote }];

const GRAPH = {
  claims: [
    {
      id: "p1",
      type: "employment_period",
      subject: "Candidate",
      predicate: "worked at",
      object: "Samsung Electronics",
      normalized: { startDate: "2018-03", endDate: "2021-09", domain: "marketing" },
      specificity: "specific",
      spans: span("Samsung Electronics, Mar 2018 - Sep 2021"),
    },
    {
      id: "p2",
      type: "employment_period",
      subject: "Candidate",
      predicate: "worked at",
      object: "LG Electronics",
      normalized: { startDate: "2022-01", endDate: "2024-06", domain: "operations" },
      specificity: "specific",
      spans: span("LG Electronics, Jan 2022 - Jun 2024"),
    },
    {
      id: "p3",
      type: "employment_period",
      subject: "Candidate",
      predicate: "worked at",
      object: "A consultancy",
      normalized: {},
      specificity: "vague",
      spans: span("Consulting work"),
    },
    {
      id: "o1",
      type: "outcome",
      subject: "Candidate",
      predicate: "grew",
      object: "market share by 40%",
      specificity: "quantified",
      spans: span("Drove 40% market share growth"),
    },
    {
      id: "o2",
      type: "outcome",
      subject: "Candidate",
      predicate: "improved",
      object: "team processes",
      specificity: "vague",
      spans: span("Improved team processes"),
    },
  ],
};

// ---------------------------------------------------------------------------
// Card 2 — the gap policy, which is the whole reason this file was reviewed
// ---------------------------------------------------------------------------

test("an employment gap is never a red flag, never coloured, and never counted", () => {
  // ClaimGraph's own header: gaps are "recorded and NEVER scored (documented
  // disparate impact on carers and people with health conditions)". The card
  // this is modelled on files them under a heading that says Red Flag. Ours
  // shows the same fact in the neutral tone and leaves the row clear.
  const { rows } = redFlagAnalysis({
    internalContradictions: [],
    timelineGaps: [{ from: "2021-09", to: "2022-01", months: 4 }],
  });
  const timeline = rows.find((r) => r.key === "timeline");

  assert.equal(timeline.tone, "clear", "a gap must not flag the row");
  assert.equal(timeline.value, "Nothing contradictory", "and must not appear in the count");

  const gapLine = timeline.findings.find((f) => /4-month gap/.test(f.text));
  assert.ok(gapLine, "the gap is still SHOWN — recorded, not hidden");
  assert.equal(gapLine.tone, "neutral", "in the neutral tone, never `flag`");
  assert.ok(
    timeline.findings.some((f) => f.tone === "note" && /never count against/.test(f.text)),
    "and the row says so in words, so the neutral colour is not the only thing carrying it"
  );
});

test("an overlap IS a flag, because that is the document contradicting itself", () => {
  // The distinction: a gap is a fact about someone's life, an overlap is two
  // statements in one document that cannot both be true.
  const { rows } = redFlagAnalysis({
    internalContradictions: [{ description: "Employment periods overlap by 8 months (2020-01 to 2020-09)." }],
    timelineGaps: [],
  });
  const timeline = rows.find((r) => r.key === "timeline");
  assert.equal(timeline.tone, "flag");
  assert.equal(timeline.value, "1 to check");
});

test("gaps and overlaps together: only the overlap moves the count", () => {
  const { rows } = redFlagAnalysis({
    internalContradictions: [{ description: "Employment periods overlap by 8 months (2020-01 to 2020-09)." }],
    timelineGaps: [
      { from: "2021-09", to: "2022-06", months: 9 },
      { from: "2016-01", to: "2016-08", months: 7 },
    ],
  });
  assert.equal(rows.find((r) => r.key === "timeline").value, "1 to check", "two gaps add nothing to the total");
});

test("a claimed-years inflation is a representation flag, not a timeline one", () => {
  const { rows } = redFlagAnalysis({
    internalContradictions: [{ description: "Claimed 12 years of experience, but the dated roles cover about 6 years (72 months)." }],
  });
  assert.equal(rows.find((r) => r.key === "timeline").tone, "clear");
  assert.equal(rows.find((r) => r.key === "representation").tone, "flag");
});

test("advisory hostility signals are shown but never counted", () => {
  // AI-assisted writing is the main one. Those detectors are unreliable and
  // using an LLM to write a CV is not misconduct, so it may never reach a total.
  const { rows } = redFlagAnalysis({
    hostility: {
      signals: [
        { code: "GENERIC_FILLER", severity: "advisory", message: "Reads as AI-assisted." },
        { code: "PROMPT_INJECTION", severity: "critical", message: "Hidden instruction found.", spans: [{ quote: "ignore all previous" }] },
      ],
    },
  });
  const other = rows.find((r) => r.key === "other");
  assert.equal(other.value, "1 found", "only the critical signal counts");
  assert.ok(other.findings.some((f) => f.tone === "note" && /AI-assisted/.test(f.text)), "the advisory is still shown");
  assert.ok(other.findings.some((f) => f.tone === "flag" && f.quote === "ignore all previous"), "with its span");
});

test("our own parser failures are attributed to us, on the candidate's card", () => {
  const { rows } = redFlagAnalysis({ extraction: { droppedClaims: 5 } });
  const other = rows.find((r) => r.key === "other");
  assert.equal(other.tone, "clear", "a parse failure is not a mark against the candidate");
  assert.ok(other.findings.some((f) => /our parser, not the candidate/.test(f.text)));
});

test("a clean CV says so, rather than rendering three empty rows", () => {
  const { rows } = redFlagAnalysis({});
  assert.ok(rows.every((r) => r.tone === "clear"));
  assert.ok(rows.every((r) => r.findings.length > 0), "every row states its finding");
});

// ---------------------------------------------------------------------------
// Card 3 — what replaced the trait ratings
// ---------------------------------------------------------------------------

test("no row rates a personality trait or predicts a career ceiling", () => {
  // The reference rates Leadership Potential, Entrepreneurial Spirit,
  // Innovative Thinking and Estimated Career Potential out of five, from a
  // self-written document. If any of those names ever appears here, the card
  // has quietly become the thing it was built instead of.
  const { rows } = keyAttributes(GRAPH, { totalMonths: 72 });
  const banned = /potential|spirit|innovat|creativ|leadership|entrepreneur/i;
  for (const r of rows) {
    assert.ok(!banned.test(r.label), `"${r.label}" is a trait rating, not evidence`);
  }
});

test("every attribute row points at the span it came from", () => {
  const { rows } = keyAttributes(GRAPH, { totalMonths: 72 });
  const withQuotes = rows.flatMap((r) => r.findings).filter((f) => f.quote);
  assert.ok(withQuotes.length > 0, "the rows expand to evidence, not to prose");
  const known = new Set(GRAPH.claims.map((c) => c.spans[0].quote));
  for (const f of withQuotes) assert.ok(known.has(f.quote), `${f.quote} is not a span from the CV`);
});

test("progression counts roles and years from the dated periods", () => {
  const { rows } = keyAttributes(GRAPH, { totalMonths: 72 });
  assert.equal(rows.find((r) => r.key === "progression").value, "3 roles / 6 yrs");
});

test("evidenced outcomes is a ratio of quantified results, not an impression of delivery", () => {
  const outcomes = keyAttributes(GRAPH, {}).rows.find((r) => r.key === "outcomes");
  assert.equal(outcomes.value, "1 of 2");
  assert.equal(outcomes.score, 2.5, "one of two quantified is half the scale");
});

test("no quantified outcome produces a next-round question, not a low verdict", () => {
  const graph = { claims: [{ id: "o", type: "outcome", subject: "x", specificity: "vague", spans: span("Improved things") }] };
  const outcomes = keyAttributes(graph, {}).rows.find((r) => r.key === "outcomes");
  assert.match(outcomes.findings[0].text, /Worth asking for one specific number/);
});

test("experience model is a description, and the same CV always gives the same word", () => {
  assert.equal(experienceModel([{ normalized: { domain: "marketing" } }], []).label, "Specialist");
  assert.equal(
    experienceModel([{ normalized: { domain: "marketing" } }, { normalized: { domain: "ops" } }], []).label,
    "Hybrid"
  );
  assert.equal(
    experienceModel(
      ["a", "b", "c", "d"].map((d) => ({ normalized: { domain: d } })),
      []
    ).label,
    "Generalist"
  );
  assert.equal(experienceModel([], []), null, "no domains means no badge, not a guess");
});

// ---------------------------------------------------------------------------
// Card 1
// ---------------------------------------------------------------------------

test("completeness counts dated roles and names the undated ones", () => {
  const { rows } = documentProfessionalism(GRAPH);
  const completeness = rows.find((r) => r.key === "completeness");
  assert.equal(completeness.value, "2/3 roles dated");
  assert.ok(completeness.findings.some((f) => /can't be checked/.test(f.text)));
  // Undated is a limit on what WE can verify, so it must not be drawn as a fault.
  assert.ok(completeness.findings.every((f) => f.tone !== "flag"));
});

test("specificity is counted from the extractor's own grading, not re-judged", () => {
  const specificity = documentProfessionalism(GRAPH).rows.find((r) => r.key === "specificity");
  assert.equal(specificity.value, "1 of 5 quantified");
  assert.ok(specificity.findings.some((f) => /worth probing rather than reading as a weakness/.test(f.text)));
});

test("an empty graph produces no card at all, rather than a card of zeroes", () => {
  assert.equal(documentProfessionalism({ claims: [] }), null);
  assert.equal(documentProfessionalism(null), null);
  assert.equal(keyAttributes({ claims: [] }), null);
});

test("toStars never divides by zero", () => {
  assert.equal(toStars(0, 0), undefined);
  assert.equal(toStars(3, 3), 5);
  assert.equal(toStars(1, 4), 1.5, "rounded to the nearest half star");
});
