// The question-identity handshake — services/voiceAgentService.js + aiInterviewService.publicState.
//
// WHAT THIS PINS AND WHY. In the 2026-08-18 live session, the room model improvised a question the
// engine never authored, the candidate declined THAT question, and the engine recorded the decline
// against the still-open authored question — which the candidate had in fact answered. The answer
// itself was lost. Nothing carried the identity of "which question is this answer for" across the
// wire, so the engine attached whatever arrived to whatever it thought was current.
//
// The handshake closes that structurally: every question payload carries a `question_id` (the
// question turn's index in the append-only turns array), the WORKER echoes it back on submit_answer
// (code, never the model — a model asked to echo an ID will eventually echo the wrong one), and a
// mismatch is refused without recording anything. Refusing is always safe because the worker keeps
// the drained transcript buffered on any error result (agent.py _restore_answer).
//
// Pure and offline: no DB, no socket, no provider.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const voiceAgent = require("../../services/voiceAgentService");
const aiInterview = require("../../services/aiInterviewService");

function stubSession(turns = []) {
  return {
    _id: "s1",
    company: "c1",
    aiInterview: {
      status: "in_progress",
      questionCount: 1,
      maxQuestions: 8,
      turns,
      backchannels: [],
      probes: [],
      mustAsk: [],
    },
    save: async () => {},
  };
}

const QUESTION_TURN = { role: "ai", kind: "question", text: "How did you design the queue?" };

// ---------------------------------------------------------------------------
// 1. The identity itself
// ---------------------------------------------------------------------------

test("1.1: publicState names the open question by its stable turns index", () => {
  const session = stubSession([
    { role: "ai", kind: "intro", text: "Welcome." },
    { role: "ai", kind: "warmup", text: "Introduce yourself?" },
    { role: "candidate", kind: "warmup_answer", text: "I am Priya." },
    QUESTION_TURN,
  ]);
  assert.equal(aiInterview.publicState(session).questionId, "q3");
});

test("1.2: no identity outside a live interview — a completed session has no open question", () => {
  const session = stubSession([QUESTION_TURN]);
  session.aiInterview.status = "completed";
  assert.equal(aiInterview.publicState(session).questionId, null);
});

test("1.3: every question payload carries the identity for the worker to echo", async () => {
  const out = await voiceAgent.dispatch(stubSession([QUESTION_TURN]), "get_next_question", {});
  assert.equal(out.question_id, "q0");
  assert.equal(out.question, QUESTION_TURN.text);
});

// ---------------------------------------------------------------------------
// 2. THE GUARD — a stale identity is refused, and nothing is recorded
// ---------------------------------------------------------------------------

test("2.1: a submit carrying a stale question_id is refused without recording anything", async () => {
  const session = stubSession([QUESTION_TURN]);
  const out = await voiceAgent.dispatch(
    session,
    "submit_answer",
    { answer: "Some answer.", declined: false, question_id: "q99" },
    { transcript: "I used a Redis stream with one consumer group per tenant." }
  );
  assert.match(out.error, /NOT recorded/i);
  assert.equal(session.aiInterview.turns.length, 1, "no turn was appended");
  // The rejection re-syncs the worker: it names the open question so the conversation continues.
  assert.equal(out.question_id, "q0");
  assert.equal(out.question, QUESTION_TURN.text);
  assert.match(out.instruction, /Do not resubmit/i);
});

test("2.2: a stale DECLINE is refused the same way — it can never land on the wrong question", async () => {
  // The 2026-08-18 corruption exactly: a decline arriving for a question that is not the open one.
  const session = stubSession([QUESTION_TURN]);
  const realAct = aiInterview.submitDialogueAct;
  aiInterview.submitDialogueAct = async () => {
    throw new Error("a stale decline must never reach the engine");
  };
  try {
    const out = await voiceAgent.dispatch(
      session,
      "submit_answer",
      { answer: "I'm not sure. We skip?", declined: true, question_id: "q7" },
      { transcript: "I'm not sure. We skip?" }
    );
    assert.match(out.error, /NOT recorded/i);
    assert.equal(session.aiInterview.turns.length, 1);
  } finally {
    aiInterview.submitDialogueAct = realAct;
  }
});

// ---------------------------------------------------------------------------
// 3. The handshake in the accepting direction
// ---------------------------------------------------------------------------

test("3.1: a submit carrying the MATCHING question_id is recorded normally", async () => {
  const session = stubSession([QUESTION_TURN]);
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
      { answer: "", declined: false, question_id: "q0" },
      { transcript: "I used a Redis stream with one consumer group per tenant." }
    );
    assert.equal(recordedText, "I used a Redis stream with one consumer group per tenant.");
    // The NEXT payload hands the worker the NEXT identity.
    assert.equal(out.question_id, "q2");
  } finally {
    aiInterview.submitAnswer = realSubmit;
  }
});

test("3.2: a submit with NO question_id is accepted — an older worker keeps working", async () => {
  const session = stubSession([QUESTION_TURN]);
  const realSubmit = aiInterview.submitAnswer;
  let recorded = false;
  aiInterview.submitAnswer = async () => {
    recorded = true;
    return { completed: false, currentQuestion: "next?", questionCount: 2, maxQuestions: 8 };
  };
  try {
    await voiceAgent.dispatch(
      session,
      "submit_answer",
      { answer: "", declined: false },
      { transcript: "I used a Redis stream with one consumer group per tenant." }
    );
    assert.equal(recorded, true);
  } finally {
    aiInterview.submitAnswer = realSubmit;
  }
});
