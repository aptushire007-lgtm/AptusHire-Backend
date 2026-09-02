const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const InterviewSession = require("../models/InterviewSession");
const storageService = require("../services/storageService");
const { hashToken } = require("../services/interviewInvitationService");
const { detectImageType } = require("../utils/verifyFileSignature");
const aiInterview = require("../services/aiInterviewService");
const speech = require("../services/speechService");
const asrVocabulary = require("../services/asrVocabularyService");
const backchannel = require("../utils/backchannel");
const speechAuth = require("../utils/speechAuthorization");
const speakable = require("../utils/speakable");
const namePronunciation = require("../utils/namePronunciation");
const personaService = require("../services/personaService");
const intentService = require("../services/intentService");
const intentPhraseService = require("../services/intentPhraseService");
const conversationIntent = require("../utils/conversationIntent");
const metaAnswers = require("../utils/metaAnswers");
const alreadyAnsweredResponder = require("../utils/alreadyAnsweredResponder");
const proctoring = require("../utils/proctoring");
const evidenceClipService = require("../services/evidenceClipService");
const interviewRecordingService = require("../services/interviewRecordingService");
const CompanySettings = require("../models/CompanySettings");
const { candidateLinkBase } = require("../utils/corsOrigins");

// How many intent readings to keep on a session. Generous, because unlike proctoring events these
// have no aggregate counterpart — the individual rows ARE the record of what the interviewer
// understood, and a complaint about one turn is answered by that turn's row or not at all. Still
// bounded: a candidate who talks continuously for an hour must not grow the document without limit.
const INTENT_TAIL = 200;

// Keep only a recent tail of raw events on the session (the per-type `counts` are the source of
// truth for the score); bound how many events one flush can carry to cap ingest cost.
const PROCTORING_EVENT_TAIL = 300;
const PROCTORING_MAX_PER_FLUSH = 100;

// Phase 14.6 — the phone companion heartbeats every ~10s; past this silence the
// laptop's next event flush raises phone_cam_lost (once per outage).
const PHONE_HEARTBEAT_TIMEOUT_MS = Number(process.env.PHONE_HEARTBEAT_TIMEOUT_MS) || 12000;
// The QR pairing token is single-purpose and short-lived: long enough to pull
// out a phone and scan, useless if the QR leaks later.
const PHONE_PAIR_TOKEN_TTL = "10m";

const SPEED_TEST_PAYLOAD = crypto.randomBytes(2 * 1024 * 1024); // 2MB, generated once at boot

function dashboardPayload(session, candidate, job, settings) {
  return {
    candidateName: candidate.basicDetails.name,
    jobTitle: job.title,
    department: job.department,
    interviewAt: session.interviewAt,
    expiresAt: session.expiresAt,
    status: session.status,
    instructions: session.instructions,
    startedAt: session.startedAt,
    deviceCheck: session.deviceCheck,
    speedTest: session.speedTest,
    identityVerification: session.identityVerification,
    // Phase 14 — tell the client which integrity features this tenant runs, so
    // the consent wording and the pairing QR only appear when they apply.
    features: {
      evidenceClips: evidenceClipService.clipsEnabled(settings),
      secondaryCam: evidenceClipService.secondaryCamEnabled(settings),
      // Whether this tenant records the whole session. The client needs it for two things: the
      // consent clause only appears when it applies, and the recorder never starts otherwise.
      // Both of the other consent clauses make promises ("raw video is not uploaded", "never
      // recorded continuously") that this feature contradicts, so when it is ON the wording of
      // those two clauses changes as well — see PreInterviewCheck.jsx.
      sessionRecording: interviewRecordingService.enabled(settings),
    },
  };
}

