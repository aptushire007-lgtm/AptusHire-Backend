// Tier 1: what did the candidate mean?
//
// Consulted only where the deterministic matchers are silent (utils/conversationIntent.js
// explains the two-tier split and why a model is allowed to make this call at all). Its job is to
// understand an utterance the way a person in the room would — with the interviewer's own last
// sentence, the question in flight, and the half-answer already given as context — and resolve it
// to one of a closed set of actions.
//
// FOUR RULES THIS SERVICE IS BUILT AROUND
//
// 1. It never blocks a turn. Every failure — no key, timeout, breaker open, malformed JSON,
//    nonsense action — resolves to `answer_continues`, which is the behaviour the interviewer had
//    before this file existed. A degraded classifier makes the interviewer less perceptive; it can
//    never make it stuck, and it can never make it wrong about a score, because it cannot reach one.
//
// 2. It defaults to "they were answering". The costly error here is reading a real answer as a
//    request and discarding evidence the candidate was in the middle of giving. Reading a request
//    as an answer merely means we did not notice — the candidate says it again, and Tier 0 or the
//    next pass catches it. So every uncertainty falls the same way, and the prompt says so.
//
// 3. It reads only what is in front of it. It is given the utterance, the immediate conversational
//    context, and nothing else — no résumé, no rubric, no scores, no prior evaluation. It cannot
//    form an opinion about the candidate because it is never shown enough to have one, and nothing
//    downstream reads its output as evidence.
//
// 4. It is on the record. Every classification is metered and returned with the model id and
//    prompt version that produced it, so the stored turn answers "why did the interviewer do
//    that?" from data rather than from memory.

const llm = require("./llmService");
const usageService = require("./usageService");
const { resolveRole } = require("../config/models");
const conversationIntent = require("../utils/conversationIntent");
const metaAnswers = require("../utils/metaAnswers");
const { SECURITY_SENTENCE, fenceUntrusted } = require("../utils/promptSafety");

const PROVIDER = "openrouter";

// Bump when the wording below changes, so a stored classification records which prompt produced
// it. Part of the cache key and the replay fixture key (llmService), so an edit invalidates
// cleanly rather than silently serving decisions made under the old wording.
const PROMPT_VERSION = "2026-08-20.1";

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

const SYSTEM =
  "You interpret what a candidate means during a live job interview. You are not the interviewer " +
  "and you never speak to the candidate; you classify one utterance so the interviewer's own code " +
  "can decide what to do. You never assess the candidate, never judge whether an answer is good, " +
  "and never comment on their performance. " +
  SECURITY_SENTENCE;

