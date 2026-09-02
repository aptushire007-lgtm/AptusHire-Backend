// The realtime interview's ENGINE endpoints — services/voiceAgentService.js.
//
// These two handlers (/realtime/function and /realtime/transcript) are the LiveKit worker's whole
// reach into the interview engine: every question it asks, every answer it records, and the
// transcript the guardrail scans arrive here on the candidate's own portal JWT. The Deepgram
// Voice Agent transport that this controller originally fronted (session mint + browser Settings
// relay) was retired in favour of the LiveKit pipeline — see livekitController for the session
// surface that replaced it.
//
// Auth is the portal's existing session JWT (requireCandidateAuth), so every call is bound to
// exactly one InterviewSession the same way every other portal request is.

const CompanySettings = require("../models/CompanySettings");
const InterviewSession = require("../models/InterviewSession");
const voiceAgent = require("../services/voiceAgentService");
const livekitService = require("../services/livekitService");
const guardrail = require("../utils/agentGuardrail");
const aiInterview = require("../services/aiInterviewService");

// How many of the agent's own utterances to retain per session. This is the audit record that
// replaces exact-match speech authorization, so it is generous — but bounded, because a candidate's
// browser is the thing posting them and an unbounded array is an unbounded write.
const MAX_AGENT_UTTERANCES = 400;
// Guardrail findings are the evidence in a complaint, so the tail is long. A well-behaved agent
// produces none at all; a misbehaving one produces the first few that identify the problem.
const MAX_GUARDRAIL_HITS = 100;
const MAX_UTTERANCE_CHARS = 2000;
const MAX_UTTERANCES_PER_FLUSH = 50;

function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, n));
}

// What the transport (the LiveKit worker) measured during the turn, sanitised. Mirrors the
// turn-based path's handling in interviewPortalController, and the trust model is the same: raw
// measurements are accepted (a caller gains nothing by lying about them, and every derived SCORE
// is computed server-side), but every value is clamped so a bad one cannot land in the document.
//
// The transcript is the important field — it is the verbatim speech-to-text, and it displaces the
// agent's own rendering as the candidate's evidence. See voiceAgentService.submitAnswer.
const MAX_EVIDENCE_CHARS = 4000;

function sanitizeEvidence(e) {
  if (!e || typeof e !== "object") return {};
  const out = {
    transcript: String(e.transcript || "").slice(0, MAX_EVIDENCE_CHARS),
    audioDurationMs: clampNum(e.audioDurationMs, 0, 60 * 60 * 1000),
    confidence: clampNum(e.confidence, 0, 1),
  };
  if (e.acoustic && typeof e.acoustic === "object") {
    const a = {
      wordsPerMinute: clampNum(e.acoustic.wordsPerMinute, 0, 400),
      pauseRatio: clampNum(e.acoustic.pauseRatio, 0, 1),
      fillerRate: clampNum(e.acoustic.fillerRate, 0, 100),
      energyVariance: clampNum(e.acoustic.energyVariance, 0, 1e6),
    };
    if (Object.values(a).some((v) => v !== undefined)) out.acoustic = a;
  }
  // Only an interruption is worth recording. Claiming a question WAS interrupted can only make the
  // interview longer (its probe returns to pending), so there is no version of this a candidate
  // benefits from lying about.
  if (e.questionDelivery && e.questionDelivery.deliveredFully === false) {
    out.questionDelivery = {
      deliveredFully: false,
      interruptedAtChar: clampNum(e.questionDelivery.interruptedAtChar, 0, 100000),
    };
  }
  const drops = clampNum(e.connection?.drops, 0, 50);
  if (drops > 0) {
    out.connection = { drops, gapMs: clampNum(e.connection?.gapMs, 0, 60 * 60 * 1000) };
  }
  return out;
}

