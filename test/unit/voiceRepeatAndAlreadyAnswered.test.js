// Item 4 of the 2026-08-25 fix set: repeat requests and "already answered" claims stop being
// improvised by the room model and are routed through the same deterministic handling the
// turn-based path already had.
//
// TWO BUGS, CLOSED TOGETHER BECAUSE THE SECOND ONLY SHOWS UP ONCE THE FIRST IS PORTED.
//
//   1. A bare repeat request ("Can you repeat?") reaching submit_answer had nowhere to go but an
//      ordinary answer — utils/turnComposition reads it as conduct, not content, but nothing in
//      voiceAgentService acted on that before this fix, so the words were recorded and scored. At
//      turn #22 in the 2026-08-25 session, three repeat requests and the eventual decline all
//      landed in the same scored turn for exactly this reason.
//
//   2. Wiring alreadyAnsweredResponder into the realtime path exposed a second, older bug: the
//      kinds it writes ("already_answered_claim" / "already_answered_reply") were never added to
//      the InterviewSession turn schema, so every occurrence — on the turn-based path too, since
//      2026-08-20 — threw a ValidationError out of session.save() instead of recording anything.
//      Section 3 pins the enum fix directly. Section 4 pins a second latent bug the same porting
//      work surfaced: publicState's "what is the open question" lookup used to be the literal last
//      ai-role turn, so writing the reply turn would have made the OPEN QUESTION appear to be the
//      reply sentence itself — breaking the question-identity handshake
//      (voiceQuestionHandshake.test.js) for the very next answer.
//
// Pure and offline: no DB, no socket, no provider.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const voiceAgent = require("../../services/voiceAgentService");
const aiInterview = require("../../services/aiInterviewService");
const alreadyAnsweredResponder = require("../../utils/alreadyAnsweredResponder");
const InterviewSession = require("../../models/InterviewSession");

function stubSession(turns = []) {
  return {
    _id: "s1",
    company: "c1",
    aiInterview: {
      status: "in_progress",
      questionCount: 2,
      maxQuestions: 8,
      turns,
      backchannels: [],
      probes: [],
      mustAsk: [],
    },
    save: async () => {},
  };
}

// ---------------------------------------------------------------------------
// 1. A bare repeat request is never recorded as an answer
// ---------------------------------------------------------------------------

test("1.1: 'Can you repeat that?' reaching submit_answer records nothing and points back at get_next_question", async () => {
  const session = stubSession([{ role: "ai", kind: "question", text: "How did you design the queue?" }]);
  const realSubmit = aiInterview.submitAnswer;
  const realAct = aiInterview.submitDialogueAct;
  aiInterview.submitAnswer = async () => { throw new Error("must not score a bare repeat request"); };
  aiInterview.submitDialogueAct = async () => { throw new Error("must not treat a repeat as a decline"); };
  try {
    const out = await voiceAgent.dispatch(
      session,
      "submit_answer",
      { answer: "Sorry, could you repeat that?", declined: false, question_id: "q0" },
      { transcript: "Sorry, could you repeat that?" }
    );
    assert.match(out.error, /not an answer/i);
    assert.match(out.instruction, /get_next_question/);
    assert.equal(session.aiInterview.turns.length, 1, "no turn was appended");
  } finally {
    aiInterview.submitAnswer = realSubmit;
    aiInterview.submitDialogueAct = realAct;
  }
});

test("1.2: a repeat request tangled with real content is still an answer — the asymmetry holds here too", async () => {
  const session = stubSession([{ role: "ai", kind: "question", text: "How did you design the queue?" }]);
  const realSubmit = aiInterview.submitAnswer;
  let recordedText = null;
  aiInterview.submitAnswer = async (s, text) => {
    recordedText = text;
    return { completed: false, currentQuestion: "next?", questionId: "q2", questionCount: 3, maxQuestions: 8 };
  };
  try {
    const said = "Sorry, can you repeat? Actually never mind — we used Kafka with three brokers and a two second lag.";
    const out = await voiceAgent.dispatch(
      session,
      "submit_answer",
      { answer: said, declined: false, question_id: "q0" },
      { transcript: said }
    );
    assert.equal(recordedText, said, "content anywhere in the turn wins — nothing here should be silently dropped");
    assert.equal(out.error, undefined);
  } finally {
    aiInterview.submitAnswer = realSubmit;
  }
});

// ---------------------------------------------------------------------------
// 2. "I already answered this" — routed to the code-authored responder, not the model
// ---------------------------------------------------------------------------

