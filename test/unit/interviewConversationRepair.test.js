// The 2026-08-17 session repairs — every test here pins a failure OBSERVED in one real interview
// (session 6a8374fd, candidate recorded as "Auto"):
//
//   * The completeness gate held the candidate's three-word name answer, the model improvised a
//     check-in to satisfy the hold, and the candidate's "No." to THAT question was stored as how
//     to pronounce their name.
//   * The guardrail flagged the interviewer five times for going off-script — and all five were
//     the engine's own authored name-check ask and its authored retry.
//   * The authored goodbye (the one carrying "a person will review it") sat unspoken in the turn
//     record while the model improvised its own.
//
// Pure and offline: no DB, no socket, no provider.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const voiceAgent = require("../../services/voiceAgentService");
const aiInterview = require("../../services/aiInterviewService");
const namePronunciation = require("../../utils/namePronunciation");
const guardrail = require("../../utils/agentGuardrail");

function stubSession({ turns = [], firstName = "Anush" } = {}) {
  return {
    _id: "s-repair",
    company: "c1",
    aiInterview: {
      status: "in_progress",
      questionCount: 0,
      maxQuestions: 8,
      candidateFirstName: firstName,
      turns,
      askedQuestions: [],
      backchannels: [],
      probes: [],
      mustAsk: [],
    },
    save: async () => {},
  };
}

// ---------------------------------------------------------------------------
// 0. The ask is retired — the opening never asks about the name at all
// ---------------------------------------------------------------------------
//
// Owner decision 2026-08-18: the name-pronunciation ask opened every interview with a speech-
// recognition problem, and one real session spent five turns on it before the first question.
// Sections 1-3 below now pin the LEGACY handling — a session that already carries a name_check
// turn must still complete correctly — while this section pins that no new session gets one.

test("0.1: THE RETIREMENT — the opening script goes straight to the warmup, no name check", () => {
  const script = aiInterview.openingScript({
    candidate: { basicDetails: { name: "Anush Kumar" } },
    job: { title: "AI Engineer" },
    persona: { name: "Ava" },
    maxQuestions: 8,
  });
  assert.equal(script.nameCheck, undefined, "the ask is no longer part of the opening");
  assert.ok(script.intro);
  assert.ok(script.warmup);
  assert.doesNotMatch(script.intro, /say your name/i);
});

// ---------------------------------------------------------------------------
// 1. LEGACY — the completeness gate stays out of turns the engine expects to be short
// ---------------------------------------------------------------------------

test("1.1: THE GUARD — a short name answer is never held for 'not sounding finished'", async () => {
  // "I'm Anush" is two words with no terminal punctuation: exactly what the gate holds on an
  // ordinary answer, and exactly what every name answer looks like. Held live, it produced an
  // improvised check-in and derailed the whole opening.
  const session = stubSession({
    turns: [{ role: "ai", kind: "name_check", text: namePronunciation.PRONUNCIATION_ASK }],
  });
  const out = await voiceAgent.dispatch(
    session,
    "submit_answer",
    { answer: "", declined: false },
    { transcript: "I'm Anush" }
  );
  assert.equal(out.error, undefined, "must not be held");
  assert.equal(session.aiInterview.endpointHold, undefined);
  const kinds = session.aiInterview.turns.map((t) => t.kind);
  assert.ok(kinds.includes("name_answer"), "routed into the name flow");
  assert.equal(session.aiInterview.namePronunciation.respelling, "Anush");
});

test("1.2: a short reply to a nudge is submitted, not held", async () => {
  // The nudge reply ("no that's everything") is unpunctuated and thin by design — it answers
  // "anything to add?". Holding it re-asks the candidate the question they just answered.
  const session = stubSession({
    turns: [
      { role: "ai", kind: "question", text: "Tell me about a project?" },
      { role: "candidate", kind: "answer", text: "A short one." },
      { role: "ai", kind: "nudge", text: "Would you like to add anything more to that?" },
    ],
  });
  const real = aiInterview.submitAnswer;
  let submitted = null;
  aiInterview.submitAnswer = async (s, text) => {
    submitted = text;
    return { completed: false, currentQuestion: "next?" };
  };
  try {
    const out = await voiceAgent.dispatch(
      session,
      "submit_answer",
      { answer: "", declined: false },
      { transcript: "no that's everything" }
    );
    assert.equal(out.error, undefined, "must not be held");
    assert.equal(submitted, "no that's everything", "handed to the engine's own nudge routing");
  } finally {
    aiInterview.submitAnswer = real;
  }
});

