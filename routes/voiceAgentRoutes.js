const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { realtimeFunction, realtimeTranscript } = require("../controllers/voiceAgentController");
const { requireCandidateAuth } = require("../middleware/candidateAuth");
const { createLimiter, portalKey } = require("../middleware/rateLimit");
const asyncHandler = require("../middleware/asyncHandler");

// The realtime ENGINE endpoints, called by the LiveKit agent worker on the candidate's portal
// JWT. The path stays /api/interview-portal/realtime/* — it predates the LiveKit pipeline (the
// retired Deepgram Voice Agent transport used the same contract) and the deployed worker's
// backend_client.py posts here; renaming it would be a breaking change with nothing bought.
// Session minting, availability, and metering close-out live in livekitRoutes, not here.

const router = express.Router();

// One call per question in the normal case, plus retries. Generous enough that a chatty agent
// re-checking the current question never stalls a live interview, bounded enough that a runaway
// function-calling loop cannot bill the tenant indefinitely.
const functionLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 60,
  prefix: "rl:rt-fn:",
  keyGenerator: portalKey,
});

// Transcript flushes. This endpoint is the guardrail's only input, so its rate limit is also the
// rate at which off-script speech can be caught — the worker flushes per spoken turn, and the
// ceiling has to comfortably exceed a chatty interviewer's turn rate. Being throttled here
// would mean an unapproved question going unchecked, which is the opposite of what a limit is for.
const transcriptLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 120,
  prefix: "rl:rt-tx:",
  keyGenerator: portalKey,
});

router.post("/function", requireCandidateAuth, functionLimiter, asyncHandler(realtimeFunction));
router.post("/transcript", requireCandidateAuth, transcriptLimiter, asyncHandler(realtimeTranscript));

module.exports = wrapRouter(router);