function signSession(session) {
  const expiresInSeconds = Math.max(60, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
  // session.candidate may be a populated Candidate doc or a raw ObjectId
  // depending on the caller — normalize to the id string either way.
  const candidateId = session.candidate._id ? String(session.candidate._id) : String(session.candidate);

  return jwt.sign(
    { candidateId, sessionId: String(session._id), epoch: session.sessionEpoch || 0 },
    process.env.JWT_SECRET,
    { expiresIn: expiresInSeconds }
  );
}

// The gate between "this is the right person" and a live portal token.
//
// It is deliberately separate from the magic-link lookup because there are now
// TWO independent ways to prove the same thing: possession of the mailbox (the
// emailed token) and possession of the account whose email owns the application
// (the candidate dashboard). Both must clear the SAME cancelled/expired checks
// and mint the SAME session-scoped JWT, so this lives in one place — a second
// copy of these rules would eventually disagree with this one about whether an
// interview is still open, and that disagreement decides someone's outcome.
//
// `session` must arrive with `candidate` and `job` populated. Throws with a
// `status` so both callers surface the service's own wording.
async function openSessionForOwner(session) {
  if (session.status === "cancelled") {
    throw Object.assign(new Error("This interview has been cancelled"), { status: 410 });
  }
  if (new Date() > session.expiresAt) {
    if (session.status !== "expired") {
      session.status = "expired";
      await session.save();
    }
    throw Object.assign(new Error("This interview link has expired"), { status: 410 });
  }

  if (!session.accessedAt) {
    session.accessedAt = new Date();
    await session.save();
  }

  const settings = await CompanySettings.findOne({ company: session.company }).select("proctoring");
  return {
    token: signSession(session),
    session: dashboardPayload(session, session.candidate, session.job, settings),
  };
}

async function login(req, res) {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token is required" });

  const session = await InterviewSession.findOne({ tokenHash: hashToken(token) })
    .populate("candidate")
    .populate("job");
  if (!session) return res.status(404).json({ error: "Invalid interview link" });

  try {
    res.json(await openSessionForOwner(session));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}

async function me(req, res) {
  const session = await InterviewSession.findById(req.interviewSession._id).populate("candidate").populate("job");
  const settings = await CompanySettings.findOne({ company: session.company }).select("proctoring");
  res.json(dashboardPayload(session, session.candidate, session.job, settings));
}

function speedTestFile(req, res) {
  res.set({
    "Content-Type": "application/octet-stream",
    "Content-Length": SPEED_TEST_PAYLOAD.length,
    "Cache-Control": "no-store",
  });
  res.send(SPEED_TEST_PAYLOAD);
}

const ECHO_PATH_VALUES = ["isolated", "bleeding", "inconclusive"];

async function submitChecks(req, res) {
  const { camera, microphone, screenShare, fullscreen, deviceCompatible, browserInfo, downloadMbps } = req.body;
  const session = req.interviewSession;

  // Audio isolation, measured in the browser (the only place it can be). Barge-in eligibility is
  // decided HERE from the measurement rather than taken from the client, so a client cannot ask for
  // interruption to be enabled on a device where the interviewer would talk over itself.
  const echoPath = ECHO_PATH_VALUES.includes(req.body?.echoPath) ? req.body.echoPath : "inconclusive";
  const audioOutputConfirmed = !!req.body?.audioOutputConfirmed;

  session.deviceCheck = {
    camera: !!camera,
    microphone: !!microphone,
    screenShare: !!screenShare,
    fullscreen: !!fullscreen,
    deviceCompatible: !!deviceCompatible,
    browserInfo,
    echoPath,
    echoRatio: clampNum(req.body?.echoRatio, 0, 1000),
    // Proof the microphone was heard at pre-check, not merely permitted.
    micPeak: clampNum(req.body?.micPeak, 0, 1),
    audioOutputConfirmed,
    // Fails closed: anything short of a measured isolated path plus a confirmed working output
    // leaves the interview turn-based, which is exactly what it was before this existed.
    bargeInEligible: echoPath === "isolated" && audioOutputConfirmed,
    completedAt: new Date(),
  };
  if (typeof downloadMbps === "number") {
    session.speedTest = { downloadMbps, testedAt: new Date() };
  }

  await session.save();
  res.json({ deviceCheck: session.deviceCheck, speedTest: session.speedTest });
}

async function uploadIdentityPhoto(req, res) {
  if (!req.file) return res.status(400).json({ error: "photo is required" });

  const imageType = detectImageType(req.file.buffer);
  if (!imageType) {
    return res.status(400).json({ error: "File content does not match a valid JPEG or PNG image" });
  }

  const session = req.interviewSession;
  const ext = imageType === "image/png" ? "png" : "jpg";
  const key = await storageService.putObject({
    buffer: req.file.buffer,
    key: storageService.buildKey("identity-photos", {
      company: session.company,
      prefix: String(session._id),
      originalName: `photo.${ext}`,
    }),
    contentType: imageType,
  });

  session.identityVerification = { photoPath: key, status: "captured", capturedAt: new Date() };
  await session.save();

  res.json({ identityVerification: session.identityVerification });
}

function missingChecks(session) {
  const missing = [];
  const dc = session.deviceCheck || {};
  if (!dc.camera) missing.push("camera");
  if (!dc.microphone) missing.push("microphone");
  // screenShare and fullscreen are deliberately NOT required. The screen-share
  // "check" was theater — the stream was stopped immediately and the screen was
  // never captured during the interview — and getDisplayMedia doesn't exist on
  // mobile browsers, so requiring it silently hard-blocked every mobile
  // candidate. Fullscreen is best-effort: proctoring already flags exits.
  if (!dc.deviceCompatible) missing.push("deviceCompatible");
  if (!session.speedTest || typeof session.speedTest.downloadMbps !== "number") missing.push("speedTest");
  if (!session.identityVerification || session.identityVerification.status !== "captured") {
    missing.push("identityVerification");
  }
  return missing;
}

async function startInterview(req, res) {
  const session = req.interviewSession;
  const missing = missingChecks(session);
  if (missing.length > 0) {
    return res.status(400).json({ error: "Pre-interview checks incomplete", missing });
  }

  // Plan quota (Phase 11.1): AI interviews are blocked at the START only — an
  // interview that already began is NEVER killed mid-flight by a limit.
  if (session.aiInterview?.status === "not_started") {
    await require("../services/quotaService").enforce(session.company, "aiInterviews");
  }

  if (session.status === "scheduled") {
    session.status = "in_progress";
    session.startedAt = new Date();
    await session.save();
  }

  // Kick off the AI interview (loads context, builds a plan, asks the first
  // question). Idempotent — a resumed session just returns its current state.
  const state = await aiInterview.beginInterview(session);
  res.json({ status: session.status, startedAt: session.startedAt, interview: state });
}

// Current interview state for the candidate (transcript + current question).
async function getInterviewState(req, res) {
  const session = req.interviewSession;
  if (session.aiInterview?.status === "not_started") {
    return res.json(aiInterview.publicState(session));
  }
  res.json(aiInterview.publicState(session));
}

// Clamp a client-supplied number into a sane range (or undefined). The browser computes raw
// prosody measurements during recording; we store the measurements but never trust a
// client-supplied *score* — the delivery/confidence score is derived server-side (V3).
function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, n));
}

function sanitizeAcoustic(a) {
  if (!a || typeof a !== "object") return undefined;
  const out = {
    wordsPerMinute: clampNum(a.wordsPerMinute, 0, 400),
    pauseRatio: clampNum(a.pauseRatio, 0, 1),
    fillerRate: clampNum(a.fillerRate, 0, 100),
    pitchVariance: clampNum(a.pitchVariance, 0, 1e6),
    energyVariance: clampNum(a.energyVariance, 0, 1e6),
  };
  return Object.values(out).some((v) => v !== undefined) ? out : undefined;
}

// The browser reports which non-evaluative interviewer phrases it played during the turn (it is
// the only side that knows — silence detection is real-time and client-owned). Every entry is
// checked against the server's approved bank, so an arbitrary string can never be recorded as
// something the interviewer said, and nothing outside the bank can be stripped from a
// transcript. The cap bounds a client that decides to report thousands.
const MAX_REPORTED_BACKCHANNELS = 12;

// `firstName` is this session's, because some approved phrases carry it ("Thank you, Priya.").
// Checking against the bank rendered for THIS candidate is what stops a client reporting another
// candidate's name-bearing phrase — and therefore stripping a real name out of its own transcript.
function sanitizeBackchannels(list, { firstName = "" } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (out.length >= MAX_REPORTED_BACKCHANNELS) break;
    if (!item || typeof item !== "object") continue;
    if (!backchannel.KINDS.includes(item.kind)) continue;
    if (!backchannel.isBankPhrase(item.phrase, { firstName })) continue;
    const at = Number(item.at);
    out.push({ kind: item.kind, phrase: item.phrase, at: Number.isFinite(at) ? new Date(at) : new Date() });
  }
  return out;
}

// Did the candidate talk over the question? Only the browser knows, so only the browser can report
// it — but note which direction the trust runs: claiming a question WAS interrupted can only make
// the interview longer (its probe goes back to pending and has to be asked again). There is no
// version of this a candidate benefits from lying about.
function sanitizeQuestionDelivery(d) {
  if (!d || typeof d !== "object") return undefined;
  if (d.deliveredFully !== false) return undefined; // only an interruption is worth recording
  return { deliveredFully: false, interruptedAtChar: clampNum(d.interruptedAtChar, 0, 100000) };
}

// Why the candidate's turn ended. Recorded as a CONDITION of the interview so "it cut me off"
// can be answered from the session rather than from memory — and, like repeatCount, structurally
// excluded from every score: how someone paces their speech tracks nerves, accent and connection
// quality far more closely than it tracks whether they can do the job.
const END_OF_TURN_STATES = ["complete", "ambiguous", "holding", "manual"];

function sanitizeEndOfTurn(e) {
  if (!e || typeof e !== "object") return undefined;
  const state = END_OF_TURN_STATES.includes(e.state) ? e.state : undefined;
  if (!state) return undefined;
  const reason = String(e.reason || "").trim().slice(0, 60);
  const out = { state };
  if (reason) out.reason = reason;
  return out;
}

// Did the transcription socket drop while this answer was being recorded? Only the browser can
// know, and the trust runs the same way as questionDelivery: reporting a drop can only ever mark
// this answer as LESS reliable evidence, so there is nothing to gain by inventing one. What a
// candidate cannot do is hide a drop — a hidden drop just leaves a short answer looking short,
// which is exactly the failure this field exists to make visible.
function sanitizeConnection(c) {
  if (!c || typeof c !== "object") return undefined;
  const drops = clampNum(c.drops, 0, 50);
  if (!drops) return undefined; // a clean recording records nothing, not a zero
  return { drops, gapMs: clampNum(c.gapMs, 0, 60 * 60 * 1000) || 0 };
}

