// Phase 9 acceptance gates — interview engine defects:
//   9.1 the FINAL answer is scored (finalisation scores any unscored answer,
//       AI path and fallback path both);
//   9.2 the fallback evaluation never fabricates 55 for unscored answers —
//       unscored answers are excluded, and with nothing scored the overall is
//       null ("not measured"), never a number;
//   9.4 voice STT/TTS cost estimation is deterministic and sane;
//   9.5 the voice token endpoint hard-refuses without recorded consent;
//   9.6 the dead audioPath field is gone; voiceConsent exists.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const aiInterview = require("../../services/aiInterviewService");
const llm = require("../../services/llmService");
const usageService = require("../../services/usageService");
const speech = require("../../services/speechService");
const portal = require("../../controllers/interviewPortalController");
const InterviewSession = require("../../models/InterviewSession");

function refs() {
  return {
    session: { _id: new mongoose.Types.ObjectId(), company: new mongoose.Types.ObjectId() },
    candidate: {
      _id: new mongoose.Types.ObjectId(),
      basicDetails: { name: "Test Candidate", email: "t@example.com" },
      skills: ["node.js"],
      experience: [],
      education: [],
      projects: [],
      ats: {},
    },
    job: { title: "Backend Engineer", description: "Build APIs", requiredSkills: ["node.js"], minExperienceYears: 2 },
  };
}

function turnsWithUnscoredFinal() {
  return [
    { role: "ai", kind: "intro", text: "Hi" },
    { role: "ai", kind: "question", text: "Q1?" },
    { role: "candidate", kind: "answer", text: "A thorough answer about building REST APIs with Express and error handling middleware.", answerScore: 70 },
    { role: "ai", kind: "question", text: "Q2 — the final question?" },
    { role: "candidate", kind: "answer", text: "Another substantive answer describing MongoDB schema design decisions and their trade-offs in production." },
    { role: "ai", kind: "closing", text: "Thanks!" },
  ];
}

// ---------------------------------------------------------------------------
// 9.1 — the final answer is scored
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE 9.1: finalisation scores the final answer (fallback path)", async () => {
  const { session, candidate, job } = refs();
  const ai = { turns: turnsWithUnscoredFinal() };
  await aiInterview.scoreUnscoredAnswers({ session, candidate, job, settings: null, ai, useAi: false });
  const final = ai.turns[4];
  assert.equal(typeof final.answerScore, "number", "the final answer must now carry a score");
  assert.ok(final.answerScore > 0, "a substantive answer scores above zero");
  assert.equal(ai.turns[2].answerScore, 70, "already-scored answers are untouched");
});

test("ACCEPTANCE GATE 9.1: finalisation scores the final answer (AI path, metered)", async () => {
  const { session, candidate, job } = refs();
  const ai = { turns: turnsWithUnscoredFinal() };

  const origGen = llm.generateJSON;
  const origRec = usageService.recordUsage;
  const calls = [];
  llm.generateJSON = async (req) => {
    calls.push(req);
    assert.ok(req.prompt.includes("Q2 — the final question?"), "the scoring prompt carries the actual question");
    assert.ok(!req.prompt.includes("Test Candidate"), "late scoring is bias-blinded (no candidate name)");
    return { data: { answerScore: 84 }, usage: { promptTokens: 10, completionTokens: 2 }, model: "stub", cached: false };
  };
  const metered = [];
  usageService.recordUsage = async (row) => metered.push(row);
  try {
    await aiInterview.scoreUnscoredAnswers({ session, candidate, job, settings: null, ai, useAi: true });
  } finally {
    llm.generateJSON = origGen;
    usageService.recordUsage = origRec;
  }
  assert.equal(ai.turns[4].answerScore, 84);
  assert.equal(calls.length, 1, "only the unscored answer triggers a call");
  assert.equal(metered.length, 1);
  assert.equal(metered[0].kind, "evaluation");
});

test("a near-empty answer is never handed a model-invented score", async () => {
  // Observed live: a 169ms "Okay." answer came back scored 60/100 with nothing in six characters
  // to justify it. The fallback path has always applied this floor (fallbackAnswerScore /
  // isResponsive); the AI path did not, and this is the same floor applied there.
  const { session, candidate, job } = refs();
  const ai = {
    turns: [
      { role: "ai", kind: "question", text: "Describe a time you worked on a multidisciplinary team." },
      { role: "candidate", kind: "answer", text: "Okay." },
    ],
  };
  const origGen = llm.generateJSON;
  const origRec = usageService.recordUsage;
  llm.generateJSON = async () => ({ data: { answerScore: 60 }, usage: {}, model: "stub", cached: false });
  usageService.recordUsage = async () => {};
  try {
    await aiInterview.scoreUnscoredAnswers({ session, candidate, job, settings: null, ai, useAi: true });
  } finally {
    llm.generateJSON = origGen;
    usageService.recordUsage = origRec;
  }
  assert.equal(ai.turns[1].answerScore, undefined, "insufficient evidence is left unscored, not fabricated");
});

