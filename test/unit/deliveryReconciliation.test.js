// Per-turn delivery reconciliation — voiceAgentService.reconcileDelivery.
//
// The record must be able to tell "the candidate ignored this question" apart from "the candidate
// never heard this question". Two real failures from the 2026-08-18 session drive every case
// here: a question authored during the final submit and orphaned by the candidate's withdrawal
// (recorded as asked, never spoken), and an approved opening script the model replaced with its
// own preamble (recorded as delivered, mostly unspoken).
//
// Pure and offline: no DB, no socket, no provider.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const voiceAgent = require("../../services/voiceAgentService");
const InterviewSession = require("../../models/InterviewSession");

// The 2026-08-18 session, in miniature.
const INTRO =
  "Hi Krishna — my name is Ava, and I'll be running your interview for the AI Engineer role " +
  "today. It usually takes about 20 minutes in total, and if you'd like me to repeat a question " +
  "at any point, just ask.";
const WARMUP = "So, whenever you're ready — could you start with a short introduction?";
const Q_NLP = "Can you walk me through the process of integrating NLP capabilities into the AI-powered SaaS chatbot you engineered?";
const Q_PHANTOM = "Can you explain how you would approach training a machine learning model for your AI chatbot?";
const CLOSING = "Understood — we'll stop here. A person will review everything you said today.";

function turnsFixture() {
  return [
    { role: "ai", kind: "intro", text: INTRO },
    { role: "ai", kind: "warmup", text: WARMUP },
    { role: "candidate", kind: "warmup_answer", text: "Hi, I'm Krishna." },
    { role: "ai", kind: "question", text: Q_NLP },
    { role: "candidate", kind: "answer", text: "I'm not sure. We skip?", declined: true },
    { role: "ai", kind: "question", text: Q_PHANTOM }, // authored mid-withdrawal, never spoken
    { role: "ai", kind: "closing", text: CLOSING },
  ];
}

// What the room actually heard: the model's own preamble instead of the intro, then the warmup
// and one real question. The phantom question and the intro never made it to air.
const SPOKEN = [
  { text: "So," },
  { text: "If there's one you'd rather not answer, just tell me and we'll move on. One moment please." },
  { text: WARMUP },
  { text: `Thank you. ${Q_NLP}` },
  { text: "Just to confirm — would you like to end the interview here?" },
];

test("1.1: the phantom question and the unspoken intro are marked; delivered turns are cleared", () => {
  const turns = turnsFixture();
  const findings = voiceAgent.reconcileDelivery(turns, SPOKEN, { now: new Date("2026-08-18T07:00:00Z") });

  assert.equal(turns[0].spoken.matched, false, "the intro never reached the candidate");
  assert.equal(turns[1].spoken.matched, true, "the warmup was spoken");
  assert.equal(turns[3].spoken.matched, true, "the NLP question was spoken (inside a longer utterance)");
  assert.equal(turns[5].spoken.matched, false, "the phantom question was never spoken");
  assert.equal(findings.introNotDelivered, true);
  assert.deepEqual(
    findings.unspoken.map((u) => u.kind).sort(),
    ["intro", "question"]
  );
});

test("1.2: candidate turns and the closing are never stamped — one is not ours, the other races the relay", () => {
  const turns = turnsFixture();
  voiceAgent.reconcileDelivery(turns, SPOKEN);
  assert.equal(turns[2].spoken, undefined, "candidate turns carry no delivery verdict");
  assert.equal(turns[4].spoken, undefined);
  assert.equal(turns[6].spoken, undefined, "the closing's relay post races finalization — unchecked, not falsely unspoken");
});

test("1.3: an empty utterance log checks turns and finds none of them spoken", () => {
  const turns = turnsFixture();
  const findings = voiceAgent.reconcileDelivery(turns, []);
  assert.equal(findings.checked, 4);
  assert.equal(findings.unspoken.length, 4);
});

test("1.4: utterances may be plain strings or {text} rows — the call sites differ", () => {
  const turns = [{ role: "ai", kind: "question", text: Q_NLP }];
  voiceAgent.reconcileDelivery(turns, [`Okay. ${Q_NLP}`]);
  assert.equal(turns[0].spoken.matched, true);
});

test("2.1: the schema stores the verdict on a turn, and the evaluation stores the intro flag", () => {
  const doc = new InterviewSession({
    aiInterview: {
      turns: [{ role: "ai", kind: "intro", text: INTRO, spoken: { matched: false, at: new Date() } }],
      evaluation: { introNotDelivered: true, recommendation: "review" },
    },
  });
  const err = doc.validateSync(["aiInterview"]);
  assert.equal(err, undefined);
  assert.equal(doc.aiInterview.turns[0].spoken.matched, false);
  assert.equal(doc.aiInterview.evaluation.introNotDelivered, true);
});