// Candidate submits an answer (typed OR the transcript of a spoken answer, with optional voice
// metadata). Returns the next question or completion.
async function submitAnswer(req, res) {
  const session = req.interviewSession;
  const b = req.body || {};
  const opts = {
    inputMode: b.inputMode === "voice" ? "voice" : "text",
    transcriptConfidence: clampNum(b.transcriptConfidence, 0, 1),
    audioDurationMs: clampNum(b.audioDurationMs, 0, 60 * 60 * 1000),
    acoustic: sanitizeAcoustic(b.acoustic),
    backchannels: sanitizeBackchannels(b.backchannels, { firstName: session.aiInterview?.candidateFirstName }),
    // Client-reported and deliberately trusted: a repeat count feeds no score, so there is nothing
    // to gain by lying about it. Clamped only so a bad value can't land in the document.
    repeatCount: clampNum(b.repeatCount, 0, 20),
    questionDelivery: sanitizeQuestionDelivery(b.questionDelivery),
    // Why the turn ended (utils/endpointing.js). Trusted for the same reason as repeatCount: it
    // feeds no score, so there is nothing to gain by lying about it. Constrained to the known
    // states so a bad value can't land in the document.
    endOfTurn: sanitizeEndOfTurn(b.endOfTurn),
    // What they said between the last answer and this question. Trusted like the other
    // conditions of the interview — it feeds no score, so there is nothing to gain by lying — and
    // bounded so a client cannot use it to grow the document.
    spokeBetweenTurns: String(b.spokeBetweenTurns || '').trim().slice(0, 500) || undefined,
    // Whether this transcript has holes in it because the socket dropped mid-answer.
    connection: sanitizeConnection(b.connection),
  };
  const state = await aiInterview.submitAnswer(session, b.text, opts);

  // Diarization: the browser reports how many words in this answer belonged to a speaker other
  // than the dominant one; the SERVER decides whether that constitutes a second voice and owns the
  // resulting risk event. Best-effort — an integrity signal must never cost a candidate their
  // answer, so a failure here is logged and swallowed.
  try {
    const second = proctoring.detectSecondSpeaker(b.speakers);
    if (second) {
      const p = session.proctoring || {};
      p.counts = { ...(p.counts || {}) };
      p.counts.second_speaker = (p.counts.second_speaker || 0) + 1;
      p.events = [
        ...(p.events || []),
        {
          type: "second_speaker",
          severity: "high",
          meta: proctoring.sanitizeMeta("second_speaker", second),
          at: new Date(),
        },
      ].slice(-PROCTORING_EVENT_TAIL);
      p.totalEvents = (p.totalEvents || 0) + 1;
      p.lastEventAt = new Date();
      const { riskScore, riskBand } = proctoring.computeRisk(p.counts);
      p.riskScore = riskScore;
      p.riskBand = riskBand;
      session.proctoring = p;
      session.markModified("proctoring");
      await session.save();
    }
  } catch (err) {
    console.error("[interviewPortal] second-speaker ingest failed:", err.message);
  }

  // Phase 9.4 — meter voice STT spend per spoken answer (the only point where
  // the audio duration is known). Best-effort: metering never blocks an answer.
  if (opts.inputMode === "voice" && opts.audioDurationMs > 0) {
    const usageService = require("../services/usageService");
    await usageService.recordUsage({
      company: session.company,
      session: session._id,
      candidate: session.candidate,
      kind: "stt",
      provider: speech.provider(),
      model: speech.models().sttModel,
      usage: { costCents: speech.sttCostCents(opts.audioDurationMs) },
      latencyMs: opts.audioDurationMs,
      engine: "ai",
    });
  }
  res.json(state);
}

// The candidate said something ABOUT the interview rather than into it: they don't know this one,
// they want a moment, or they want to stop (utils/dialogueActs.js).
//
// A separate endpoint from submitAnswer on purpose. These are not answers, they must not be
// scored as answers, and routing them through the answer path is precisely how they were being
// mishandled before — a decline arrived as a weak answer and a request to stop arrived as
// nothing at all. Keeping them apart at the HTTP boundary is what makes "this was a decline, not
// a bad answer" a fact about the request rather than an inference from the text.
const DIALOGUE_ACTS = ["decline", "pause", "withdraw"];

async function submitDialogueAct(req, res) {
  const session = req.interviewSession;
  const b = req.body || {};
  const act = DIALOGUE_ACTS.includes(b.act) ? b.act : null;
  if (!act) {
    return res.status(400).json({ error: "Unknown conversational act", code: "UNKNOWN_ACT" });
  }

  const state = await aiInterview.submitDialogueAct(session, act, {
    // The service re-runs detection against this text, so it is the evidence for the act rather
    // than a label to be taken on trust. Length-capped here; the service caps it again.
    text: String(b.text || "").slice(0, 4000),
    confirmText: String(b.confirmText || "").slice(0, 4000),
    // "explicit" means the candidate pressed the End interview button. It skips the spoken
    // confirmation because a button press IS the confirmation — but only the button can claim it,
    // and the button is the one path where no transcript exists to re-check.
    confirmedBy: b.confirmedBy === "explicit" ? "explicit" : "spoken",
    inputMode: b.inputMode === "voice" ? "voice" : "text",
    transcriptConfidence: clampNum(b.transcriptConfidence, 0, 1),
    audioDurationMs: clampNum(b.audioDurationMs, 0, 60 * 60 * 1000),
    backchannels: sanitizeBackchannels(b.backchannels, { firstName: session.aiInterview?.candidateFirstName }),
  });
  res.json(state);
}

// Max bytes for one candidate answer's audio clip. Several minutes of opus-encoded speech fits
// comfortably under this; it exists to bound storage cost per turn, not to clip real answers.
const MAX_ANSWER_AUDIO_BYTES = 20 * 1024 * 1024; // 20MB

// WebM = EBML header (MediaRecorder's audio/webm output shares it with video); Ogg = "OggS"
// ASCII. The claimed MIME from the client is ignored — only the bytes decide.
const AUDIO_WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const AUDIO_OGG_MAGIC = Buffer.from("OggS", "ascii");
function detectAnswerAudioType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.subarray(0, 4).equals(AUDIO_WEBM_MAGIC)) return "audio/webm";
  if (buffer.subarray(0, 4).equals(AUDIO_OGG_MAGIC)) return "audio/ogg";
  return null;
}