test("9.1: a failed scoring call leaves the answer honestly unscored (no invented number)", async () => {
  const { session, candidate, job } = refs();
  const ai = { turns: turnsWithUnscoredFinal() };
  const origGen = llm.generateJSON;
  llm.generateJSON = async () => {
    throw new Error("provider down");
  };
  const origRec = usageService.recordUsage;
  usageService.recordUsage = async () => {};
  try {
    await aiInterview.scoreUnscoredAnswers({ session, candidate, job, settings: null, ai, useAi: true });
  } finally {
    llm.generateJSON = origGen;
    usageService.recordUsage = origRec;
  }
  assert.equal(ai.turns[4].answerScore, undefined);
});

// ---------------------------------------------------------------------------
// 9.2 — the fallback never fabricates 55
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE 9.2: unscored answers are EXCLUDED from the fallback mean", () => {
  const ai = {
    turns: [
      { role: "candidate", kind: "answer", text: "x", answerScore: 80 },
      { role: "candidate", kind: "answer", text: "y" }, // unscored — used to count as 55
      { role: "candidate", kind: "answer", text: "z", answerScore: 60 },
    ],
  };
  const ev = aiInterview.fallbackEvaluation(ai);
  assert.equal(ev.overallScore, 70, "mean over the two scored answers only — no fabricated 55");
  assert.equal(ev.recommendation, "review");
});

test("ACCEPTANCE GATE 9.2: with nothing scored the fallback reports null, not a number", () => {
  const ai = { turns: [{ role: "candidate", kind: "answer", text: "y" }] };
  const ev = aiInterview.fallbackEvaluation(ai);
  assert.equal(ev.overallScore, null);
  assert.ok(/No answers were scored/.test(ev.summary), "the summary states nothing was measured");
  assert.equal(ev.recommendation, "review", "the fallback never emits an adverse recommendation");
});

// ---------------------------------------------------------------------------
// 9.4 — voice cost estimation
// ---------------------------------------------------------------------------

test("9.4: STT/TTS cost estimates are deterministic and proportional", () => {
  assert.equal(speech.ttsCostCents(1000), 1.5);
  assert.equal(speech.ttsCostCents(0), 0);
  assert.equal(speech.sttCostCents(60000), 0.77);
  assert.equal(speech.sttCostCents(0), 0);
  assert.ok(speech.sttCostCents(120000) > speech.sttCostCents(60000));
});

// ---------------------------------------------------------------------------
// 9.5 — voice consent gates the streaming token server-side
// ---------------------------------------------------------------------------

function fakeRes() {
  const out = { statusCode: 200, body: null };
  return {
    out,
    status(code) {
      out.statusCode = code;
      return this;
    },
    json(x) {
      out.body = x;
    },
  };
}

test("ACCEPTANCE GATE 9.5: no consent ⇒ no streaming token (403, machine-readable)", async () => {
  const origEnabled = speech.isEnabled;
  speech.isEnabled = () => true;
  try {
    const res = fakeRes();
    await portal.voiceToken({ interviewSession: { voiceConsent: { given: false } } }, res);
    assert.equal(res.out.statusCode, 403);
    assert.equal(res.out.body.code, "VOICE_CONSENT_REQUIRED");
  } finally {
    speech.isEnabled = origEnabled;
  }
});

test("9.5: the session records given/declined voice consent shapes", () => {
  const vc = InterviewSession.schema.path("voiceConsent.given");
  assert.ok(vc, "voiceConsent.given exists on the session schema");
  assert.ok(InterviewSession.schema.path("voiceConsent.declined"));
});

// ---------------------------------------------------------------------------
// 9.6 — audioPath is gone
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE 9.6: the dead audioPath field no longer exists on interview turns", () => {
  const turnSchema = InterviewSession.schema.path("aiInterview").schema.path("turns").schema;
  assert.equal(turnSchema.path("audioPath"), undefined);
  assert.ok(turnSchema.path("audioDurationMs"), "the used voice metadata fields remain");
});

