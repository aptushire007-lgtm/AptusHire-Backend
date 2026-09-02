const express = require("express");
const multer = require("multer");
const wrapRouter = require("../middleware/wrapRouter");
const {
  login,
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
} = require("../controllers/interviewPortalController");
const { requireCandidateAuth, requirePhoneAuth } = require("../middleware/candidateAuth");
const identityPhotoUpload = require("../middleware/identityPhotoUpload");
const { createLimiter, portalKey } = require("../middleware/rateLimit");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

// Evidence clips (Phase 14.2): multipart, in-memory, hard 6MB cap — the service
// re-checks size, magic bytes, consent, and the per-session count server-side.
const evidenceClipUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });
// Answer audio: a whole spoken answer, not a short clip, so the cap is looser — the controller
// re-checks size and magic bytes server-side regardless of what multer already bounded.
const answerAudioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
// Session recording: one MediaRecorder timeslice, not a whole interview — the file arrives in
// ~45s pieces precisely so no single request (and no single in-memory buffer, here or in the
// browser) is ever the size of the interview. The service re-checks size, magic bytes, consent,
// sequence and the per-session totals regardless of what multer already bounded.
const recordingChunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Each answer = one LLM call; the speed-test ships a 2 MB payload. Bound both per
// candidate so a valid token can't be used to amplify cost.
const answerLimiter = createLimiter({ windowMs: 60 * 1000, max: 20, prefix: "rl:answer:", keyGenerator: portalKey, message: "You're answering too quickly — please wait a moment." });
const speedTestLimiter = createLimiter({ windowMs: 60 * 1000, max: 10, prefix: "rl:speedtest:", keyGenerator: portalKey });
const loginLimiter = createLimiter({ windowMs: 60 * 1000, max: 20, prefix: "rl:portal-login:" });
// Streaming tokens are short-lived (~60s) and re-minted per answer/reconnect; allow enough for
// a multi-question interview + reconnects, but cap to prevent a valid session amplifying cost.
const voiceTokenLimiter = createLimiter({ windowMs: 60 * 1000, max: 40, prefix: "rl:voice-token:", keyGenerator: portalKey });
const voiceSpeakLimiter = createLimiter({ windowMs: 60 * 1000, max: 60, prefix: "rl:voice-speak:", keyGenerator: portalKey });
// Proctoring events are flushed in batches (~every few seconds); allow a generous rate for a
// long interview + reconnects, but still cap so a token can't be used to hammer the endpoint.
const proctoringLimiter = createLimiter({ windowMs: 60 * 1000, max: 60, prefix: "rl:proctoring:", keyGenerator: portalKey });

router.post("/login", loginLimiter, asyncHandler(login));
router.get("/me", requireCandidateAuth, asyncHandler(me));
router.get("/speed-test-file", requireCandidateAuth, speedTestLimiter, asyncHandler(speedTestFile));
router.post("/checks", requireCandidateAuth, asyncHandler(submitChecks));
router.post("/identity-verification", requireCandidateAuth, identityPhotoUpload.single("photo"), asyncHandler(uploadIdentityPhoto));
router.post("/start", requireCandidateAuth, asyncHandler(startInterview));
router.get("/interview", requireCandidateAuth, asyncHandler(getInterviewState));
router.post("/interview/answer", requireCandidateAuth, answerLimiter, asyncHandler(submitAnswer));
// The candidate's recorded answer audio, uploaded AFTER the answer itself so the turn it belongs
// to already exists. Best-effort from the caller's side — a failed upload never blocks or retries
// the interview flow, it just means that turn has no audio in the report. Shares the answer
// limiter: one upload per answer, same cadence as submitAnswer itself.
router.post(
  "/interview/answer/:turnIndex/audio",
  requireCandidateAuth,
  answerLimiter,
  answerAudioUpload.single("audio"),
  asyncHandler(uploadAnswerAudio)
);
// Conversational acts (decline / pause / withdraw). A decline advances the interview, so it costs
// the same LLM call an answer does and shares the answer limiter's budget. Deliberately NOT a
// looser limit: this is the one endpoint that can end an interview.
router.post("/interview/act", requireCandidateAuth, answerLimiter, asyncHandler(submitDialogueAct));
router.post("/proctoring/consent", requireCandidateAuth, proctoringLimiter, asyncHandler(proctoringConsent));
router.post("/proctoring/events", requireCandidateAuth, proctoringLimiter, asyncHandler(proctoringEvents));

