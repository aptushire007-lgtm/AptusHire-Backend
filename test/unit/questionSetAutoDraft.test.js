// Zero-setup question sets: the recruiter never faces a blank page.
//
// An approval workflow that opens with "now write eight interview questions" is one nobody
// completes, and the tenant has already given us everything needed to write them — the job
// description and the approved rubric. So the set is compiled, and the recruiter reads it.
//
// The gates that matter here are about what a COMPILER is allowed to put in front of a
// candidate. A model is an unreliable source of legally-sensitive text, so the guarantee is the
// deterministic gate, never the prompt:
//   - a proposed question that touches a protected characteristic is DROPPED, not repaired;
//   - with no model at all, the result is still a complete, approvable set;
//   - nothing reaches a candidate without a named human approving it.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const questionSetService = require("../../services/questionSetService");
const vetting = require("../../utils/questionVetting");
const { QUESTION_SET_SYSTEM, questionSetPrompt } = require("../../utils/questionSetPrompts");

const JOB = {
  title: "Backend Engineer",
  description: "Build and operate payment APIs.",
  requirements: "Strong Node.js, distributed systems.",
  requiredSkills: ["Node.js", "PostgreSQL", "Kafka"],
};

const RUBRIC = {
  version: 3,
  criteria: [
    { id: "c1", kind: "must_have", label: "Designs resilient distributed systems", rationale: "Core of the role" },
    { id: "c2", kind: "must_have", label: "Operates production services on call" },
    { id: "c3", kind: "nice_to_have", label: "Familiarity with event streaming" },
    { id: "c4", kind: "disqualifier", label: "No production experience at all" },
  ],
};

// ---------------------------------------------------------------------------
// 1. GATE — the compiler cannot put an unlawful question in front of a candidate
// ---------------------------------------------------------------------------

test("AD1.1: GATE — a model-proposed question about a protected characteristic is dropped, not fixed", () => {
  const { kept, dropped } = questionSetService.keepUsable(
    [
      { text: "Walk me through a system you designed end to end." },
      { text: "Do you have any children who might affect your on-call availability?" },
      { text: "What is your current CTC?" },
      { text: "Tell me about a production incident you owned." },
    ],
    8
  );
  assert.equal(kept.length, 2, "only the lawful questions survive");
  assert.equal(dropped.length, 2);
  for (const d of dropped) {
    assert.ok(d.issues.some((i) => i.code.startsWith("protected_")), `dropped for the right reason: ${d.text}`);
  }
  for (const k of kept) {
    assert.equal(vetting.questionIssues(k.text).length, 0, "everything kept passes the same gate a recruiter's typing does");
  }
});

test("AD1.2: what was blocked is surfaced, not silently swallowed", () => {
  const { dropped } = questionSetService.keepUsable([{ text: "Are you planning to start a family?" }], 8);
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0].text, "the offending text is kept so a recruiter can see what was proposed");
  assert.ok(dropped[0].issues.length, "and why it was refused");
});

test("AD1.3: duplicates and blanks are removed, and the target is a hard cap", () => {
  const { kept } = questionSetService.keepUsable(
    [
      { text: "Walk me through a system you designed end to end." },
      { text: "walk me through a system you designed end to end." },
      { text: "   " },
      { text: "Tell me about a production incident you owned." },
      { text: "Describe a technical decision you disagreed with." },
    ],
    2
  );
  assert.equal(kept.length, 2, "capped");
  assert.notEqual(kept[0].text.toLowerCase(), kept[1].text.toLowerCase(), "de-duplicated");
});

// ---------------------------------------------------------------------------
// 2. No model, no problem — the deterministic path is a real instrument
// ---------------------------------------------------------------------------