// POST /interview-portal/interview/answer/:turnIndex/audio — best-effort upload of the
// candidate's own recorded answer audio, captured client-side from the same microphone stream
// already used for STT. speechService streams raw audio straight to the STT provider, so this
// upload is the only point our server ever sees the bytes at all.
//
// Gated on voice consent — the SAME consent that already covers "your voice is processed for
// this interview", whose copy now also discloses that the recording itself is kept (see the
// consent copy in user/src/pages/InterviewRoom.jsx). Purpose is reviewing how the AI interviewer
// and the speech pipeline actually performed, not building a surveillance archive: it plays back
// next to the transcript in the report, nowhere else, and is deleted with the candidate like
// every other stored artifact (candidatePurgeService).
//
// This is a deliberate reintroduction of what Phase 9.6 removed as a dead `audioPath` field —
// it is not that field coming back unused. Every write here is exercised, size-capped,
// magic-byte checked, and purged; nothing here is scored or feeds any evaluation path.
async function uploadAnswerAudio(req, res) {
  const session = req.interviewSession;
  if (!session.voiceConsent?.given) {
    return res.status(403).json({ error: "Voice consent was not given for this session", code: "VOICE_CONSENT_REQUIRED" });
  }
  const turnIndex = Number(req.params.turnIndex);
  const turn = Number.isInteger(turnIndex) ? session.aiInterview?.turns?.[turnIndex] : null;
  if (!turn || turn.role !== "candidate") {
    return res.status(404).json({ error: "No answer turn at that index" });
  }
  if (!req.file?.buffer) return res.status(400).json({ error: "audio file is required" });
  if (req.file.buffer.length > MAX_ANSWER_AUDIO_BYTES) {
    return res.status(413).json({ error: "Audio exceeds the size cap" });
  }
  const mimeType = detectAnswerAudioType(req.file.buffer);
  if (!mimeType) {
    return res.status(400).json({ error: "File content does not match a valid WebM or Ogg audio clip" });
  }

  const key = storageService.buildKey("interview-audio", {
    company: session.company,
    originalName: mimeType === "audio/webm" ? "answer.webm" : "answer.ogg",
    prefix: `t${turnIndex}`,
  });
  await storageService.putObject({ buffer: req.file.buffer, key, contentType: mimeType });

  // A retried upload overwrites rather than accumulates — one turn, one clip. The prior object
  // (if any) is abandoned rather than chased down: retries here are rare, and tracking
  // replacement deletes on a hot path isn't worth it for an orphaned object that small.
  turn.audioKey = key;
  turn.audioMimeType = mimeType;
  session.markModified("aiInterview.turns");
  await session.save();
  res.status(201).json({ ok: true });
}

// Candidate consents to (or declines) VOICE capture before the microphone ever
// opens (Phase 9.5) — mirrors the proctoring consent gate. Declining is fine:
// the typed-answer path is always available and never penalised.
async function voiceConsent(req, res) {
  const session = req.interviewSession;
  const given = !!req.body?.given;
  session.voiceConsent = { given, declined: !given, at: new Date() };
  await session.save();
  res.json({ voiceConsent: session.voiceConsent });
}

// Candidate consents to (or declines) proctoring before the interview. Recorded on the session so
// the recruiter can see it was obtained; declining is allowed and simply leaves vision off.
async function proctoringConsent(req, res) {
  const session = req.interviewSession;
  const given = !!req.body?.given;
  const p = session.proctoring || {};
  p.consent = { given, declined: !given, at: new Date() };
  if (typeof req.body?.visionEnabled === "boolean") p.visionEnabled = req.body.visionEnabled;

  // Phase 14.3 — the clip-capture clause is consented (or declined) explicitly,
  // and a decline is RECORDED, not merely inferred from absence. The accepted
  // wording version is stored with the decision.
  if (req.body?.evidence && typeof req.body.evidence.given === "boolean") {
    p.evidenceConsent = {
      given: req.body.evidence.given,
      declined: !req.body.evidence.given,
      at: new Date(),
      wordingVersion: String(req.body.evidence.wordingVersion || "2026-07-25.1").slice(0, 40),
    };
  }

  // Full-session recording is its own clause, recorded the same way clip capture is: an explicit
  // decline is written down, not inferred from absence, and the accepted wording version travels
  // with the decision so a later copy change never makes an old consent unreadable.
  if (req.body?.recording && typeof req.body.recording.given === "boolean") {
    p.recordingConsent = {
      given: req.body.recording.given,
      declined: !req.body.recording.given,
      at: new Date(),
      wordingVersion: String(req.body.recording.wordingVersion || "2026-08-31.1").slice(0, 40),
    };
  }

  // Screen-share self-attestation. Not detection — see the model comment — so an unchecked box is
  // simply recorded as not-attested rather than treated as a decline needing its own consent flow.
  if (typeof req.body?.noConcurrentShareAttestation === "boolean") {
    p.noConcurrentShareAttestation = { attested: req.body.noConcurrentShareAttestation, at: new Date() };
  }

  session.proctoring = p;
  session.markModified("proctoring");
  await session.save();
  res.json({
    consent: p.consent,
    evidenceConsent: p.evidenceConsent || null,
    recordingConsent: p.recordingConsent || null,
    noConcurrentShareAttestation: p.noConcurrentShareAttestation || null,
    visionEnabled: p.visionEnabled,
  });
}

// POST /interview-portal/recording/chunk — one timeslice of the candidate's own session
// recording, captured by MediaRecorder in their browser.
//
// Best-effort from the caller's side, the same posture as uploadAnswerAudio: a failed chunk never
// blocks or retries the interview, it just means that stretch is missing from the review copy.
// That trade is stated in the plan and is the accepted cost of moving capture off a vendor's
// server — worst case loses the last unflushed timeslice, not the interview.
//
// Every policy check lives in the service, not here, so the same rules apply no matter who calls:
// consent, magic bytes, per-chunk size, chunk count, total bytes, and duplicate sequence numbers.
async function uploadRecordingChunk(req, res) {
  const session = req.interviewSession;
  const settings = await CompanySettings.findOne({ company: session.company }).select("ai");
  if (!interviewRecordingService.enabled(settings)) {
    return res.status(404).json({ error: "Session recording is not enabled", code: "RECORDING_DISABLED" });
  }
  if (!req.file?.buffer) return res.status(400).json({ error: "chunk file is required" });

  const stored = await interviewRecordingService.storeChunk({
    session,
    buffer: req.file.buffer,
    seq: req.body?.seq,
    durationMs: req.body?.durationMs,
    // Only honoured for the first chunk, and clamped against the session's own start time —
    // see the service. A later chunk cannot move the capture clock.
    startedAt: req.body?.startedAt,
  });
  res.status(201).json({ ok: true, seq: stored.seq });
}

// POST /interview-portal/recording/finalize — capture has stopped; assemble what arrived.
//
// Idempotent, because it has three callers that can race exactly like meterSession's do: the
// interview's own completion, the tab-close beacon, and a candidate who reloads the page. The
// service's completed-check is the guard; a second call must not produce a second stitched object.
async function finalizeRecording(req, res) {
  const session = req.interviewSession;
  const settings = await CompanySettings.findOne({ company: session.company }).select("ai");
  if (!interviewRecordingService.enabled(settings)) {
    return res.status(404).json({ error: "Session recording is not enabled", code: "RECORDING_DISABLED" });
  }
  res.json(await interviewRecordingService.finalize({ session, durationMs: req.body?.durationMs }));
}