// ---------------------------------------------------------------------------
// §3.1 — multiple interview attempts
// ---------------------------------------------------------------------------

test("§3.1: candidate is no longer unique on its own — attempt + compound unique index instead", () => {
  const candidatePath = InterviewSession.schema.path("candidate");
  assert.equal(candidatePath.options.unique, undefined, "candidate alone must not carry unique:true any more");
  const attemptPath = InterviewSession.schema.path("attempt");
  assert.ok(attemptPath, "attempt field must exist");
  assert.equal(attemptPath.options.default, 1, "attempt defaults to 1 so every existing call site keeps working unmodified");
  const compound = InterviewSession.schema.indexes().find(([keys]) => keys.candidate === 1 && keys.attempt === 1);
  assert.ok(compound, "a compound { candidate, attempt } index must be declared");
  assert.equal(compound[1].unique, true, "the compound index must be unique — one document per attempt");
});

// ---------------------------------------------------------------------------
// §3.6 — presence-triggered abandonment (candidate left and never came back)
// ---------------------------------------------------------------------------

test("§3.6: a candidate whose last presence event is 'left' is finalized WHILE their link is still valid", async () => {
  const livekit = require("../../services/livekitService");
  const origDeleteRoom = livekit.deleteRoom;
  let deleteRoomCalledWith = null;
  livekit.deleteRoom = async (session) => {
    deleteRoomCalledWith = session._id;
    return { deleted: true };
  };

  const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // link still has a day left
  const session = {
    _id: new mongoose.Types.ObjectId(),
    status: "in_progress",
    expiresAt: futureExpiry,
    updatedAt: new Date(Date.now() - 15 * 60 * 1000),
    aiInterview: {
      status: "in_progress",
      questionCount: 3,
      turns: [{ role: "candidate", kind: "answer", text: "partial answer" }],
      presence: [{ event: "left", at: new Date(Date.now() - 12 * 60 * 1000) }],
    },
    saved: false,
    async save() {
      this.saved = true;
    },
  };

  try {
    const result = await aiInterview.finalizeAbandoned(session, { becausePresenceLeft: true });
    assert.equal(result, true, "a presence-left, still-valid-link session must still finalize");
    assert.equal(session.aiInterview.status, "abandoned");
    assert.equal(session.status, "expired", "the operational state matches a locked-out (re-issuable) candidate");
    assert.ok(session.expiresAt.getTime() <= Date.now(), "the link is expired as part of this same transition");
    assert.ok(session.aiInterview.abandoned, "an abandoned record is written");
    assert.ok(session.saved, "the session was persisted");
    assert.equal(String(deleteRoomCalledWith), String(session._id), "the LiveKit room is torn down in the same transition");
  } finally {
    livekit.deleteRoom = origDeleteRoom;
  }
});

test("§3.6: a session whose last presence event is NOT 'left' is left untouched by the presence sweep's own guard", async () => {
  // finalizeAbandoned itself only re-checks status + the two trigger conditions — the "is the last
  // presence event actually left" filter lives in interviewReminderJob.sweepAbandonedByPresence,
  // one layer up. This asserts finalizeAbandoned's own guard: an already-completed interview must
  // never be re-finalized just because becausePresenceLeft was passed.
  const session = {
    _id: new mongoose.Types.ObjectId(),
    status: "completed",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    updatedAt: new Date(),
    aiInterview: { status: "completed", turns: [] },
    async save() {},
  };
  const result = await aiInterview.finalizeAbandoned(session, { becausePresenceLeft: true });
  assert.equal(result, false, "a session that isn't in_progress must never be finalized");
});

// ---------------------------------------------------------------------------
// Anti-cheating — hard auto-submit on repeated integrity violations
// ---------------------------------------------------------------------------