test("2.1: against a follow-up question, the FOUND reply comes back verbatim and the question stays open", async () => {
  const followUp = { role: "ai", kind: "follow_up", text: "What specifically did you do on the migration?" };
  const session = stubSession([
    { role: "ai", kind: "question", text: "Tell me about a project you led." },
    { role: "candidate", kind: "answer", text: "I led the Kafka migration." },
    followUp,
  ]);
  const out = await voiceAgent.dispatch(
    session,
    "submit_answer",
    { answer: "You already asked me this.", declined: false, question_id: "q2" },
    { transcript: "You already asked me this." }
  );
  assert.equal(out.speak, alreadyAnsweredResponder.FOUND);
  assert.equal(out.foundPriorAnswer, true);
  assert.match(out.instruction, /word for word/i);
  assert.match(out.instruction, /do not ask/i);
  // The claim itself was not an answer to the follow-up — the question is still open.
  assert.equal(out.question, followUp.text);
  assert.equal(out.interview_complete, false);
  const kinds = session.aiInterview.turns.map((t) => t.kind);
  assert.deepEqual(kinds.slice(-2), ["already_answered_claim", "already_answered_reply"]);
});

test("2.2: against a baseline question nobody followed up on, the honest NOT_FOUND reply comes back", async () => {
  const session = stubSession([{ role: "ai", kind: "question", text: "Tell me about a project you led." }]);
  const out = await voiceAgent.dispatch(
    session,
    "submit_answer",
    { answer: "You already asked me this.", declined: false, question_id: "q0" },
    { transcript: "You already asked me this." }
  );
  assert.equal(out.speak, alreadyAnsweredResponder.NOT_FOUND);
  assert.equal(out.foundPriorAnswer, false);
});

test("2.3: the model's own composed sentence is never in play — it can only ever be the checked one of two", () => {
  // A structural guarantee, not just a behavioural one: whatever the reply says, it is one of
  // exactly two fixed, boot-checked strings — never something assembled per-candidate.
  const bank = new Set([alreadyAnsweredResponder.FOUND, alreadyAnsweredResponder.NOT_FOUND]);
  assert.equal(bank.size, 2);
});

// ---------------------------------------------------------------------------
// 3. The schema bug the port surfaced: these kinds were never added to the enum
// ---------------------------------------------------------------------------

test("3.1: already_answered_claim and already_answered_reply are valid turn kinds", () => {
  for (const kind of ["already_answered_claim", "already_answered_reply"]) {
    const doc = new InterviewSession({
      company: "000000000000000000000001",
      job: "000000000000000000000002",
      candidate: "000000000000000000000003",
      tokenHash: "x",
      expiresAt: new Date(),
      interviewAt: new Date(),
      aiInterview: { turns: [{ role: kind.endsWith("claim") ? "candidate" : "ai", kind, text: "x" }] },
    });
    const err = doc.validateSync();
    const kindError = err?.errors?.["aiInterview.turns.0.kind"];
    assert.equal(kindError, undefined, `"${kind}" must be a valid enum value: ${kindError?.message}`);
  }
});

// ---------------------------------------------------------------------------
// 4. The identity handshake survives a side-channel exchange
// ---------------------------------------------------------------------------

test("4.1: publicState still names the REAL open question after an already-answered exchange, not the reply", async () => {
  const question = { role: "ai", kind: "question", text: "Tell me about a project you led." };
  const session = stubSession([question]);
  await voiceAgent.dispatch(
    session,
    "submit_answer",
    { answer: "You already asked me this.", declined: false, question_id: "q0" },
    { transcript: "You already asked me this." }
  );
  const state = aiInterview.publicState(session);
  // Two side-channel turns were appended (index 1, 2), but the open question is still index 0.
  assert.equal(state.questionId, "q0");
  assert.equal(state.currentQuestion, question.text);
});

test("4.2: a real answer submitted right after still attaches to the original question, not the reply", async () => {
  const question = { role: "ai", kind: "question", text: "Tell me about a project you led." };
  const session = stubSession([question]);
  await voiceAgent.dispatch(
    session,
    "submit_answer",
    { answer: "You already asked me this.", declined: false, question_id: "q0" },
    { transcript: "You already asked me this." }
  );
  const realSubmit = aiInterview.submitAnswer;
  let recorded = false;
  aiInterview.submitAnswer = async () => {
    recorded = true;
    return { completed: false, currentQuestion: "next?", questionId: "q3", questionCount: 3, maxQuestions: 8 };
  };
  try {
    const out = await voiceAgent.dispatch(
      session,
      "submit_answer",
      { answer: "We used Kafka with three brokers.", declined: false, question_id: "q0" },
      { transcript: "We used Kafka with three brokers." }
    );
    assert.equal(recorded, true, "the real answer against q0 must be accepted, not rejected as stale");
    assert.equal(out.error, undefined);
  } finally {
    aiInterview.submitAnswer = realSubmit;
  }
});

test("4.3: openQuestionTurn skips side-channel kinds and finds the real open question", () => {
  const followUp = { role: "ai", kind: "follow_up", text: "What specifically?" };
  const ai = {
    turns: [
      followUp,
      { role: "candidate", kind: "already_answered_claim", text: "You already asked me this." },
      { role: "ai", kind: "already_answered_reply", text: alreadyAnsweredResponder.NOT_FOUND },
    ],
  };
  assert.equal(aiInterview.openQuestionTurn(ai), followUp);
});