// Ingest a batch of integrity events streamed from the browser. The client sends only event TYPES
// (+ minimal meta); the server assigns severity, tallies per-type counts, and recomputes the risk
// score — never trusting a client-supplied severity or score. Optional `identityMatch` carries the
// in-browser face-match result; a mismatch is counted as an identity_mismatch event server-side.
// Shared tally: events stream in from the laptop AND (Phase 14.6) the phone
// companion; both land in the same per-type counts and the same risk model.
// `checkPhone` runs only on the laptop flush — it turns phone-heartbeat
// staleness into a phone_cam_lost event exactly once per outage.
async function ingestProctoringEvents(session, body, { checkPhone = false } = {}) {
  const incoming = Array.isArray(body?.events) ? body.events.slice(0, PROCTORING_MAX_PER_FLUSH) : [];

  const p = session.proctoring || {};
  if (typeof body?.visionEnabled === "boolean") p.visionEnabled = body.visionEnabled;
  const counts = { ...(p.counts || {}) };
  const accepted = [];

  for (const raw of incoming) {
    const type = String(raw?.type || "");
    if (!proctoring.isKnownType(type)) continue;
    // phone_cam_lost (heartbeat staleness) and second_speaker (diarization word counts on answer
    // submit) are both DERIVED server-side — a client can't inject either directly, or it could
    // manufacture a high-severity flag against itself or hide one by never sending it.
    if (type === "phone_cam_lost" || type === "second_speaker") continue;
    counts[type] = (counts[type] || 0) + 1;
    accepted.push({ type, severity: proctoring.severityOf(type), meta: proctoring.sanitizeMeta(type, raw?.meta), at: new Date() });
  }

  // Identity match is reported at most once; the server derives the risk hit (don't trust the
  // client to also send the penalty event).
  const im = body?.identityMatch;
  if (im && typeof im === "object" && typeof im.matched === "boolean") {
    const distance = Number.isFinite(Number(im.distance)) ? Math.round(Number(im.distance) * 1000) / 1000 : undefined;
    const prev = p.identityMatch?.status;
    p.identityMatch = { status: im.matched ? "match" : "mismatch", distance, checkedAt: new Date() };
    if (!im.matched && prev !== "mismatch") {
      counts.identity_mismatch = (counts.identity_mismatch || 0) + 1;
      accepted.push({ type: "identity_mismatch", severity: "high", meta: distance != null ? { distance } : undefined, at: new Date() });
    }
  }

  if (checkPhone) {
    const pc = p.phoneCam;
    const stale =
      pc?.paired &&
      pc.lastHeartbeatAt &&
      Date.now() - new Date(pc.lastHeartbeatAt).getTime() > PHONE_HEARTBEAT_TIMEOUT_MS;
    if (stale && !pc.lostFlagged) {
      counts.phone_cam_lost = (counts.phone_cam_lost || 0) + 1;
      accepted.push({ type: "phone_cam_lost", severity: proctoring.severityOf("phone_cam_lost"), at: new Date() });
      pc.lostFlagged = true;
    }
  }

  const { riskScore, riskBand } = proctoring.computeRisk(counts);
  p.counts = counts;
  p.totalEvents = (p.totalEvents || 0) + accepted.length;
  p.riskScore = riskScore;
  p.riskBand = riskBand;
  if (accepted.length) {
    p.lastEventAt = new Date();
    p.events = [...(p.events || []), ...accepted].slice(-PROCTORING_EVENT_TAIL);
  }
  session.proctoring = p;
  session.markModified("proctoring");
  await session.save();

  // Anti-cheating hard stop: a narrower, stronger signal set than the advisory risk score above —
  // see AUTO_SUBMIT_TRIGGER_TYPES in utils/proctoring.js for why this isn't just "high severity".
  // Opt-in via env, off by default, same convention as INTERVIEW_SPECULATIVE_QUESTION.
  let terminated = false;
  if (process.env.INTERVIEW_INTEGRITY_AUTOSUBMIT_ENABLED === "1" && session.aiInterview?.status === "in_progress") {
    const threshold = Number(process.env.INTERVIEW_INTEGRITY_AUTOSUBMIT_THRESHOLD) || 3;
    const triggerTypes = [...proctoring.AUTO_SUBMIT_TRIGGER_TYPES].filter((t) => counts[t] > 0);
    const triggerCount = triggerTypes.reduce((sum, t) => sum + counts[t], 0);
    if (triggerCount >= threshold) {
      await aiInterview.terminateForIntegrityViolation(session, { triggerCount, threshold, types: triggerTypes });
      terminated = true;
    }
  }

  return { riskScore, riskBand, accepted: accepted.length, terminated };
}

async function proctoringEvents(req, res) {
  const result = await ingestProctoringEvents(req.interviewSession, req.body, { checkPhone: true });
  res.json(result);
}

// Mint a short-lived streaming credential for the browser's real-time voice pipeline. The
// candidate's session must be live (requireCandidateAuth already enforced link validity).
async function voiceToken(req, res) {
  if (!speech.isEnabled()) {
    return res.status(503).json({ error: "Voice interview is not configured", code: "VOICE_DISABLED" });
  }
  // Hard server-side gate (Phase 9.5): no voice consent ⇒ no streaming
  // credential ⇒ the mic can never open. The UI collects consent; this enforces it.
  if (!req.interviewSession?.voiceConsent?.given) {
    return res.status(403).json({ error: "Voice consent has not been given for this interview", code: "VOICE_CONSENT_REQUIRED" });
  }
  // Bias the transcript toward this role's and this résumé's technical vocabulary, so the words
  // the evaluator later reads as evidence are the words the candidate actually said. Both calls
  // degrade to "unbiased but working" rather than failing the mic — see asrVocabularyService.
  const keyterms = await asrVocabulary.keytermsForSession(req.interviewSession);
  const cred = await speech.grantStreamingToken({ keyterms });
  await asrVocabulary.recordKeyterms(req.interviewSession, keyterms, cred.stt?.model);

  // Conversational policy rides along with the credential: the browser owns silence DETECTION
  // (only it knows in real time), but never the wording or the timings. Those stay server-side so
  // what the interviewer says, and how patient it is, is one place per tenant — and the persona
  // that decided the patience is stamped on the session as part of the interview's conditions.
  const persona = await personaService.resolveForSession(req.interviewSession);
  await personaService.stampOnSession(req.interviewSession, persona);
  cred.conversation = personaService.conversationPolicy(persona, {
    // Some approved acknowledgements carry the candidate's first name. Rendered here, from the
    // value stamped on the session when the interview began, so the browser receives finished
    // sentences and never does the substitution itself — a client that could compose the text it
    // speaks is a client that could speak something nobody approved.
    firstName: req.interviewSession.aiInterview?.candidateFirstName || "",
    // Phrasings this tenant's own candidates kept using, that the built-in trigger lists missed
    // and a recruiter has since approved. They become 0 ms deterministic matches from here on —
    // additive only, so a tenant can teach the interviewer new wording but can never configure
    // away a candidate's ability to ask for a repeat or to stop.
    approvedTriggers: await intentPhraseService.approvedTriggers(req.interviewSession.company),
  });
  cred.persona = { name: persona.name, source: persona.source };
  res.json(cred);
}

