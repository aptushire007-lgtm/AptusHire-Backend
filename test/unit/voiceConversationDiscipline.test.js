// Repeat discipline + conversation-control evidence hygiene — the two remaining ways the
// 2026-08-18 session's conversation went off the rails server-side.
//
// REPEATS. get_next_question legitimately re-returns the open question ("could you repeat
// that?"), but the only guard was client-side and re-armed on ANY candidate speech — so a
// confused model re-asked one question three times, against "You asked me this." Now the server
// decides: redelivery is earned by an actual repeat request (utils/repeatIntent, the same
// deterministic trigger list every path uses), never by the model feeling lost.
//
// CONTROL SPEECH. "I want to end this interview" is a dialogue act aimed at the interviewer. It
// was recorded inside a scored answer, because a realtime answer accumulates everything since the
// last successful submit. dialogueActs.splitTrailingWithdraw now strips the trailing request from
// the evidence and routes it into the same confirm-then-end flow the engine already owns.
//
// Pure and offline: no DB, no socket, no provider.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const voiceAgent = require("../../services/voiceAgentService");
const aiInterview = require("../../services/aiInterviewService");
const dialogueActs = require("../../utils/dialogueActs");

const QUESTION = "Can you describe how you designed the MongoDB schema for chat histories?";

function stubSession({ agentUtterances = [], candidateUtterances = [] } = {}) {
  return {
    _id: "s1",
    company: "c1",
    aiInterview: {
      status: "in_progress",
      questionCount: 1,
      maxQuestions: 8,
      turns: [{ role: "ai", kind: "question", text: QUESTION }],
      backchannels: [],
      probes: [],
      mustAsk: [],
      agentUtterances,
      candidateUtterances,
    },
    save: async () => {},
  };
}

// ---------------------------------------------------------------------------
// 1. Repeat discipline — redelivery is earned, never assumed
// ---------------------------------------------------------------------------

test("1.1: before any delivery, get_next_question hands out the question (the relay race is safe)", async () => {
  const out = await voiceAgent.dispatch(stubSession(), "get_next_question", {});
  assert.equal(out.question, QUESTION);
});

test("1.2: after delivery, with no repeat request, redelivery is refused — wait for the answer", async () => {
  const session = stubSession({
    agentUtterances: [{ text: `Got it — thank you. ${QUESTION}`, at: new Date() }],
    // The 2026-08-18 utterance exactly: a complaint about the rerun, not a repeat request.
    candidateUtterances: [{ text: "You asked me this.", at: new Date() }],
  });
  const out = await voiceAgent.dispatch(session, "get_next_question", {});
  assert.match(out.error, /already been asked/i);
  assert.match(out.instruction, /Wait in silence/i);
  assert.equal(out.question, undefined, "the refusal carries no speakable question");
});

test("1.3: an actual repeat request earns the redelivery", async () => {
  const session = stubSession({
    agentUtterances: [{ text: `Got it — thank you. ${QUESTION}`, at: new Date() }],
    candidateUtterances: [{ text: "Sorry, could you repeat that?", at: new Date() }],
  });
  const out = await voiceAgent.dispatch(session, "get_next_question", {});
  assert.equal(out.question, QUESTION);
});

test("1.4: the repeat cap holds — a fifth rerun is refused even on a genuine request", async () => {
  const delivery = { text: QUESTION, at: new Date() };
  const session = stubSession({
    agentUtterances: [delivery, delivery, delivery, delivery],
    candidateUtterances: [{ text: "Could you repeat that?", at: new Date() }],
  });
  const out = await voiceAgent.dispatch(session, "get_next_question", {});
  assert.match(out.error, /maximum number of times/i);
  assert.equal(out.question, undefined);
});

// ---------------------------------------------------------------------------
// 2. splitTrailingWithdraw — the evidence keeps the answer, the act routes to the end flow
// ---------------------------------------------------------------------------

test("2.1: a trailing end request is split off the answer, pleasantries travelling with it", () => {
  const split = dialogueActs.splitTrailingWithdraw(
    "I used one collection per session with a compound index. I want to end this interview. Thank you."
  );
  assert.equal(split.withdrawRequested, true);
  assert.equal(split.text, "I used one collection per session with a compound index.");
  assert.equal(split.withdrawText, "I want to end this interview. Thank you.");
});

test("2.2: a withdraw phrase in the MIDDLE of an answer is evidence and stays put", () => {
  const answer =
    "I told the PM I want to stop shipping on Fridays. So we moved the release train to Tuesdays.";
  const split = dialogueActs.splitTrailingWithdraw(answer);
  assert.equal(split.withdrawRequested, false);
  assert.equal(split.text, answer);
});

test("2.3: a whole-turn request splits to an empty answer", () => {
  const split = dialogueActs.splitTrailingWithdraw("I want to end the interview.");
  assert.equal(split.withdrawRequested, true);
  assert.equal(split.text, "");
});

// ---------------------------------------------------------------------------
// 3. The dispatch seam — recorded clean, routed to confirm
// ---------------------------------------------------------------------------

test("3.1: answer + trailing request → answer recorded WITHOUT the request, confirm flow instructed", async () => {
  const session = stubSession();
  const realSubmit = aiInterview.submitAnswer;
  let recordedText = null;
  aiInterview.submitAnswer = async (s, text) => {
    recordedText = text;
    return { completed: false, currentQuestion: "next?", questionId: "q2", questionCount: 2, maxQuestions: 8 };
  };
  try {
    const out = await voiceAgent.dispatch(
      session,
      "submit_answer",
      { answer: "", declined: false },
      { transcript: "I used one collection per session with a compound index. I want to end this interview." }
    );
    assert.equal(recordedText, "I used one collection per session with a compound index.");
    assert.equal(out.end_requested, true);
    assert.match(out.instruction, /confirm/i);
    assert.match(out.instruction, /Do NOT ask the question/i);
  } finally {
    aiInterview.submitAnswer = realSubmit;
  }
});

test("3.2: a whole-turn request records NOTHING and carries no error (the worker must not re-buffer it)", async () => {
  const session = stubSession();
  const realSubmit = aiInterview.submitAnswer;
  const realAct = aiInterview.submitDialogueAct;
  aiInterview.submitAnswer = async () => { throw new Error("nothing to record"); };
  aiInterview.submitDialogueAct = async () => { throw new Error("nothing to record"); };
  try {
    const out = await voiceAgent.dispatch(
      session,
      "submit_answer",
      { answer: "", declined: false },
      { transcript: "I want to end this interview." }
    );
    assert.equal(out.end_requested, true);
    assert.equal(out.recorded, false);
    assert.equal(out.error, undefined, "no error key: these words must not return to the answer buffer");
    assert.match(out.instruction, /confirm/i);
  } finally {
    aiInterview.submitAnswer = realSubmit;
    aiInterview.submitDialogueAct = realAct;
  }
});
