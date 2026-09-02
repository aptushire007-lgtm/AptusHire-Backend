// Every question passes one gate before it is spoken.
//
// THE REGRESSION. In the interview of 2026-08-25 the candidate was asked the same question twice
// three separate times, once word for word, and said so out loud. The approved question set was
// clean — eight distinct questions, each marked asked exactly once. The repeats came from the
// other direction: utils/interviewPrompts hands the model every PENDING approved question as text
// with an instruction not to ask them, and the model asked three of them anyway. The approved copy
// was then delivered verbatim a few turns later, by code, with no duplicate check on that path at
// all.
//
// So there were two holes and they only bite together:
//   1. the repeat guard compared a generated question against what had been ASKED, never against
//      what was still QUEUED — so pre-empting an approved question was invisible to it;
//   2. the approved-question delivery branch called nothing — a byte-identical repeat sailed
//      through.
// Section 1 covers the first, section 2 the second. Section 3 covers follow-ups, which had no
// duplicate check of any kind.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const aiInterview = require("../../services/aiInterviewService");
const followUpPrompts = require("../../utils/followUpPrompts");
const questionSimilarity = require("../../utils/questionSimilarity");

const CANVA = "Walk me through a project where you used graphic design tools like Canva or Adobe Express to create visuals for social media.";
const COMMUNITY = "Describe a situation where you managed a social media community, including how you handled comments and direct messages.";
const COMMUNITY_REWORDED = "Can you describe a situation where you managed a social media community, including how you handled comments and direct messages?";

function aiWith({ asked = [], mustAsk = [], turns = [], questionCount = 0, maxQuestions = 12 } = {}) {
  return {
    askedQuestions: [...asked],
    mustAsk: mustAsk.map((m) => ({ status: "pending", ...m })),
    turns: [...turns],
    probes: [],
    questionCount,
    maxQuestions,
  };
}

// ---------------------------------------------------------------------------
// 1. A queued approved question is off limits to the model
// ---------------------------------------------------------------------------

test("1.1: the forbidden list covers what is queued, not only what was asked", () => {
  const ai = aiWith({
    asked: ["Tell me about a time you created content for a social media campaign."],
    mustAsk: [{ questionId: "q2", text: CANVA }],
  });
  const forbidden = aiInterview.forbiddenQuestionTexts(ai);
  assert.ok(forbidden.includes(CANVA), "a pending approved question must be forbidden material");
  assert.equal(forbidden.length, 2);
});

test("1.2: the model's verbatim copy of a queued approved question is caught", () => {
  const ai = aiWith({ asked: [], mustAsk: [{ questionId: "q2", text: CANVA }] });
  const dup = questionSimilarity.findDuplicate(CANVA, aiInterview.forbiddenQuestionTexts(ai));
  assert.equal(dup.duplicate, true, "this is the exact repeat the candidate heard");
});

test("1.3: a reworded copy is caught too — two of the three repeats were rewordings", () => {
  const ai = aiWith({ asked: [], mustAsk: [{ questionId: "q6", text: COMMUNITY }] });
  const dup = questionSimilarity.findDuplicate(COMMUNITY_REWORDED, aiInterview.forbiddenQuestionTexts(ai));
  assert.equal(dup.duplicate, true, "equality alone would have missed this one");
});

test("1.4: an unrelated question is not blocked by a queued one", () => {
  const ai = aiWith({ asked: [], mustAsk: [{ questionId: "q2", text: CANVA }] });
  const dup = questionSimilarity.findDuplicate(
    "How do you decide which metrics matter when you report on a campaign?",
    aiInterview.forbiddenQuestionTexts(ai)
  );
  assert.equal(dup.duplicate, false);
});

test("1.5: with nothing queued the list is exactly the asked list — no behaviour change", () => {
  const asked = ["One.", "Two."];
  assert.deepEqual(aiInterview.forbiddenQuestionTexts(aiWith({ asked })), asked);
});

// ---------------------------------------------------------------------------
// 2. An approved question already covered is retired, not re-read
// ---------------------------------------------------------------------------

test("2.1: chooseMustAsk retires an approved question the model already asked", () => {
  const ai = aiWith({
    asked: [CANVA],
    mustAsk: [{ questionId: "q2", text: CANVA }, { questionId: "q3", text: "Describe an experience where you edited videos." }],
    turns: [{ role: "ai", kind: "question", text: CANVA }],
  });
  const chosen = aiInterview.chooseMustAsk(ai);
  assert.equal(ai.mustAsk[0].status, "asked", "q2 must not still be waiting to be read out");
  assert.equal(ai.mustAsk[0].preEmpted, true, "and the record must say it was never read out");
  assert.equal(chosen.questionId, "q3", "the interview moves to the next one instead of repeating");
});

test("2.2: the retired question points at the turn that actually covered it", () => {
  const ai = aiWith({
    asked: ["Something else.", CANVA],
    mustAsk: [{ questionId: "q2", text: CANVA }],
    turns: [
      { role: "ai", kind: "question", text: "Something else." },
      { role: "candidate", kind: "answer", text: "..." },
      { role: "ai", kind: "question", text: CANVA },
    ],
  });
  aiInterview.chooseMustAsk(ai);
  assert.equal(ai.mustAsk[0].turnIndex, 2, "'which turn asked q2?' must stay answerable");
});

test("2.3: an approved question nobody has covered is still delivered", () => {
  const ai = aiWith({
    asked: ["Tell me about a campaign you ran."],
    mustAsk: [{ questionId: "q2", text: CANVA }],
  });
  const chosen = aiInterview.chooseMustAsk(ai);
  assert.equal(chosen.questionId, "q2");
  assert.equal(ai.mustAsk[0].status, "pending");
  assert.equal(ai.mustAsk[0].preEmpted, undefined);
});

test("2.4: retiring is not skipping — coverage still counts it as asked", () => {
  // The distinction that makes this safe: a retired question leaves `pending` empty, so the
  // interview is not reported as having skipped part of the recruiter's instrument.
  const ai = aiWith({ asked: [CANVA], mustAsk: [{ questionId: "q2", text: CANVA }] });
  aiInterview.chooseMustAsk(ai);
  assert.equal(aiInterview.pendingMustAsk(ai).length, 0);
});

// ---------------------------------------------------------------------------
// 3. Follow-ups go through the same gate
// ---------------------------------------------------------------------------

test("3.1: a follow-up repeating an asked question is refused", () => {
  const asked = ["What specific images did you add to the Canva design template?"];
  const rejection = followUpPrompts.followUpRejectionFor(
    "What specific images did you add to the Canva design template?",
    "I added images to the Canva design template for the discount offers.",
    { term: "Canva design template", asked }
  );
  assert.match(String(rejection), /^repeat:/, `expected a repeat rejection, got ${rejection}`);
});

test("3.2: a genuinely new follow-up on the same answer still passes", () => {
  const asked = ["Walk me through a project where you used Canva."];
  const rejection = followUpPrompts.followUpRejectionFor(
    "Who signed off on the Canva templates before they went out?",
    "I built the Canva templates and the team used them for the discount offers.",
    { term: "Canva templates", asked }
  );
  assert.equal(rejection, null, `unexpected rejection: ${rejection}`);
});

test("3.3: with no asked list supplied the check is inert — older callers keep working", () => {
  const rejection = followUpPrompts.followUpRejectionFor(
    "Who signed off on the Canva templates?",
    "I built the Canva templates myself.",
    { term: "Canva templates" }
  );
  assert.equal(rejection, null);
});