// Phase 14 — event-anchored evidence clips + phone companion camera. Clip
// uploads are tightly rate-limited on top of the server-side per-session cap;
// heartbeats are cheap but still bounded.
const evidenceLimiter = createLimiter({ windowMs: 60 * 1000, max: 6, prefix: "rl:evidence:", keyGenerator: portalKey });
const heartbeatLimiter = createLimiter({ windowMs: 60 * 1000, max: 20, prefix: "rl:phone-hb:", keyGenerator: portalKey });
router.post("/proctoring/evidence", requireCandidateAuth, evidenceLimiter, evidenceClipUpload.single("clip"), asyncHandler(uploadEvidenceClip));

// Full-session recording, captured in the browser and uploaded a timeslice at a time
// (docs/INTERVIEW-RECORDING-MEDIARECORDER-PLAN.md). Its own limiter, sized to the CADENCE rather
// than borrowed from another endpoint: chunks arrive on a fixed ~45s timer regardless of how the
// candidate is answering, so 6/min is ~4× headroom for retries and reconnects while still bounding
// what one valid token can push into the bucket. Finalize shares it — it fires once per session
// (three racing callers at most), and the service no-ops every call after the first.
const recordingLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 6,
  prefix: "rl:recording:",
  keyGenerator: portalKey,
});
router.post(
  "/recording/chunk",
  requireCandidateAuth,
  recordingLimiter,
  recordingChunkUpload.single("chunk"),
  asyncHandler(uploadRecordingChunk)
);
router.post("/recording/finalize", requireCandidateAuth, recordingLimiter, asyncHandler(finalizeRecording));

router.get("/phone/pair", requireCandidateAuth, proctoringLimiter, asyncHandler(phonePair));
router.post("/phone/login", loginLimiter, asyncHandler(phoneLogin));
router.post("/phone/heartbeat", requirePhoneAuth, heartbeatLimiter, asyncHandler(phoneHeartbeat));
router.post("/phone/events", requirePhoneAuth, proctoringLimiter, asyncHandler(phoneEvents));
router.post("/phone/evidence", requirePhoneAuth, evidenceLimiter, evidenceClipUpload.single("clip"), asyncHandler(phoneEvidenceClip));
router.post("/voice/consent", requireCandidateAuth, voiceTokenLimiter, asyncHandler(voiceConsent));
router.get("/voice/token", requireCandidateAuth, voiceTokenLimiter, asyncHandler(voiceToken));
router.post("/voice/speak", requireCandidateAuth, voiceSpeakLimiter, asyncHandler(voiceSpeak));
// Progressive playback for QUESTIONS: step 1 authorises the sentence, step 2 streams it so the
// voice starts on the opening words instead of after the whole file. See the controller for why
// this is two steps and not one.
router.post("/voice/speak/stream", requireCandidateAuth, voiceSpeakLimiter, asyncHandler(voiceSpeakPrepare));
// No requireCandidateAuth: the ticket IS the credential. An <audio> element cannot send an
// Authorization header, and putting the portal JWT in the URL would write a live session token
// into browser history and every access log. The ticket is 24 random bytes, expires in fifteen
// minutes, and grants exactly one sentence of speech this server already approved.
router.get("/voice/speak/stream/:ticket", asyncHandler(voiceSpeakStream));
// The semantic intent tier. Its own, much higher limit: this fires on utterances rather than on
// turns, so a talkative candidate legitimately hits it far more often than they hit /speak — but
// it is a metered model call, so it is still bounded rather than open.
const voiceIntentLimiter = createLimiter({ windowMs: 60 * 1000, max: 120, prefix: "rl:voice-intent:", keyGenerator: portalKey });
router.post("/voice/intent", requireCandidateAuth, voiceIntentLimiter, asyncHandler(voiceIntent));

module.exports = wrapRouter(router);
