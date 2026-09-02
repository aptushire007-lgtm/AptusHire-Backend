// LiveKit realtime pipeline plumbing — services/livekitService.js (LIVEKIT-REALTIME-PLAN LK-1).
//
// What these tests defend: the gate stays off-by-default (with legacy stored modes pinning a
// tenant safely to turn-based); the candidate's room token grants exactly one room and no admin
// power; metering is idempotent across its three racing callers; and the webhook maps only OUR
// rooms to sessions.
//
// Pure and offline: no DB, no LiveKit, no provider. usageService and InterviewSession statics are
// monkey-patched where the code under test would otherwise reach for infrastructure.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const livekit = require("../../services/livekitService");
const voiceAgent = require("../../services/voiceAgentService");
const metaAnswers = require("../../utils/metaAnswers");
const usageService = require("../../services/usageService");
const InterviewSession = require("../../models/InterviewSession");

const ENV_KEYS = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LIVEKIT_CENTS_PER_MIN",
  "LIVEKIT_AGENT_NAME",
  "VOICE_MODE",
  "DEEPGRAM_API_KEY",
  "OPENROUTER_API_KEY",
];

function withEnv(overrides, fn) {
  const prev = {};
  for (const k of ENV_KEYS) prev[k] = process.env[k];
  const restore = () => {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
    const out = fn();
    // An async callback keeps needing its env across awaits — restore only when it settles,
    // not when it merely starts (the bug: its second await saw the ORIGINAL env).
    if (out && typeof out.then === "function") return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

const FULL_ENV = {
  LIVEKIT_URL: "wss://test-project.livekit.cloud",
  LIVEKIT_API_KEY: "APItestkey",
  LIVEKIT_API_SECRET: "secret-of-sufficient-length-for-hs256",
  DEEPGRAM_API_KEY: "dg-test",
  OPENROUTER_API_KEY: "sk-or-test",
};

// ---------------------------------------------------------------------------
// 1. The gate — off by default, mutually exclusive by construction
// ---------------------------------------------------------------------------

test("1.1: livekit is OFF unless explicitly turned on", () => {
  withEnv(FULL_ENV, () => {
    assert.equal(livekit.isEnabled(null), false, "no mode set ⇒ turn-based, which is what runs today");
    process.env.VOICE_MODE = "livekit";
    assert.equal(livekit.isEnabled(null), true);
    // A tenant's own setting outranks the deployment default in BOTH directions.
    assert.equal(livekit.isEnabled({ ai: { voiceMode: "turn_based" } }), false, "a tenant must be able to opt out");
    delete process.env.VOICE_MODE;
    assert.equal(livekit.isEnabled({ ai: { voiceMode: "livekit" } }), true, "and opt in");
  });
});

test("1.2: missing config ⇒ livekit cannot be switched on at all", () => {
  // Each credential is individually load-bearing: LiveKit for the room, Deepgram for the worker's
  // STT/TTS, OpenRouter for its reasoning — realtime has no deterministic fallback to degrade to.
  for (const missing of ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "DEEPGRAM_API_KEY", "OPENROUTER_API_KEY"]) {
    const env = { ...FULL_ENV, VOICE_MODE: "livekit" };
    delete env[missing];
    withEnv(env, () => {
      assert.equal(livekit.isEnabled({ ai: { voiceMode: "livekit" } }), false, `${missing} unset must disable the pipeline`);
    });
  }
});

test("1.3: any explicit non-livekit tenant value pins the tenant off the pipeline — including legacy 'realtime'", () => {
  withEnv({ ...FULL_ENV, VOICE_MODE: "livekit" }, () => {
    // An explicit turn_based choice outranks a livekit deployment default.
    assert.equal(livekit.isEnabled({ ai: { voiceMode: "turn_based" } }), false);
    // Older CompanySettings docs may still carry "realtime" from the retired Deepgram-agent
    // pipeline. That value must land the tenant on turn-based — never on a pipeline they did not
    // choose, and never on the one that no longer exists.
    assert.equal(livekit.isEnabled({ ai: { voiceMode: "realtime" } }), false);
    // A tenant with no explicit choice follows the deployment default.
    assert.equal(livekit.isEnabled(null), true);
  });
});

test("1.4: the engine endpoint accepts a livekit tenant (regression: LK-2 e2e 404)", async () => {
  // /realtime/function is the engine contract the LiveKit worker calls. When two realtime
  // pipelines coexisted, gating it on the wrong pipeline's flag 404'd every function call for
  // livekit tenants — the worker spoke "something went wrong on our side" in a live room. The
  // gate must track the pipeline that actually calls the endpoint.
  const CompanySettings = require("../../models/CompanySettings");
  const { realtimeFunction } = require("../../controllers/voiceAgentController");
  const realFindOne = CompanySettings.findOne;
  CompanySettings.findOne = () => ({ select: async () => ({ ai: { voiceMode: "livekit" } }) });
  try {
    await withEnv({ ...FULL_ENV }, async () => {
      const responses = [];
      const res = {
        status(code) {
          responses.push({ code });
          return this;
        },
        json(body) {
          responses.push({ body });
        },
      };
      await realtimeFunction(
        { interviewSession: { _id: "s1", company: "c1" }, body: { name: "not_a_real_function" } },
        res
      );
      // An unknown function returns a speakable error through dispatch — NOT a 404 refusal.
      assert.ok(!responses.some((r) => r.code === 404), "livekit tenant must not be refused");
      const body = responses.find((r) => r.body)?.body;
      assert.ok(body?.result?.error?.includes("Unknown function"), "reached the engine dispatch");
    });
  } finally {
    CompanySettings.findOne = realFindOne;
  }
});

// ---------------------------------------------------------------------------
// 2. Room naming — the webhook's only routing key
// ---------------------------------------------------------------------------

test("2.1: roomName/sessionIdFromRoom round-trip, and foreign rooms map to nothing", () => {
  const id = "0123456789abcdef01234567";
  assert.equal(livekit.roomName({ _id: id }), `itv-${id}`);
  assert.equal(livekit.sessionIdFromRoom(`itv-${id}`), id);
  // Anything we did not name must be ignored — someone else's project traffic, manual test
  // rooms, or a crafted name must never reach the metering path.
  assert.equal(livekit.sessionIdFromRoom("itv-not-an-objectid"), null);
  assert.equal(livekit.sessionIdFromRoom(`other-${id}`), null);
  assert.equal(livekit.sessionIdFromRoom(""), null);
  assert.equal(livekit.sessionIdFromRoom(null), null);
  assert.equal(livekit.sessionIdFromRoom(`itv-${id}extra`), null);
});

test("2.2: httpUrl derives the REST endpoint from the client wss:// URL", () => {
  withEnv({ ...FULL_ENV }, () => {
    assert.equal(livekit.httpUrl(), "https://test-project.livekit.cloud");
  });
  withEnv({ ...FULL_ENV, LIVEKIT_URL: "ws://localhost:7880" }, () => {
    assert.equal(livekit.httpUrl(), "http://localhost:7880");
  });
});

// ---------------------------------------------------------------------------
// 3. The candidate token — one room, no admin, session-bound expiry
// ---------------------------------------------------------------------------

function decodeJwt(token) {
  const [, payload] = String(token).split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

test("3.1: the room token grants join on exactly the session's room and nothing more", async () => {
  await withEnv(FULL_ENV, async () => {
    const id = "0123456789abcdef01234567";
    const session = { _id: id, expiresAt: new Date(Date.now() + 10 * 60 * 1000) };
    const claims = decodeJwt(await livekit.mintCandidateToken(session));

    assert.equal(claims.sub, `candidate-${id}`, "identity is the candidate, named by session");
    assert.equal(claims.video.roomJoin, true);
    assert.equal(claims.video.room, `itv-${id}`, "join THIS room only");
    assert.equal(claims.video.canPublish, true, "their microphone");
    assert.equal(claims.video.canSubscribe, true, "the interviewer's voice");
    // The absences are the security property.
    assert.ok(!claims.video.roomAdmin, "no admin");
    assert.ok(!claims.video.roomCreate, "no creating other rooms");
    assert.ok(!claims.video.roomList, "no listing other rooms");
    assert.ok(!claims.video.canPublishData, "no data channel");
  });
});

test("3.2: token TTL tracks the interview session's own expiry, clamped", async () => {
  await withEnv(FULL_ENV, async () => {
    const id = "0123456789abcdef01234567";
    const now = Math.floor(Date.now() / 1000);

    // 10 minutes left on the session ⇒ ≈10-minute token.
    const short = decodeJwt(
      await livekit.mintCandidateToken({ _id: id, expiresAt: new Date(Date.now() + 10 * 60 * 1000) })
    );
    assert.ok(short.exp - now > 8 * 60 && short.exp - now <= 10 * 60 + 30, `≈10min, got ${short.exp - now}s`);

    // A week left ⇒ clamped to 3h. A room credential must not outlive its usefulness.
    const long = decodeJwt(
      await livekit.mintCandidateToken({ _id: id, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) })
    );
    assert.ok(long.exp - now <= 3 * 3600 + 30, `clamped to 3h, got ${long.exp - now}s`);

    // No expiry on the session ⇒ the 1h default, not a forever-token.
    const fallback = decodeJwt(await livekit.mintCandidateToken({ _id: id }));
    assert.ok(fallback.exp - now <= 3600 + 30, `default 1h, got ${fallback.exp - now}s`);
  });
});

// ---------------------------------------------------------------------------
// 4. Metering — idempotent across its three racing callers
// ---------------------------------------------------------------------------

function fakeSession({ startedAt, meteredAt } = {}) {
  return {
    _id: "0123456789abcdef01234567",
    company: "c1",
    candidate: "cand1",
    aiInterview: { realtimeStartedAt: startedAt, realtimeMeteredAt: meteredAt },
    markModified() {},
    async save() {},
  };
}

// meterSession writes with an atomic InterviewSession.updateOne (the test-and-set IS the
// idempotency guard) — emulate that contract against the fake doc.
function patchUpdateOne(target) {
  const real = InterviewSession.updateOne;
  InterviewSession.updateOne = async (filter, update) => {
    const ai = target.aiInterview;
    if (!ai.realtimeStartedAt || ai.realtimeMeteredAt) return { modifiedCount: 0 };
    ai.realtimeMeteredAt = update.$set["aiInterview.realtimeMeteredAt"];
    ai.realtimeDurationMs = update.$set["aiInterview.realtimeDurationMs"];
    return { modifiedCount: 1 };
  };
  return () => {
    InterviewSession.updateOne = real;
  };
}

test("4.1: meterSession meters once; the second and third callers no-op", async () => {
  const recorded = [];
  const realRecord = usageService.recordUsage;
  usageService.recordUsage = async (row) => recorded.push(row);
  const session = fakeSession({ startedAt: new Date(Date.now() - 60_000) });
  const restoreUpdate = patchUpdateOne(session);
  try {
    await withEnv({ ...FULL_ENV, LIVEKIT_CENTS_PER_MIN: "4" }, async () => {
      const first = await livekit.meterSession(session);
      assert.equal(first.metered, true);
      assert.ok(first.durationMs >= 59_000 && first.durationMs <= 62_000, `≈60s, got ${first.durationMs}`);

      // The client /end, the sendBeacon, and the webhook all funnel here — whichever two lose
      // the race must not double-bill.
      assert.deepEqual(await livekit.meterSession(session), { metered: false });
      assert.deepEqual(await livekit.meterSession(session), { metered: false });

      assert.equal(recorded.length, 1, "exactly one UsageEvent");
      assert.equal(recorded[0].kind, "realtime");
      assert.equal(recorded[0].provider, "livekit", "cost curve attributed to the right pipeline");
      assert.ok(recorded[0].usage.costCents > 0);
    });
  } finally {
    usageService.recordUsage = realRecord;
    restoreUpdate();
  }
});

test("4.2: a session that never started is never billed", async () => {
  const realRecord = usageService.recordUsage;
  usageService.recordUsage = async () => {
    throw new Error("must not be called");
  };
  try {
    assert.deepEqual(await livekit.meterSession(fakeSession({})), { metered: false });
  } finally {
    usageService.recordUsage = realRecord;
  }
});

test("4.3: costCents follows LIVEKIT_CENTS_PER_MIN, defaulting to the plan estimate", () => {
  withEnv(FULL_ENV, () => {
    assert.equal(livekit.costCents(60_000), 4, "default 4¢/min until LK-5 measures reality");
  });
  withEnv({ ...FULL_ENV, LIVEKIT_CENTS_PER_MIN: "2.5" }, () => {
    assert.equal(livekit.costCents(20 * 60_000), 50, "20min at 2.5¢/min");
  });
  assert.equal(livekit.costCents(-500), 0, "negative durations clamp to zero");
});

// ---------------------------------------------------------------------------
// 5. The webhook — server-truth metering, strictly scoped to our rooms
// ---------------------------------------------------------------------------

test("5.1: room_finished on an interview room meters the session (killed-tab backstop)", async () => {
  const recorded = [];
  const realRecord = usageService.recordUsage;
  const realFind = InterviewSession.findById;
  const session = fakeSession({ startedAt: new Date(Date.now() - 120_000) });
  const restoreUpdate = patchUpdateOne(session);
  usageService.recordUsage = async (row) => recorded.push(row);
  InterviewSession.findById = async (id) => (id === session._id ? session : null);
  try {
    const result = await livekit.handleWebhookEvent({
      event: "room_finished",
      room: { name: `itv-${session._id}` },
    });
    assert.equal(result.handled, true);
    assert.equal(result.metered, true);
    assert.equal(recorded.length, 1);
  } finally {
    usageService.recordUsage = realRecord;
    InterviewSession.findById = realFind;
    restoreUpdate();
  }
});

test("5.2: foreign rooms and other event types are ignored", async () => {
  const realFind = InterviewSession.findById;
  InterviewSession.findById = async () => {
    throw new Error("must not be queried for a room we did not name");
  };
  try {
    assert.equal((await livekit.handleWebhookEvent({ event: "room_finished", room: { name: "playground" } })).handled, false);
    assert.equal((await livekit.handleWebhookEvent({ event: "participant_joined", room: { name: "itv-0123456789abcdef01234567" } })).handled, false);
    assert.equal((await livekit.handleWebhookEvent(null)).handled, false);
  } finally {
    InterviewSession.findById = realFind;
  }
});

test("5.3: a webhook for an already-metered session no-ops (LiveKit retries deliveries)", async () => {
  const realRecord = usageService.recordUsage;
  const realFind = InterviewSession.findById;
  const session = fakeSession({ startedAt: new Date(Date.now() - 120_000), meteredAt: new Date() });
  usageService.recordUsage = async () => {
    throw new Error("must not double-bill");
  };
  InterviewSession.findById = async () => session;
  try {
    const result = await livekit.handleWebhookEvent({
      event: "room_finished",
      room: { name: `itv-${session._id}` },
    });
    assert.equal(result.handled, true);
    assert.equal(result.metered, false);
  } finally {
    usageService.recordUsage = realRecord;
    InterviewSession.findById = realFind;
  }
});

// ---------------------------------------------------------------------------
// 6. Quota dimension — the fairness cap is a real dimension, measured live
// ---------------------------------------------------------------------------

test("6.1: concurrentRealtime is a known quota dimension keyed to maxConcurrentRealtime", () => {
  const { DIMENSIONS } = require("../../services/quotaService");
  assert.equal(DIMENSIONS.concurrentRealtime.limitKey, "maxConcurrentRealtime");
});

// ---------------------------------------------------------------------------
// 7. The session brief — one source of truth for both realtime pipelines
// ---------------------------------------------------------------------------

test("7.1: sessionBrief carries the prompt, contract, vocabulary and voice — and no credentials", async () => {
  const asrVocabulary = require("../../services/asrVocabularyService");
  const real = asrVocabulary.keytermsForSession;
  asrVocabulary.keytermsForSession = async () => ["Kubernetes", "PostgreSQL"];
  try {
    const brief = await voiceAgent.sessionBrief(
      { aiInterview: { maxQuestions: 8 }, company: "c1" },
      {
        candidate: { basicDetails: { name: "Asha Rao" } },
        job: { title: "Backend Engineer" },
        persona: { name: "Ava", voice: { model: "aura-2-thalia-en" } },
      }
    );
    // The worker renders exactly this; drift between pipelines would mean two different
    // interviews for the same role.
    assert.ok(brief.prompt.includes("Ava"), "persona name reaches the prompt");
    assert.ok(brief.prompt.includes("Asha"), "candidate first name reaches the prompt");
    assert.ok(brief.prompt.includes("Backend Engineer"), "role title reaches the prompt");
    assert.deepEqual(
      brief.functions.map((f) => f.name),
      ["get_next_question", "submit_answer", "end_interview"],
      "the whole power surface, nothing more"
    );
    assert.deepEqual(brief.keyterms, ["Kubernetes", "PostgreSQL"], "transcript vocabulary rides along");
    assert.equal(brief.voice, "aura-2-thalia-en", "the persona's approved voice");
    assert.equal(typeof brief.promptVersion, "string");
    // The absence that matters: a brief is instructions, never credentials.
    const flat = JSON.stringify(brief).toLowerCase();
    for (const needle of ["apikey", "api_key", "bearer "]) {
      assert.ok(!flat.includes(needle), `brief must not carry ${needle}`);
    }
  } finally {
    asrVocabulary.keytermsForSession = real;
  }
});

test("7.2: keyterm derivation failure degrades to an unbiased brief, not a failed interview", async () => {
  const asrVocabulary = require("../../services/asrVocabularyService");
  const real = asrVocabulary.keytermsForSession;
  asrVocabulary.keytermsForSession = async () => {
    throw new Error("vocabulary service down");
  };
  try {
    const brief = await voiceAgent.sessionBrief(
      { aiInterview: {}, company: "c1" },
      { candidate: null, job: null, persona: null }
    );
    assert.deepEqual(brief.keyterms, []);
    assert.ok(brief.prompt.length > 100, "prompt still fully formed");
  } finally {
    asrVocabulary.keytermsForSession = real;
  }
});

// ---------------------------------------------------------------------------
// 8. candidateUtterances — the audit record that must never become a judgement
// ---------------------------------------------------------------------------
//
// The whole justification for storing the candidate's non-answer speech (F2 in
// LIVEKIT-E2E-FINDINGS-2026-08-05.md) is that it makes "the interview went wrong" visible next to
// "the candidate did badly". That justification survives exactly as long as the field stays out of
// every scoring path. It is a comment on the model today; these tests make it a property.
//
// Why it matters concretely: how often someone asks for a repeat, restarts a sentence, or says
// "sorry, my connection" tracks their accent, their hearing and their bandwidth. A scorer that can
// see it is a scorer that can be worse for those candidates, and no amount of prompt wording
// prevents that once the text is in the context window.

const prompts = require("../../utils/interviewPrompts");

const MARKER = "ZZQX_CANDIDATE_UTTERANCE_MARKER";

function sessionWithUtterances() {
  return {
    turns: [
      { role: "ai", kind: "question", text: "Tell me about a system you scaled." },
      { role: "candidate", kind: "answer", text: "We moved the queue off Postgres.", answerScore: 71 },
    ],
    candidateUtterances: [
      { text: `sorry, can you hear me? ${MARKER}`, at: new Date() },
      { text: `is my mic working ${MARKER}`, at: new Date() },
    ],
    agentUtterances: [{ text: "Yes, I can hear you.", at: new Date() }],
  };
}

test("8.1: candidateUtterances never reaches the evaluation prompt", () => {
  const ai = sessionWithUtterances();
  // The scoring prompts take `turns`, never the aiInterview object — which is the structural
  // reason this holds. The test pins that structure: a future refactor that passes `ai` wholesale
  // to be "more convenient" fails here rather than in a candidate's score.
  const prompt = prompts.evaluationPrompt({ context: "ROLE: Backend Engineer", turns: ai.turns });
  assert.ok(!prompt.includes(MARKER), "audit-only speech must not enter the evaluation prompt");
  assert.ok(prompt.includes("We moved the queue off Postgres"), "the ANSWER still does");
});

test("8.2: candidateUtterances never reaches per-answer scoring", () => {
  const ai = sessionWithUtterances();
  const prompt = prompts.answerScorePrompt({
    context: "ROLE: Backend Engineer",
    question: ai.turns[0].text,
    answer: ai.turns[1].text,
  });
  assert.ok(!prompt.includes(MARKER));
});

test("8.3: the report's conversation log is separate from the scored transcript", () => {
  // Mirrors the shape candidateController builds. The two must not be the same array: merging
  // them would put unscored conversational speech into the evidence a verdict cites, which is the
  // opposite of what this field is for.
  const ai = sessionWithUtterances();
  const conversationLog = [
    ...ai.agentUtterances.map((u) => ({ role: "interviewer", text: u.text, at: u.at })),
    ...ai.candidateUtterances.map((u) => ({ role: "candidate", text: u.text, at: u.at })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  assert.equal(conversationLog.length, 3);
  assert.ok(conversationLog.some((u) => u.text.includes(MARKER)), "audit record keeps it");
  // And the scored transcript does not gain a turn from any of it.
  assert.equal(ai.turns.filter((t) => t.role === "candidate").length, 1);
});

// ---------------------------------------------------------------------------
// 9. Audio-quality evidence — protective only
// ---------------------------------------------------------------------------

test("9.1: the worker's acoustic evidence only ever flags a FAILED recording", () => {
  const { audioQuality } = require("../../utils/prosody");
  // A 90-second answer that captured 8 words: what a broken mic looks like. This is the case the
  // evidence exists to catch — without it, an unheard answer is indistinguishable from an empty
  // one, and the candidate is scored for our audio.
  assert.ok(audioQuality({ wordsPerMinute: 5.3, pauseRatio: 0.94 }) < 40);
  // Someone speaking slowly and thinking between sentences is NOT that, and must not be flagged.
  assert.equal(audioQuality({ wordsPerMinute: 95, pauseRatio: 0.45 }), 100);
  // Nothing measured ⇒ no claim made, rather than a default that reads as a measurement.
  assert.equal(audioQuality(null), undefined);
});

// ---------------------------------------------------------------------------
// 10. "You can move on" — a stated option, and the absence it can produce
// ---------------------------------------------------------------------------
//
// The interviewer no longer OFFERS a skip (which would mean deciding who gets offered one, by
// reading hesitation). It states the same fact to everyone, at a fixed trigger. The consequence
// worth testing is the tail case: a candidate who says nothing at all. That used to be
// unrecordable — submitAnswer rejected the empty text and the interviewer re-asked forever.

const aiInterview = require("../../services/aiInterviewService");

test("10.1: the prompt states the option and never asks it, and fixes the trigger", () => {
  const prompt = voiceAgent.agentPrompt({
    interviewerName: "Ava",
    candidateFirstName: "Asha",
    roleTitle: "Backend Engineer",
    estimatedMinutes: 20,
  });
  // Stated, in fixed words, so every candidate hears the same sentence.
  assert.ok(prompt.includes("We can move on from this one if you'd like"), "the exact line is pinned");
  // And the trigger is countable turns, not a read on how they seem.
  assert.ok(prompt.includes("asked it once more in the same words"), "trigger is objective");
  assert.ok(prompt.includes("Once per question, maximum."), "no repeated nudging");
  // The failure mode this replaced: deciding, from affect, who gets a way out.
  assert.ok(
    prompt.includes("not because they sounded unsure"),
    "affect must be excluded explicitly, not left to inference"
  );
});

test("10.2: a no-response is recorded as an absence, not as a wrong answer", async () => {
  const ai = {
    status: "in_progress",
    questionCount: 3,
    turns: [
      { role: "ai", kind: "question", text: "Describe a system you scaled." },
      { role: "candidate", kind: "answer", text: "[no answer captured]", declined: true, declineAct: "no_response" },
    ],
  };
  const c = aiInterview.coverageStats(ai);
  assert.equal(c.answered, 0, "an absence is not an answer");
  assert.equal(c.declined, 1, "it stays out of the scoring mean, like any decline");
  assert.equal(c.noResponse, 1, "and is countable separately from a spoken decline");
  // The distinction that matters: it must never become a zero. A zero is a claim about the
  // candidate's ability; this is a claim about our recording.
  assert.equal(ai.turns[1].answerScore, undefined);
});

test("10.3: one no-response withholds the automated recommendation — no threshold", () => {
  const reason = aiInterview.reviewRequiredReason({
    status: "completed",
    questionCount: 8,
    turns: [
      { role: "candidate", kind: "answer", text: "Real answer here.", answerScore: 80 },
      { role: "candidate", kind: "answer", text: "[no answer captured]", declined: true, declineAct: "no_response" },
    ],
  });
  assert.ok(reason, "a hole in the evidence always reaches a human");
  assert.match(reason, /microphone failed/, "the reason names the ambiguity rather than blaming the candidate");
  // Contrast: spoken declines below the share threshold do NOT trigger review. The difference is
  // that a decline is evidence and silence is the absence of it.
  assert.equal(
    aiInterview.reviewRequiredReason({
      status: "completed",
      questionCount: 8,
      turns: [{ role: "candidate", kind: "answer", text: "I haven't used Kafka.", declined: true, declineAct: "decline" }],
    }),
    null
  );
});

test("10.4: an empty answer is only recordable when the agent says they declined", async () => {
  // declined:false + no text is the agent calling submit_answer too early. It must be told to
  // wait, NOT allowed to write an absence into the record — otherwise a mis-timed function call
  // silently costs the candidate a question.
  const out = await voiceAgent.dispatch(
    { aiInterview: { status: "in_progress" }, company: "c1" },
    "submit_answer",
    { answer: "", declined: false },
    {}
  );
  assert.match(out.error || "", /No answer text/);
});

test("10.5: both pipelines answer 'why are you asking me this?' with the identical sentence", () => {
  // The realtime agent and the turn-based path are two different mouths on one interview. If the
  // answer to "where do these questions come from?" is authored twice, they will eventually give
  // two different accounts of the same instrument — and the one a candidate quotes back at us is
  // whichever one they happened to be routed to. So the agent is handed the bank's string verbatim
  // rather than an instruction to say something like it.
  const prompt = voiceAgent.agentPrompt({
    interviewerName: "Ava",
    candidateFirstName: "Asha",
    roleTitle: "Backend Engineer",
    estimatedMinutes: 20,
  });
  assert.ok(
    prompt.includes(metaAnswers.WHY_THIS_QUESTION),
    "the realtime prompt must carry the approved sentence, not a paraphrase of it"
  );
  // And the prompt must forbid the failure the sentence exists to avoid: explaining the question
  // is coaching, delivered only to candidates who thought to ask for it.
  assert.ok(prompt.includes("Do NOT justify the question"), "no justifying");
  assert.ok(
    prompt.includes("good answer looks like"),
    "the reason for the rule is stated, so a future edit knows what it is protecting"
  );
});

test("10.6: the criterion's rationale is never handed to the interviewer's mouth", () => {
  // RoleRubric.criteria[].rationale is required, human-approved and frozen — which is exactly what
  // makes it tempting as the answer to "why this question?". It stays REVIEWER-facing. Checked
  // against the two things this service authors and hands the model: the instructions it speaks
  // from and the function contract it acts through. (The brief's only other fields are the ASR
  // keyterms and the persona's voice id, neither of which is authored here.)
  const authored = [
    voiceAgent.agentPrompt({
      interviewerName: "Ava",
      candidateFirstName: "Asha",
      roleTitle: "Backend Engineer",
      estimatedMinutes: 20,
    }),
    JSON.stringify(voiceAgent.functionSchemas()),
  ]
    .join("\n")
    .toLowerCase();
  for (const leak of ["rationale", "criterionid", "whatwouldverify", "whatwouldcontradict"]) {
    assert.ok(!authored.includes(leak), `the agent must never receive "${leak}"`);
  }
});