// "What did the candidate just mean?" — the semantic tier of the intent layer.
//
// The browser runs the deterministic matchers itself, because a live turn cannot wait on a network
// round-trip for the common phrasings (utils/conversationIntent.js). It calls this only for the
// tail those matchers do not read. Two things are deliberately NOT delegated to it:
//
//   1. The server re-runs the deterministic tier before consulting the model. A client that says
//      "nothing matched" is not taken at its word — same posture as the dialogue-act endpoint,
//      and it means the cheap, reproducible reading always wins when there is one.
//   2. The reply to a process question is composed HERE, from this session's real state, and
//      recorded as a turn before it can be spoken. The browser never gets to invent the numbers
//      in "there are three more to go".
//
// Never fails a turn: any error is reported as `answer_continues`, which is the interviewer's
// behaviour before this path existed.
async function voiceIntent(req, res) {
  const session = req.interviewSession;
  const ai = session.aiInterview || {};
  const utterance = String(req.body?.utterance || "").slice(0, 500);
  if (!utterance.trim()) {
    return res.json({ action: "answer_continues", tier: null, reason: "nothing_to_classify" });
  }

  // Context comes from the SERVER's record of the conversation, not from the client's claim about
  // it. The browser knows what it played, but the transcript is what the interview actually was —
  // and a client that could choose the context could choose the reading.
  const lastAiTurn = [...(ai.turns || [])].reverse().find((t) => t.role === "ai");
  // The currently open question turn — was it approved-baseline or a follow-up grown from the
  // candidate's last answer? A filter of `kind === "question"` alone missed follow-ups entirely,
  // so when the open question WAS a follow-up (the responder's own header comment: "most often
  // said to a follow-up question"), this fell through to an older baseline question or nothing,
  // and alreadyAnsweredResponder.respond below judged the wrong turn. aiInterview.openQuestionTurn
  // is the same "last real question" lookup publicState uses, so this and the realtime path read
  // the claim against the same fact.
  const lastQuestion = aiInterview.openQuestionTurn(ai);

  const settings = session.company
    ? await CompanySettings.findOne({ company: session.company }).lean()
    : null;

  const intent = await intentService.resolveIntent(utterance, {
    interviewerSaid: lastAiTurn?.text || "",
    questionAsked: lastQuestion?.text || "",
    // What they have already said in this turn, so a fragment is read in the context of the answer
    // it belongs to. Client-supplied because only the browser holds the in-progress turn — but it
    // is only ever CONTEXT for the reading, never something that can be stored or spoken.
    answerSoFar: String(req.body?.answerSoFar || "").slice(0, 2000),
    session,
    candidate: { _id: session.candidate },
    settings,
  });

  // On the record before anything acts on it, so a decision that turns out badly is inspectable.
  ai.intents = [
    ...(ai.intents || []),
    {
      utterance,
      action: intent.action,
      tier: intent.tier ?? 1,
      confidence: intent.confidence,
      reason: intent.reason,
      model: intent.model,
      promptVersion: intent.promptVersion,
      latencyMs: intent.latencyMs,
      degraded: Boolean(intent.degraded),
      turnIndex: (ai.turns || []).length,
    },
  ].slice(-INTENT_TAIL);

  // A Tier-1 reading is, by definition, a phrasing the deterministic matchers missed — they ran
  // first and said nothing. Counted so a recruiter can promote the recurring ones into instant
  // rules (services/intentPhraseService). Fire-and-forget: a live turn never waits on bookkeeping,
  // and a lost data point is not worth a second of somebody's interview.
  if (intent.tier === 1 && intent.action !== "answer_continues" && session.company) {
    void intentPhraseService.recordMiss({
      company: session.company,
      action: intent.action,
      utterance,
      confidence: intent.confidence,
    });
  }

  const payload = {
    action: intent.action,
    tier: intent.tier,
    confidence: intent.confidence,
    reason: intent.reason,
    residue: intent.residue || "",
    needsConfirmation: Boolean(intent.needsConfirmation),
    consumesTurn: Boolean(intent.consumesTurn),
  };

  // A process question is the one action whose reply cannot come from the phrase bank, because it
  // states facts about THIS interview. Composed from state, written into the transcript as a real
  // exchange, and only then returned — the write is what makes it speakable at all, since
  // speechAuthorization only permits the approved bank and this session's own authored turns.
  if (intent.action === "meta_question") {
    const answer = metaAnswers.answerFor(intent.metaTopic, metaAnswers.stateFromSession(session));
    ai.turns.push({ role: "candidate", kind: "meta_question", text: utterance });
    ai.turns.push({ role: "ai", kind: "meta_answer", text: answer.text });
    payload.speak = answer.text;
    payload.metaTopic = answer.topic;
    payload.answered = answer.answered;
  }

  // "I already answered that." Whether they are right is a fact about the transcript — was the
  // question in flight authored as a follow-up to their immediately preceding answer? — decided
  // here in code (alreadyAnsweredResponder), never from the candidate's claim or a model's reading
  // of it. Composed and written into the transcript before it is returned, same as meta_question.
  if (intent.action === "already_answered") {
    const currentQuestionTurn = lastQuestion;
    const answer = alreadyAnsweredResponder.respond(currentQuestionTurn);
    ai.turns.push({ role: "candidate", kind: "already_answered_claim", text: utterance });
    ai.turns.push({ role: "ai", kind: "already_answered_reply", text: answer.text });
    payload.speak = answer.text;
    payload.foundPriorAnswer = answer.found;
  }

  session.markModified("aiInterview");
  await session.save();
  res.json(payload);
}

// Text-to-speech proxy for spoken questions — the browser posts the question text and gets back
// MP3 audio. Server-side so the Deepgram key never reaches the client.
// ---------------------------------------------------------------------------
// Progressive playback (W8)
// ---------------------------------------------------------------------------
//
// A long question used to begin with a second or more of silence: the whole MP3 was synthesized
// on this server, buffered, transferred, and only then played. None of that wait bought anything.
//
// The fix has to keep the authorization boundary exactly where it was, and that is why this is
// TWO steps rather than one. A browser cannot put an Authorization header on an <audio> element,
// so the audio URL has to carry its own credential — and a URL that carried the portal JWT would
// put a session token into browser history and server logs. So:
//
//   1. POST /voice/speak/stream — authenticated, authorises the TEXT exactly as before, and
//      returns a single-purpose ticket bound to this session and that one sentence.
//   2. GET  /voice/speak/stream/:ticket — streams the audio for that ticket and nothing else.
//
// The ticket cannot name new text: it names text this server already checked and stored. So the
// question "what is this session allowed to say out loud?" is still answered in exactly one place
// (utils/speechAuthorization), and step 2 has no power to widen it.
//
// Tickets are reusable within their lifetime ON PURPOSE. A repeat has to replay the identical
// audio rather than re-synthesise — "could you say that again?" must not be able to hand this
// candidate a subtly different question from the one they were first asked — so the first stream
// caches its bytes and every later request for the same ticket serves them.
const speakTickets = new Map(); // ticket -> { sessionId, text, voice, audio, expiresAt }
const SPEAK_TICKET_TTL_MS = 15 * 60 * 1000;
const SPEAK_TICKET_MAX = 500;