test("AD2.1: with no LLM at all, the anchors produce a complete and APPROVABLE set", () => {
  const candidates = questionSetService.deterministicCandidates(JOB, RUBRIC);
  const { kept } = questionSetService.keepUsable(candidates, questionSetService.TARGET_QUESTIONS);
  assert.equal(kept.length, questionSetService.TARGET_QUESTIONS, "a full set, not a stub");

  // The real test: it must pass the same approval gate a hand-authored set does.
  const verdict = vetting.vetQuestions(questionSetService.withIds(kept));
  assert.equal(verdict.ok, true, `the fallback set must be approvable: ${JSON.stringify(verdict.issues)}`);
});

test("AD2.2: the deterministic set is grounded in this role, not eight generic questions", () => {
  const candidates = questionSetService.deterministicCandidates(JOB, RUBRIC);
  const text = candidates.map((c) => c.text).join(" ");
  assert.match(text, /resilient distributed systems/i, "must-have criteria become questions");
  assert.match(text, /Node\.js/, "required skills become questions");
  assert.ok(
    !/No production experience at all/i.test(text),
    "a disqualifier is a gate, never something to ask a candidate about"
  );
});

test("AD2.3: every anchor question is itself lawful and askable", () => {
  const verdict = vetting.vetQuestions(questionSetService.withIds(questionSetService.ANCHOR_QUESTIONS.map((t) => ({ text: t }))));
  assert.equal(verdict.ok, true, `the anchors ship in the product: ${JSON.stringify(verdict.issues)}`);
});

test("AD2.4: a job with no rubric and no skills still yields a full set", () => {
  const bare = questionSetService.deterministicCandidates({ title: "Analyst" }, null);
  const { kept } = questionSetService.keepUsable(bare, questionSetService.TARGET_QUESTIONS);
  assert.equal(kept.length, questionSetService.TARGET_QUESTIONS);
  assert.equal(vetting.vetQuestions(questionSetService.withIds(kept)).ok, true);
});

// ---------------------------------------------------------------------------
// 3. Idempotency — opening the screen repeatedly must not spend or churn
// ---------------------------------------------------------------------------

test("AD3.1: the source hash covers the JD, the rubric version and the prompt version", () => {
  const base = questionSetService.sourceHashOf(JOB, RUBRIC);
  assert.equal(questionSetService.sourceHashOf(JOB, RUBRIC), base, "stable for identical input");
  assert.notEqual(
    questionSetService.sourceHashOf({ ...JOB, description: "Rewritten." }, RUBRIC),
    base,
    "a rewritten JD must produce a fresh draft"
  );
  assert.notEqual(
    questionSetService.sourceHashOf(JOB, { ...RUBRIC, version: 4 }),
    base,
    "a newly approved rubric must produce a fresh draft"
  );
});

// ---------------------------------------------------------------------------
// 4. The prompt tells the model the rules — belt as well as braces
// ---------------------------------------------------------------------------

test("AD4.1: the compiler prompt forbids protected-characteristic questions up front", () => {
  for (const term of ["age", "religion", "caste", "visa", "disability", "salary history"]) {
    assert.match(QUESTION_SET_SYSTEM, new RegExp(term, "i"), `the prompt must name ${term} as off limits`);
  }
  assert.match(QUESTION_SET_SYSTEM, /discarded/i, "and say what happens if it ignores that");
});

test("AD4.2: the rubric's criteria are what the questions are compiled against", () => {
  const prompt = questionSetPrompt({ sourceText: "JOB TITLE: Backend Engineer", criteria: RUBRIC.criteria, count: 8 });
  assert.match(prompt, /c1/, "criteria are passed by id so coverage is traceable");
  assert.match(prompt, /Designs resilient distributed systems/);
  assert.ok(!/No production experience at all/.test(prompt), "disqualifiers are gates, not interview topics");
});

test("AD4.3: the model is never asked for a number — not a score, not a weight", () => {
  const { QUESTION_SET_SCHEMA } = require("../../utils/questionSetPrompts");
  const props = QUESTION_SET_SCHEMA.properties.questions.items.properties;
  for (const [name, spec] of Object.entries(props)) {
    assert.equal(spec.type, "string", `${name} must not be a number the model chooses`);
  }
});