test("anti-cheating: 3 hard-trigger flags terminate an in-progress interview, tear down the room, and route to review", async () => {
  const livekit = require("../../services/livekitService");
  const origDeleteRoom = livekit.deleteRoom;
  let deleteRoomCalledWith = null;
  livekit.deleteRoom = async (session) => {
    deleteRoomCalledWith = session._id;
    return { deleted: true };
  };

  const session = {
    _id: new mongoose.Types.ObjectId(),
    company: new mongoose.Types.ObjectId(),
    status: "in_progress",
    aiInterview: {
      status: "in_progress",
      questionCount: 4,
      turns: [{ role: "candidate", kind: "answer", text: "an answer" }],
    },
    saved: false,
    async save() {
      this.saved = true;
    },
  };

  try {
    const result = await aiInterview.terminateForIntegrityViolation(session, {
      triggerCount: 3,
      threshold: 3,
      types: ["device_busy", "multi_face"],
    });
    assert.equal(session.aiInterview.status, "integrity_terminated");
    assert.equal(session.status, "completed", "operationally over, same convention as halted/ended_early");
    assert.ok(session.aiInterview.integrityTerminated, "an integrityTerminated record is written");
    assert.equal(session.aiInterview.integrityTerminated.triggerCount, 3);
    assert.deepEqual(session.aiInterview.integrityTerminated.types, ["device_busy", "multi_face"]);
    assert.ok(session.saved, "the session was persisted");
    assert.equal(String(deleteRoomCalledWith), String(session._id), "the LiveKit room is torn down directly — no worker is present to do it");
    assert.equal(result.integrityTerminated, true, "publicState reflects the new status");
    assert.equal(result.completed, true, "the client's completed OR-chain covers the new status");

    const reason = aiInterview.reviewRequiredReason(session.aiInterview);
    assert.match(reason, /human must review/i);
    assert.doesNotMatch(
      reason,
      /must not count against them/i,
      "distinct from halted/abandoned's not-our-fault framing — this may genuinely be conduct-relevant"
    );
  } finally {
    livekit.deleteRoom = origDeleteRoom;
  }
});

test("anti-cheating: a session that is not in_progress is left untouched", async () => {
  const session = {
    _id: new mongoose.Types.ObjectId(),
    status: "completed",
    aiInterview: { status: "completed", turns: [] },
    async save() {},
  };
  await aiInterview.terminateForIntegrityViolation(session, { triggerCount: 3, threshold: 3, types: ["device_busy"] });
  assert.equal(session.aiInterview.status, "completed", "an already-finished session is never re-terminated");
});

// ---------------------------------------------------------------------------
// §3.3 — prompt latency: transcript stays bounded past the recent-turn window
// ---------------------------------------------------------------------------

test("§3.3: recentTranscriptWithSummary stays roughly flat past the window, unlike the full transcript", () => {
  const { transcriptText, recentTranscriptWithSummary } = require("../../utils/interviewPrompts");
  const manyTurns = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? "ai" : "candidate",
    text: `This is turn number ${i} with a reasonably long sentence so the full transcript actually grows meaningfully with turn count.`,
    answerScore: i % 2 === 1 ? 70 : undefined,
  }));

  const fullLength = transcriptText(manyTurns).length;
  const windowedLength = recentTranscriptWithSummary(manyTurns, { windowSize: 8 }).length;
  assert.ok(windowedLength < fullLength, "the windowed version must be materially smaller than the full transcript at 30 turns");

  // Growing the transcript further (30 -> 60 turns) should grow the windowed prompt only by the
  // condensed digest lines (short, fixed-ish per turn), not by the full per-turn text — this is
  // the "roughly flat" property the fix exists for.
  const moreTurns = manyTurns.concat(
    Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "ai" : "candidate",
      text: `This is turn number ${30 + i} with a reasonably long sentence so the full transcript actually grows meaningfully with turn count.`,
      answerScore: i % 2 === 1 ? 70 : undefined,
    }))
  );
  const windowedLengthAt60 = recentTranscriptWithSummary(moreTurns, { windowSize: 8 }).length;
  const growthRatio = windowedLengthAt60 / windowedLength;
  assert.ok(growthRatio < 2, `windowed prompt size should not double when turn count doubles (ratio ${growthRatio.toFixed(2)})`);

  // The last `windowSize` turns are still present verbatim — the model still sees exactly what it
  // needs to score the most recent answer and ask a grounded next question.
  const lastTurnText = moreTurns[moreTurns.length - 1].text;
  assert.ok(recentTranscriptWithSummary(moreTurns, { windowSize: 8 }).includes(lastTurnText));
});

test("§3.3: the final-evaluation transcript is NOT windowed — it stays the full record", () => {
  const { evaluationPrompt } = require("../../utils/interviewPrompts");
  const turns = [
    { role: "ai", text: "Opening question." },
    { role: "candidate", text: "Turn zero answer, easy to find." },
    ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? "ai" : "candidate", text: `filler turn ${i}` })),
  ];
  const prompt = evaluationPrompt({ context: "CTX", turns });
  assert.ok(prompt.includes("Turn zero answer, easy to find."), "finalisation must still see the very first answer verbatim");
});
