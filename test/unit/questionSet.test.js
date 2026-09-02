// Recruiter-approved must-ask question sets.
//
// The gates that must never regress:
//   - an approved question is asked VERBATIM, by code, with no model call — a paraphrase is a
//     different question, and "we asked everyone the same thing" dies the moment one candidate
//     gets the recruiter's wording and the next gets the model's;
//   - the interview cannot close while an approved question is unasked;
//   - a question about a protected characteristic cannot be approved at all;
//   - a set with no approved version is a fully working interview, not a blocked one.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const aiInterview = require("../../services/aiInterviewService");
const questionSetService = require("../../services/questionSetService");
const vetting = require("../../utils/questionVetting");

function ai(overrides = {}) {
  return {
    turns: [],
    askedQuestions: [],
    questionCount: 0,
    minQuestions: 5,
    maxQuestions: 8,
    probes: [],
    mustAsk: [],
    ...overrides,
  };
}

function mustAsk(n, status = "pending") {
  return Array.from({ length: n }, (_, i) => ({
    questionId: `q${i + 1}`,
    text: `Approved question ${i + 1}: walk me through something you built.`,
    topic: "",
    status,
  }));
}

// ---------------------------------------------------------------------------
// 1. Required coverage — the interview cannot end without the approved set
// ---------------------------------------------------------------------------

test("QS1.1: an interview cannot close while an approved question is unasked", () => {
  const withPending = ai({ mustAsk: mustAsk(2), questionCount: 8 });
  assert.equal(aiInterview.closingAllowed(withPending), false, "length alone must not unlock closing");

  const covered = ai({ mustAsk: mustAsk(2, "asked"), questionCount: 8 });
  assert.equal(aiInterview.closingAllowed(covered), true);
});

test("QS1.2: approved-set coverage is required ON TOP of claim-probe coverage, not instead of it", () => {
  const probesPending = ai({
    mustAsk: mustAsk(1, "asked"),
    probes: [{ claimId: "c1", status: "pending" }],
    questionCount: 8,
  });
  assert.equal(aiInterview.closingAllowed(probesPending), false);
});

test("QS1.3: a job with no approved set closes exactly as it did before", () => {
  assert.equal(aiInterview.closingAllowed(ai({ mustAsk: [], questionCount: 5 })), true);
  assert.equal(aiInterview.closingAllowed(ai({ mustAsk: [], questionCount: 4 })), false, "minQuestions still applies");
});

// ---------------------------------------------------------------------------
// 2. Selection — verbatim, and alternating with adaptive follow-ups
// ---------------------------------------------------------------------------

test("QS2.1: the first real question is the first approved one, in order", () => {
  const state = ai({ mustAsk: mustAsk(3), turns: [{ role: "ai", kind: "warmup", text: "Introduce yourself?" }] });
  const chosen = aiInterview.chooseMustAsk(state);
  assert.equal(chosen.questionId, "q1", "approved questions are asked in the order the recruiter set");
});

test("QS2.2: after an approved question, the turn goes to the adaptive engine to follow up", () => {
  const state = ai({
    mustAsk: [{ ...mustAsk(1)[0], status: "asked" }, ...mustAsk(2).slice(0, 2)],
    questionCount: 1,
    turns: [{ role: "ai", kind: "question", text: "Approved question 1", mustAskId: "q1" }],
  });
  assert.equal(aiInterview.chooseMustAsk(state), null, "a follow-up on what they just said comes next");
});

test("QS2.3: after a follow-up, the next approved question is delivered", () => {
  const state = ai({
    mustAsk: mustAsk(2),
    questionCount: 2,
    turns: [{ role: "ai", kind: "question", text: "An adaptive follow-up?" }],
  });
  assert.equal(aiInterview.chooseMustAsk(state)?.questionId, "q1");
});

test("QS2.4: when the budget runs short, coverage wins and alternation stops", () => {
  // 3 approved + 1 probe still to cover, but only 4 questions left: every remaining slot is spoken for.
  const state = ai({
    mustAsk: mustAsk(3),
    probes: [{ claimId: "c1", status: "pending" }],
    questionCount: 4,
    maxQuestions: 8,
    turns: [{ role: "ai", kind: "question", text: "Approved question 0", mustAskId: "q0" }],
  });
  assert.equal(
    aiInterview.chooseMustAsk(state)?.questionId,
    "q1",
    "an approved question is the part that must not be dropped"
  );
});

test("QS2.5: nothing is chosen once every approved question has been asked", () => {
  assert.equal(aiInterview.chooseMustAsk(ai({ mustAsk: mustAsk(2, "asked") })), null);
  assert.equal(aiInterview.chooseMustAsk(ai({ mustAsk: [] })), null);
});