// The behavioural core. Written as distinctions rather than as a list of labels, because the whole
// reason this tier exists is the cases a label list already failed to catch.
const GUIDANCE = `
Decide what the candidate wants, choosing exactly one action:

- answer_continues — they are ANSWERING the question. This is the default and by far the most
  common. Choose it whenever you are not clearly convinced otherwise. In particular, all of these
  are answers, not requests: thinking out loud, hesitating, restarting a sentence, hedging
  ("I'm not sure I'm explaining this well"), being self-critical, apologising, narrating their own
  reasoning, or pausing mid-thought. A candidate saying "I don't know how to describe it, but
  basically we..." is ANSWERING.

- repeat — they did not HEAR the question, or it was cut off, or their attention lapsed. They want
  the same words again.

- clarify — they HEARD it and did not UNDERSTAND it. They want it put differently, or a term in it
  explained. "What do you mean by that?", "in what sense?", "are you asking about X or Y?".
  The difference from repeat is the whole point: someone who did not understand is not helped by
  hearing the identical sentence again.

- decline — they are choosing not to answer this one: they don't know it, haven't done it, or want
  to skip. Only when it is the WHOLE of what they are saying. "I don't know the exact figure, but
  we ran three brokers and..." is an ANSWER and a good one — do not read the opening words as a
  decline.

- pause — they want a moment to think before answering.

- already_answered — they are saying this question repeats ground they already covered, most
  often in reply to a follow-up: "I already answered that", "like I said a moment ago", "didn't I
  already cover this?". Different from decline (not an admission of not knowing) and from
  repeat/clarify (they are not asking to hear it again — they are saying it should not be asked at
  all). Only when it is the WHOLE of what they are saying; a candidate who references something
  they said earlier while continuing to answer ("like I mentioned, we also...") is answer_continues.
  Whether they are actually right is decided afterwards from the transcript, not by you.

- meta_question — they are asking about the interview process rather than answering: how many
  questions are left, how long it takes, whether they can type instead, whether it is recorded,
  whether they can come back to a question, who sees it, or why they are being asked a particular
  question ("why are you asking me this?", "what's this got to do with the job?"). If they ask how
  they are DOING, or anything about their own performance or chances, that is NOT a meta_question —
  return answer_continues, because the interviewer must not discuss that.

  "Why are you asking this?" and "what are you looking for here?" sound alike and are different
  requests. The first asks where the question came from — meta_question, metaTopic
  why_this_question. The second asks what a good answer contains, and that is clarify: the
  interviewer rewords the question and says nothing about what it wants to hear. When it could be
  either, choose clarify, which gives them the question again and tells them nothing they should
  not be told.

- technical_problem — something is broken. They cannot hear us, their microphone is failing, the
  audio is cutting out.

- withdraw — they want to stop the interview entirely and not continue.

- finished — they have finished this answer and are handing the floor back. "That's my answer",
  "I think that covers it", "yeah, that's about all I've got on that one", "and that's how we did
  it, so, yeah". Choose this ONLY when what they are handing back is a real, substantive answer
  they have just given; a trailing "so yeah" in the middle of thinking is answer_continues. Getting
  this wrong submits half an answer as a whole one, so when in doubt it is answer_continues and the
  interviewer simply waits a moment longer.

Use the context. The interviewer's last utterance usually settles it: "sorry, what?" right after a
question means repeat; the same words right after an unfamiliar technical term mean clarify.

Report confidence honestly. Below 0.7 the interviewer ignores you and treats the utterance as part
of the answer, which is the correct outcome when you are unsure.
`.trim();

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: conversationIntent.TIER1_ACTIONS },
    confidence: { type: "number" },
    // Free text, stored and shown to a human reviewing the interview. Never parsed, never scored.
    reason: { type: "string" },
    // The part of the utterance that was NOT the request, so a half-answer is not thrown away.
    // Verified as a literal substring before it is used (conversationIntent.literalResidue) — a
    // model-invented residue would put words the candidate never said into their answer.
    residue: { type: "string" },
    // Only meaningful when action is meta_question.
    metaTopic: { type: "string", enum: [...metaAnswers.TOPIC_NAMES, "other"] },
  },
  required: ["action", "confidence", "reason"],
};

/**
 * Build the classification prompt.
 *
 * Everything the candidate said is fenced as untrusted, exactly as it is in the résumé and
 * interview pipelines: this text reaches a model and a résumé that says "ignore your instructions"
 * would otherwise get a free attempt at rewriting how the interviewer behaves.
 *
 * The interviewer's own utterances are NOT fenced — they are our authored, pre-approved text.
 */