function sweepSpeakTickets() {
  const now = Date.now();
  for (const [k, v] of speakTickets) if (v.expiresAt <= now) speakTickets.delete(k);
  // Hard cap as a backstop against a client that requests thousands: oldest first.
  while (speakTickets.size > SPEAK_TICKET_MAX) speakTickets.delete(speakTickets.keys().next().value);
}

// Shared by both speak endpoints: check the text, record a divergence, convert to spoken form.
// Returns { spoken } or throws a { status } error the caller surfaces.
async function authorizeSpeech(session, text) {
  const verdict = speechAuth.authorize(text, session);
  if (!verdict.authorized) {
    const enforced = speechAuth.isEnforcing();
    session.aiInterview.speechDivergences = [
      ...(session.aiInterview.speechDivergences || []),
      { spoken: verdict.spoken, enforced, at: new Date() },
    ].slice(-speechAuth.DIVERGENCE_TAIL);
    session.markModified("aiInterview.speechDivergences");
    await session.save();
    console.error(
      `[voice] refusing to speak text that is neither an authored turn nor an approved phrase ` +
        `(session ${session._id}, enforced=${enforced}): ${JSON.stringify(verdict.spoken.slice(0, 120))}`
    );
    if (enforced) {
      throw Object.assign(new Error("That text was not part of this interview and will not be spoken"), {
        status: 422,
        code: "SPEECH_NOT_AUTHORED",
      });
    }
  }
  // Written form -> spoken form, AFTER authorization and never before it.
  return pronounce(speakable.toSpeakable(verdict.spoken), session);
}

// The candidate's own pronunciation of their own name, applied to the spoken form.
//
// Runs alongside speakable.toSpeakable and under exactly the same rule: it is a RENDERING step
// between the approved text and the sound waves, never a step that decides what may be said. It is
// therefore deliberately after authorization — a respelling can never be used to smuggle through a
// sentence the engine did not author. The authored name stays the record; this is only how it is
// said out loud, exactly as "K8s" is said "Kubernetes". No respelling on file ⇒ unchanged.
function pronounce(spoken, session) {
  const ai = session?.aiInterview || {};
  const applied = namePronunciation.applyTo(
    spoken.text,
    ai.candidateFirstName,
    ai.namePronunciation?.respelling
  );
  if (!applied.applied) return spoken;
  return { ...spoken, text: applied.text, changes: [...(spoken.changes || []), "name_pronunciation"] };
}

// Step 1: authorise the sentence and hand back a ticket for it.
async function voiceSpeakPrepare(req, res) {
  if (!speech.isEnabled()) {
    return res.status(503).json({ error: "Voice interview is not configured", code: "VOICE_DISABLED" });
  }
  const session = req.interviewSession;
  let spoken;
  try {
    spoken = await authorizeSpeech(session, req.body?.text);
  } catch (err) {
    if (err.status === 422) return res.status(422).json({ error: err.message, code: err.code });
    throw err;
  }

  const persona = await personaService.resolveForSession(session);
  sweepSpeakTickets();
  const ticket = crypto.randomBytes(24).toString("hex");
  speakTickets.set(ticket, {
    sessionId: String(session._id),
    text: spoken.text,
    voice: persona.voice.model,
    audio: null,
    expiresAt: Date.now() + SPEAK_TICKET_TTL_MS,
  });

  res.json({
    ticket,
    // How long this will take to say, for the browser to use until the audio element knows its
    // own duration — a streamed response has no Content-Length, so `audio.duration` reads
    // Infinity for the first moments, and the echo gate needs some idea of playback position or
    // it explains away more and lets fewer real interruptions through.
    estimatedMs: speech.estimateSpeechMs(spoken.text),
  });
}

// Step 2: stream the audio for a ticket. Can only ever produce text step 1 already approved.
//
// THE TICKET IS THE CREDENTIAL, and this route carries no other authentication. That is a
// deliberate choice, not an omission: an <audio> element cannot send an Authorization header, and
// the alternative — putting the portal JWT in the URL — would write a live session token into
// browser history, referrer headers and every access log it passes through. A capability URL is
// the smaller exposure by a wide margin.
//
// What the capability actually grants is one sentence of synthesised speech that this server
// wrote and already approved. It is 24 random bytes, it expires in fifteen minutes, and it
// carries no candidate data, no session access and no ability to name new text.
async function voiceSpeakStream(req, res) {
  const entry = speakTickets.get(String(req.params.ticket || ""));
  if (!entry || entry.expiresAt <= Date.now()) {
    return res.status(404).json({ error: "That audio is no longer available" });
  }

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");

  // A repeat: serve the identical bytes rather than re-synthesising, so a re-asked question
  // cannot drift from the one first asked.
  if (entry.audio) {
    res.setHeader("Content-Length", entry.audio.length);
    return res.send(entry.audio);
  }

  const { audio, model } = await speech.synthesizeTo(res, entry.text, { voice: entry.voice });
  entry.audio = audio;
  res.end();

  // Metered after the fact so nothing about billing can delay a spoken question. Best-effort, and
  // the session is re-read here because this route has no authenticated request behind it — the
  // ticket recorded which session it belongs to precisely so spend stays attributable.
  try {
    const usageService = require("../services/usageService");
    const owner = await InterviewSession.findById(entry.sessionId).select("company candidate").lean();
    if (owner) {
      await usageService.recordUsage({
        company: owner.company,
        session: owner._id,
        candidate: owner.candidate,
        kind: "tts",
        provider: speech.provider(),
        model,
        usage: { costCents: speech.ttsCostCents(entry.text.length) },
        engine: "ai",
      });
    }
  } catch (err) {
    console.error("[voice] TTS metering failed:", err.message);
  }
}

// The original, buffered endpoint. Still used for the SHORT phrases — backchannels, preambles,
// meta answers — which are pre-synthesised once and cached for the whole session, so streaming
// them would add a round trip and save nothing.
async function voiceSpeak(req, res) {
  if (!speech.isEnabled()) {
    return res.status(503).json({ error: "Voice interview is not configured", code: "VOICE_DISABLED" });
  }
  const session = req.interviewSession;

  // The one place the interviewer's voice can come from, and therefore the one place to verify
  // that what it says was authored by the rubric-bound engine or drawn from the approved
  // non-evaluative bank. Anything else is recorded verbatim and refused — see
  // utils/speechAuthorization.js for why this narrow check is the whole audit story.
  const verdict = speechAuth.authorize(req.body?.text, session);
  if (!verdict.authorized) {
    const enforced = speechAuth.isEnforcing();
    session.aiInterview.speechDivergences = [
      ...(session.aiInterview.speechDivergences || []),
      { spoken: verdict.spoken, enforced, at: new Date() },
    ].slice(-speechAuth.DIVERGENCE_TAIL);
    session.markModified("aiInterview.speechDivergences");
    await session.save();
    console.error(
      `[voice] refusing to speak text that is neither an authored turn nor an approved phrase ` +
        `(session ${session._id}, enforced=${enforced}): ${JSON.stringify(verdict.spoken.slice(0, 120))}`
    );
    if (enforced) {
      // Not adverse to the candidate: the question is already on their screen, and typing answers
      // is always available. The client shows it as text rather than speaking something unverified.
      return res.status(422).json({
        error: "That text was not part of this interview and will not be spoken",
        code: "SPEECH_NOT_AUTHORED",
      });
    }
  }

  // Written form -> spoken form, AFTER authorization and never before it: the authored text is
  // what gets checked and what stays on the record, and this is only how it is pronounced. A
  // question reading "5+ years of CI/CD" is clear in print and unintelligible aloud, which is
  // what candidates report as an unclear voice. See utils/speakable.js.
  const spoken = pronounce(speakable.toSpeakable(verdict.spoken), session);

  // Speak in the session's persona voice, not the deployment default (services/personaService).
  const persona = await personaService.resolveForSession(session);
  const { audio, contentType, model } = await speech.synthesize(spoken.text, { voice: persona.voice.model });

  // Phase 9.4 — meter TTS spend (characters synthesized). Best-effort. `model` is the voice that
  // actually spoke, which may be the persona's or the configured fallback — record what happened,
  // not what was requested. Characters are counted on what was SENT to the provider, since that
  // is what the provider bills for.
  const chars = spoken.text.length;
  const usageService = require("../services/usageService");
  await usageService.recordUsage({
    company: session.company,
    session: session._id,
    candidate: session.candidate,
    kind: "tts",
    provider: speech.provider(),
    model,
    usage: { costCents: speech.ttsCostCents(chars) },
    engine: "ai",
  });

  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", audio.length);
  res.setHeader("Cache-Control", "no-store");
  res.send(audio);
}