test("QS2.6: an approved question the candidate talked over goes back to pending", () => {
  const turn = { mustAskId: "q1", text: "A".repeat(100), interruptedAtChar: 10 };
  assert.equal(aiInterview.mustAskUncoveredByInterruption(turn), true, "cut in on the opening clause — not heard");

  const nearlyDone = { mustAskId: "q1", text: "A".repeat(100), interruptedAtChar: 95 };
  assert.equal(aiInterview.mustAskUncoveredByInterruption(nearlyDone), false, "cut in on the last words — heard");

  const notInterrupted = { text: "A".repeat(100) };
  assert.equal(aiInterview.mustAskUncoveredByInterruption(notInterrupted), false, "no approved question, nothing to revert");
});

// ---------------------------------------------------------------------------
// 3. BIAS/LEGAL GATE — what a recruiter may not put in front of every candidate
// ---------------------------------------------------------------------------

test("QS3.1: LEGAL GATE — questions about protected characteristics cannot be approved", () => {
  const banned = [
    "How old are you?",
    "What is your date of birth?",
    "Are you married?",
    "Do you have any children?",
    "Are you planning to start a family soon?",
    "What is your religion?",
    "Which caste do you belong to?",
    "What is your ethnicity?",
    "Where are you originally from?",
    "What is your visa status?",
    "Will you need sponsorship?",
    "Do you have any disability we should know about?",
    "Tell me about your mental health.",
    "What is your current salary?",
    "What is your current CTC?",
    "Do you have a criminal record?",
    "What are your political views?",
    "What is your sexual orientation?",
  ];
  for (const q of banned) {
    const { ok, issues } = vetting.vetQuestions([q]);
    assert.equal(ok, false, `must be blocked: ${q}`);
    assert.ok(
      issues.some((i) => i.code.startsWith("protected_")),
      `must be blocked as a protected characteristic, not incidentally: ${q}`
    );
  }
});

test("QS3.2: the guard does not cry wolf on legitimate technical questions", () => {
  const allowed = [
    "How do you handle cache age and invalidation in a read-heavy service?",
    "Walk me through how you decide when a background job has failed permanently.",
    "Tell me about a production incident you owned end to end.",
    "Are you legally authorised to work in India?",
    "How do you approach health checks and readiness probes for a service?",
    "Describe how you would design a family of related API endpoints.",
    "What does good code review culture look like to you?",
  ];
  for (const q of allowed) {
    const { ok, issues } = vetting.vetQuestions([q]);
    assert.equal(ok, true, `must be allowed: ${q} — got ${JSON.stringify(issues)}`);
  }
});

test("QS3.3: accusatory phrasing is blocked, reusing the probe guardrail", () => {
  const { ok, issues } = vetting.vetQuestions(["Your resume claims you led that migration — can you prove it?"]);
  assert.equal(ok, false);
  assert.ok(issues.some((i) => i.code.startsWith("accusatory_")));
});

test("QS3.4: structural problems are caught with the question index, not just a bare failure", () => {
  const { ok, issues } = vetting.vetQuestions([
    "Walk me through a system you designed end to end.",
    "Why?",
    "Walk me through a system you designed end to end.",
  ]);
  assert.equal(ok, false);
  assert.ok(issues.some((i) => i.index === 1 && i.code === "too_short"), "the fragment is named by position");
  assert.ok(issues.some((i) => i.index === 2 && i.code === "duplicate"), "a repeat would be asked twice");
});

test("QS3.5: an empty set cannot be approved, and an oversized one is capped", () => {
  assert.equal(vetting.vetQuestions([]).ok, false);
  const tooMany = Array.from({ length: vetting.MAX_QUESTIONS_PER_SET + 1 }, (_, i) => `Tell me about project number ${i} you worked on.`);
  const { ok, issues } = vetting.vetQuestions(tooMany);
  assert.equal(ok, false);
  assert.ok(issues.some((i) => i.code === "too_many"));
});

test("QS3.6: every issue carries a message written for the person who has to fix it", () => {
  for (const issue of vetting.vetQuestions(["How old are you?"]).issues) {
    assert.equal(typeof issue.message, "string");
    assert.ok(issue.message.length > 20, "a code alone is not an explanation");
  }
});

// ---------------------------------------------------------------------------
// 4. Ids and resolution
// ---------------------------------------------------------------------------

test("QS4.1: question ids are assigned by the server, never taken from the caller", () => {
  const out = questionSetService.withIds([
    { id: "attacker-controlled", text: "  Walk me through a system you built.  ", topic: "design" },
    "How do you approach debugging something unfamiliar?",
  ]);
  assert.deepEqual(out.map((q) => q.id), ["q1", "q2"], "ids are positional and server-owned");
  assert.equal(out[0].text, "Walk me through a system you built.", "text is trimmed");
  assert.equal(out[1].topic, "");
});

test("QS4.2: review() vets without saving, so the authoring screen can warn while typing", () => {
  assert.equal(questionSetService.review(["How old are you?"]).ok, false);
  assert.equal(questionSetService.review(["Walk me through a system you designed end to end."]).ok, true);
});