function classifyPrompt({ utterance, interviewerSaid, questionAsked, answerSoFar }) {
  const context = [
    questionAsked ? `THE QUESTION THEY ARE ANSWERING:\n${questionAsked}` : "",
    interviewerSaid ? `WHAT THE INTERVIEWER SAID MOST RECENTLY:\n${interviewerSaid}` : "",
    answerSoFar
      ? `WHAT THE CANDIDATE HAS ALREADY SAID IN THIS TURN:\n${fenceUntrusted(answerSoFar)}`
      : "(the candidate has not said anything else in this turn yet)",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    GUIDANCE,
    "---",
    context,
    "---",
    `THE UTTERANCE TO CLASSIFY:\n${fenceUntrusted(utterance)}`,
    "Return your classification as JSON.",
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

// Its own timeout, far below the platform default. A classifier that answers after the candidate
// has finished talking is worse than useless — it would act on a turn that has already moved on —
// so this path abandons rather than arrives late.
function timeoutMs() {
  return Number(process.env.VOICE_INTENT_LLM_TIMEOUT_MS) || 1500;
}

// The safe answer, returned for every failure and every uncertainty.
function answering(reason) {
  return {
    action: "answer_continues",
    tier: 1,
    confidence: 0,
    needsConfirmation: false,
    consumesTurn: false,
    residue: "",
    matchedTrigger: null,
    reason,
    metaTopic: null,
    degraded: true,
  };
}

/**
 * Classify one utterance.
 *
 * Never throws. Never returns anything outside the closed action set. Never takes longer than its
 * own timeout to give up.
 *
 * @returns the gated result from conversationIntent.gateSemantic, plus { model, promptVersion,
 *          latencyMs, degraded }.
 */
async function classify({
  utterance,
  interviewerSaid = "",
  questionAsked = "",
  answerSoFar = "",
  session,
  candidate,
  settings,
} = {}) {
  const text = String(utterance == null ? "" : utterance).trim();
  if (!text) return answering("nothing_to_classify");

  // The same length gate the client applies, re-checked here: a long utterance is an answer, and
  // spending a model call to be told so is waste on the hottest path in the interview.
  const policy = conversationIntent.clientPolicy().intent;
  const words = (text.match(/[A-Za-z0-9']+/g) || []).length;
  // The COST guard, not the correctness one. `maxMetaWords` (the tighter number) is applied inside
  // gateSemantic, where the action is known and `finished` can be exempted — a hand-back is long
  // precisely because they were finishing an answer, so gating the call itself at 25 words would
  // make that action unreachable for the phrasings people actually use.
  if (words > policy.maxUtteranceWords) return answering("too_long_to_be_about_the_interview");
  if (words < policy.minWordsForLookup) return answering("too_short_to_classify");
  if (!policy.semanticEnabled) return answering("semantic_tier_disabled");
  if (!llm.isEnabled()) return answering("llm_unavailable");

  const t0 = Date.now();
  try {
    const resolved = resolveRole("cheap", settings);
    const { data, usage, model, cached } = await llm.generateJSON({
      system: SYSTEM,
      prompt: classifyPrompt({ utterance: text, interviewerSaid, questionAsked, answerSoFar }),
      schema: SCHEMA,
      maxTokens: 200,
      model: resolved.model,
      temperature: 0,
      promptVersion: PROMPT_VERSION,
      timeoutMs: timeoutMs(),
    });
    const latencyMs = Date.now() - t0;

    const gated = conversationIntent.gateSemantic(data, text, {
      minConfidence: policy.minConfidence,
      maxMetaWords: policy.maxMetaWords,
      minWordsForFinish: policy.minWordsForFinish,
      // How much answer already exists this turn. Only `finished` reads it, and only to refuse:
      // ending a turn is the one action that can submit half an answer as a whole one.
      answerWords: (String(answerSoFar || "").match(/[A-Za-z0-9']+/g) || []).length,
    });

    // Metered even when the answer was "they were just talking" — that call cost money and a
    // tenant's spend has to reflect what actually ran, not only what changed the interview.
    // Failure to meter must never fail the classification.
    if (session?.company) {
      usageService
        .recordUsage({
          company: session.company,
          session: session._id,
          candidate: candidate?._id,
          kind: "intent",
          provider: PROVIDER,
          model,
          usage,
          latencyMs,
          engine: "ai",
          promptVersion: PROMPT_VERSION,
          cached,
        })
        .catch((err) => console.error("[intent] metering failed:", err.message));
    }

    return { ...gated, model, promptVersion: PROMPT_VERSION, latencyMs, degraded: false };
  } catch (err) {
    // Includes the circuit breaker being open, which is the case this matters most for: when the
    // provider is failing, this path has to fail in milliseconds and hand the turn straight back.
    return { ...answering(`classifier_failed:${err.message}`), latencyMs: Date.now() - t0 };
  }
}

/**
 * The whole intent decision for one utterance: deterministic first, semantic only if needed.
 *
 * This is what a caller should use. Running the tiers in the wrong order — or consulting the
 * model when a trigger already matched — would spend money and latency to reach the answer we
 * already had.
 */
async function resolveIntent(utterance, context = {}) {
  const fast = conversationIntent.detectDeterministic(utterance, context.tier0 || {});
  if (fast) return { ...fast, degraded: false };
  return classify({ ...context, utterance });
}

module.exports = { PROMPT_VERSION, SCHEMA, SYSTEM, GUIDANCE, classifyPrompt, classify, resolveIntent };