test("1.3: an ordinary answer that trails mid-thought is STILL held — the bypass is narrow", async () => {
  const session = stubSession({
    turns: [{ role: "ai", kind: "question", text: "Tell me about a project?" }],
  });
  const out = await voiceAgent.dispatch(
    session,
    "submit_answer",
    { answer: "", declined: false },
    { transcript: "Okay so basically I with one of my roommates" }
  );
  assert.match(out.error, /does not sound finished/i);
});

// ---------------------------------------------------------------------------
// 2. "No." is not a name
// ---------------------------------------------------------------------------

test("2.1: THE GUARD — 'No.' is never adopted as a pronunciation, whatever the skeleton says", () => {
  // Production data: respelling "No", source "asr", distance 1, allowed 1 — stored against the
  // recorded first name "Auto". Both reduce to one consonant, and the old allowance of one edit
  // made a one-consonant skeleton a wildcard.
  assert.equal(namePronunciation.fromSelfReport("No.", "Auto"), null);
  assert.equal(namePronunciation.isPlausibleFor("No", "Auto").plausible, false);
});

test("2.2: other non-answers abstain too", () => {
  for (const t of ["Okay.", "Yeah.", "What?", "Sorry?", "Done."]) {
    assert.equal(namePronunciation.fromSelfReport(t, "Auto"), null, `must abstain on: ${t}`);
  }
});

test("2.3: real respellings still get through", () => {
  assert.ok(namePronunciation.fromSelfReport("It's vih-JEN-dra.", "Vijendra"));
  assert.ok(namePronunciation.fromSelfReport("I'm Anush", "Anush"));
});

// ---------------------------------------------------------------------------
// 3. The guardrail never flags the instrument's own script
// ---------------------------------------------------------------------------

test("3.1: the authored name check and its retry are authorized once they are turns", () => {
  const ai = {
    askedQuestions: ["Can you tell me about a specific AI project you worked on recently?"],
    turns: [
      { role: "ai", kind: "name_check", text: namePronunciation.PRONUNCIATION_ASK },
      { role: "candidate", kind: "name_answer", text: "I'm Anush" },
      {
        role: "ai",
        kind: "name_check",
        text: "Sorry — I didn't quite catch that. Could you say your name once more for me?",
      },
    ],
  };
  const authorized = guardrail.authorizedUtterances(ai);
  for (const turn of ai.turns.filter((t) => t.role === "ai")) {
    const { hits } = guardrail.scan(turn.text, { authorizedQuestions: authorized });
    assert.equal(
      hits.filter((h) => h.ruleId === "off_script_question").length,
      0,
      `authored line must not flag: ${turn.text}`
    );
  }
  // Candidate turns never enter the authorized set — they are not the interviewer's to have said.
  assert.ok(!authorized.includes("I'm Anush"));
});

test("3.2: the same scan WITHOUT the turn record still flags — the fix is the authorized set, not a weaker rule", () => {
  const { hits } = guardrail.scan(namePronunciation.PRONUNCIATION_ASK, {
    authorizedQuestions: ["Can you tell me about a specific AI project you worked on recently?"],
  });
  assert.equal(hits.filter((h) => h.ruleId === "off_script_question").length, 1);
});

// ---------------------------------------------------------------------------
// 4. The authored goodbye reaches the worker
// ---------------------------------------------------------------------------

test("4.1: a finished interview hands the agent the authored closing, marked verbatim", async () => {
  const session = stubSession();
  session.aiInterview.status = "ended_early";
  session.aiInterview.turns = [
    { role: "ai", kind: "question", text: "Q1" },
    {
      role: "ai",
      kind: "closing",
      text: "Understood, Anush — we'll stop here. A person will review it.",
    },
  ];
  const out = await voiceAgent.dispatch(session, "get_next_question", {});
  assert.equal(out.interview_complete, true);
  assert.match(out.closing_message, /a person will review it/i);
  assert.match(out.instruction, /word for word/i);
});

test("4.2: with no closing turn recorded, the payload degrades to the old improvised goodbye", async () => {
  const session = stubSession();
  session.aiInterview.status = "completed";
  const out = await voiceAgent.dispatch(session, "get_next_question", {});
  assert.equal(out.interview_complete, true);
  assert.equal(out.closing_message, null);
  assert.match(out.instruction, /thank the candidate warmly/i);
});