// Execute one function the agent asked for, and hand back the result it will speak from.
//
// The worker relays the request; it does not answer it. Every field that decides anything — which
// question comes next, whether a probe is covered, whether the interview may close — is re-derived
// from the InterviewSession here. The only thing taken from the agent is the candidate's answer
// text, which is the one thing only it heard.
async function realtimeFunction(req, res) {
  const session = req.interviewSession;
  const settings = await CompanySettings.findOne({ company: session.company }).select("ai compliance");
  // The engine contract for the LiveKit pipeline. (When two realtime pipelines coexisted this
  // gate was "either is on" — gating on one pipeline's flag alone 404'd every function call for
  // livekit tenants, found live in the LK-2 e2e. With one pipeline left the lesson survives as:
  // this gate must track the pipeline that actually calls it.)
  if (!livekitService.isEnabled(settings)) {
    return res.status(404).json({ error: "Realtime voice interview is not enabled", code: "REALTIME_DISABLED" });
  }

  const name = String(req.body?.name || "").trim();
  const args = req.body?.arguments && typeof req.body.arguments === "object" ? req.body.arguments : {};

  const evidence = sanitizeEvidence(req.body?.evidence);
  // Other writers touch this session while a dispatch is in flight — transcript flushes,
  // proctoring batches, evidence-clip bookkeeping — and a save that loses that race throws
  // VersionError with nothing persisted. Seen live 2026-08-18: two submit_answer calls died
  // this way and the answers were dropped. The recovery is a fresh doc and a re-run, never a
  // retry on the same instance (its half-applied mutations would then be applied twice).
  let doc = session;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await voiceAgent.dispatch(doc, name, args, evidence);
      return res.json({ result });
    } catch (err) {
      if (err?.name === "VersionError" && attempt < 2) {
        const fresh = await InterviewSession.findById(session._id).catch(() => null);
        if (fresh) {
          doc = fresh;
          continue;
        }
      }
      // A thrown engine error must NOT become a dead conversation. The agent is mid-turn with a
      // candidate waiting, so it gets a speakable instruction back rather than an HTTP failure it
      // has no way to interpret — the interview continues and the failure is logged for us.
      console.error(`[voiceAgent] function "${name}" failed on session ${session._id}: ${err.message}`);
      return res.json({
        result: {
          error: err.message,
          instruction:
            "Something went wrong on our side. Apologise briefly, tell the candidate you'll move on, " +
            "and call get_next_question to continue.",
        },
      });
    }
  }
}