// ---------------------------------------------------------------------------
// Phase 14 — event-anchored evidence clips + phone companion camera
// ---------------------------------------------------------------------------

// Shared by the laptop route and the phone route (source differs). The service
// owns every policy check: consent, qualifying event, magic bytes, size, and
// the SERVER-side per-session cap.
async function uploadEvidenceClip(req, res) {
  const session = req.interviewSession;
  const settings = await CompanySettings.findOne({ company: session.company }).select("proctoring");
  if (!evidenceClipService.clipsEnabled(settings)) {
    return res.status(403).json({ error: "Evidence clips are not enabled for this interview", code: "EVIDENCE_DISABLED" });
  }
  if (!req.file?.buffer) return res.status(400).json({ error: "clip file is required" });

  try {
    const row = await evidenceClipService.storeClip({
      session,
      eventType: req.body?.eventType,
      source: req.evidenceSource === "phone" ? "phone" : "laptop",
      buffer: req.file.buffer,
      durationMs: req.body?.durationMs,
      // The measurement that triggered the capture (multipart field, so it arrives as a JSON
      // string). Allow-listed and clamped in the service — never trusted as sent.
      trigger: req.body?.trigger,
    });
    res.status(201).json({ id: row._id, eventType: row.eventType, capturedAt: row.capturedAt });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }
}

function phoneEvidenceClip(req, res) {
  req.evidenceSource = "phone";
  return uploadEvidenceClip(req, res);
}

// GET /interview-portal/phone/pair — laptop asks for a QR payload. The token is
// aud-scoped ("phone-pair"), single-purpose, 10-minute TTL, and useless against
// any portal endpoint (requireCandidateAuth rejects audience-bearing tokens).
async function phonePair(req, res) {
  const session = req.interviewSession;
  const settings = await CompanySettings.findOne({ company: session.company }).select("proctoring");
  if (!evidenceClipService.secondaryCamEnabled(settings)) {
    return res.status(403).json({ error: "Secondary camera is not enabled for this interview", code: "SECONDARY_CAM_DISABLED" });
  }

  const candidateId = session.candidate._id ? String(session.candidate._id) : String(session.candidate);
  const token = jwt.sign(
    { candidateId, sessionId: String(session._id) },
    process.env.JWT_SECRET,
    { audience: "phone-pair", expiresIn: PHONE_PAIR_TOKEN_TTL }
  );
  // candidateLinkBase: the address actually meant to be scanned/shared —
  // PUBLIC_CANDIDATE_URL when set, else the first CLIENT_ORIGIN_USER origin.
  res.json({ token, url: `${candidateLinkBase()}/phone-cam/${token}` });
}

// POST /interview-portal/phone/login — the phone exchanges the scanned pairing
// token for a phone-session token (aud "phone-cam") that lives as long as the
// interview session. Mirrors the magic-link → session pattern.
async function phoneLogin(req, res) {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "token is required" });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { audience: "phone-pair" });
  } catch (err) {
    return res.status(401).json({ error: "Pairing code expired or invalid — generate a new QR on the laptop" });
  }

  const session = await InterviewSession.findById(payload.sessionId);
  if (!session || String(session.candidate) !== payload.candidateId) {
    return res.status(404).json({ error: "Interview session not found" });
  }
  if (session.status === "cancelled" || new Date() > session.expiresAt) {
    return res.status(410).json({ error: "This interview is no longer active" });
  }

  const expiresInSeconds = Math.max(60, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
  const phoneToken = jwt.sign(
    { candidateId: payload.candidateId, sessionId: String(session._id), epoch: session.sessionEpoch || 0 },
    process.env.JWT_SECRET,
    { audience: "phone-cam", expiresIn: expiresInSeconds }
  );

  const p = session.proctoring || {};
  p.phoneCam = { ...(p.phoneCam || {}), paired: true, pairedAt: new Date(), lastHeartbeatAt: new Date(), lostFlagged: false };
  session.proctoring = p;
  session.markModified("proctoring");
  await session.save();

  res.json({ token: phoneToken, expiresAt: session.expiresAt });
}

// POST /interview-portal/phone/heartbeat — presence signal, nothing more. A
// resumed heartbeat after an outage re-arms the loss detector.
async function phoneHeartbeat(req, res) {
  const session = req.interviewSession;
  const p = session.proctoring || {};
  p.phoneCam = { ...(p.phoneCam || {}), paired: true, lastHeartbeatAt: new Date(), lostFlagged: false };
  session.proctoring = p;
  session.markModified("proctoring");
  await session.save();
  res.json({ ok: true });
}

// POST /interview-portal/phone/events — phone-side vision events (multi_face
// etc.) land in the same counts and risk model as laptop events.
async function phoneEvents(req, res) {
  const result = await ingestProctoringEvents(req.interviewSession, req.body, { checkPhone: false });
  res.json(result);
}

module.exports = {
  login,
  // Exported for the candidate dashboard's "open my own interview" route, which
  // proves ownership by account instead of by emailed token but must pass the
  // identical gate. See openSessionForOwner.
  openSessionForOwner,
  me,
  speedTestFile,
  submitChecks,
  uploadIdentityPhoto,
  startInterview,
  getInterviewState,
  submitAnswer,
  uploadAnswerAudio,
  submitDialogueAct,
  proctoringConsent,
  proctoringEvents,
  voiceConsent,
  voiceToken,
  voiceSpeak,
  voiceSpeakPrepare,
  voiceSpeakStream,
  voiceIntent,
  uploadEvidenceClip,
  uploadRecordingChunk,
  finalizeRecording,
  phoneEvidenceClip,
  phonePair,
  phoneLogin,
  phoneHeartbeat,
  phoneEvents,
};