// Store what was actually said, in batches — the interviewer's words and the candidate's, kept
// apart.
//
// The interviewer's half is the audit record that replaces exact-match speech authorization once
// it is allowed to improvise. It is what makes "what did the interviewer say to this candidate?"
// answerable — the question a discrimination claim turns on, and the one an unconstrained
// speech-to-speech competitor cannot answer at all.
//
// The candidate's half makes the other direction answerable: "what did I actually say, and did it
// reach you?" Stored, shown, never scored.
async function realtimeTranscript(req, res) {
  const session = req.interviewSession;
  const incoming = Array.isArray(req.body?.utterances) ? req.body.utterances : [];

  // Both sides are stored, in two separate arrays that are treated completely differently.
  //
  // The AGENT's speech is the guardrail's input and the answer to "what did the interviewer say to
  // this candidate?". The CANDIDATE's speech is the audit record and nothing else: never
  // guardrailed, never scored (see candidateUtterances on the model). Keeping them apart is what
  // stops a record of what a candidate said from ever becoming a judgement about them.
  //
  // This is deliberately a second, differently-segmented copy of the candidate's words — `turns`
  // holds the engine's segmentation of the ANSWERS. The two can disagree, and that disagreement is
  // information: it is how "the transcript shows one sentence but I talked for a minute" becomes
  // checkable instead of a candidate's word against a database row.
  const clean = [];
  const candidate = [];
  for (const item of incoming) {
    if (clean.length + candidate.length >= MAX_UTTERANCES_PER_FLUSH) break;
    const text = String(item?.text || "").trim().slice(0, MAX_UTTERANCE_CHARS);
    if (!text) continue;
    const role = item?.role;
    if (role !== "assistant" && role !== "candidate") continue;
    const at = Number(item?.at);
    const row = { text, at: Number.isFinite(at) ? new Date(at) : new Date() };
    (role === "assistant" ? clean : candidate).push(row);
  }
  if (!clean.length && !candidate.length) return res.json({ stored: 0 });

  // Everything this handler stores is an append to a capped array, so it is written as an
  // atomic $push/$slice rather than a doc save. This is not a style choice: flushes arrive
  // WHILE a /realtime/function dispatch holds its own copy of the doc, and a whole-doc save
  // here bumps the version key and kills that dispatch's save (VersionError — seen live
  // 2026-08-18, dropping submitted answers). An atomic array push conflicts with nothing.
  const ai = session.aiInterview;
  const push = {};
  if (candidate.length) {
    push["aiInterview.candidateUtterances"] = { $each: candidate, $slice: -MAX_AGENT_UTTERANCES };
  }
  if (!clean.length) {
    // Candidate-only flush: nothing for the guardrail to scan, so store and return without
    // pretending a scan happened.
    await InterviewSession.updateOne({ _id: session._id }, { $push: push });
    return res.json({ stored: candidate.length, findings: 0 });
  }
  push["aiInterview.agentUtterances"] = { $each: clean, $slice: -MAX_AGENT_UTTERANCES };

  // ---- The guardrail ------------------------------------------------------
  //
  // Runs here, on the transcript, rather than anywhere near the audio path — so it adds nothing to
  // the latency the candidate feels. It is the enforcement half of the prompt's prevention: the
  // instructions tell the agent what it may not say, and this checks whether it said it, because
  // "we asked the model nicely" is not a control anyone can audit.
  const authorized = guardrail.authorizedUtterances(ai);
  const found = [];
  let halt = null;
  for (const utterance of clean) {
    const { hits, severity } = guardrail.scan(utterance.text, { authorizedQuestions: authorized });
    if (!hits.length) continue;
    for (const hit of hits) {
      found.push({
        ruleId: hit.ruleId,
        severity: hit.severity,
        label: hit.label,
        matched: hit.matched,
        // The verbatim utterance, not a summary. "What exactly did the interviewer say to me?" is
        // the question a complaint turns on, and it cannot be answered from a rule name.
        utterance: utterance.text,
        at: utterance.at,
      });
    }
    if (guardrail.shouldHalt(severity) && !halt) halt = found[found.length - 1];
  }

  if (found.length) {
    push["aiInterview.guardrailHits"] = { $each: found, $slice: -MAX_GUARDRAIL_HITS };
    console.error(
      `[guardrail] ${found.length} finding(s) on session ${session._id}: ` +
        found.map((f) => `${f.ruleId}(${f.severity})`).join(", ")
    );
  }

  await InterviewSession.updateOne({ _id: session._id }, { $push: push });

  if (halt) {
    // Stop the interview. NEVER adverse to the candidate: the interviewer went off-script, not
    // them. This routes to human review with the recommendation withheld, exactly like a
    // withdrawal — see aiInterviewService.reviewRequiredReason.
    try {
      await aiInterview.haltForGuardrail(session, halt);
    } catch (err) {
      console.error(`[guardrail] halt failed on session ${session._id}: ${err.message}`);
    }
    return res.json({
      stored: clean.length + candidate.length,
      halted: true,
      // The client disconnects and shows this. It does not repeat what the interviewer said —
      // reading an unlawful question back to the candidate to apologise for it is worse than the
      // original — and it does not imply anything about their performance.
      message: guardrail.HALT_MESSAGE,
    });
  }

  res.json({ stored: clean.length + candidate.length, findings: found.length });
}

module.exports = {
  realtimeFunction,
  realtimeTranscript,
  sanitizeEvidence,
  MAX_AGENT_UTTERANCES,
  MAX_UTTERANCES_PER_FLUSH,
};
