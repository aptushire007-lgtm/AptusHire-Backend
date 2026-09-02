const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  livekitAvailable,
  livekitSession,
  livekitBrief,
  livekitEnd,
  livekitPresence,
} = require("../controllers/livekitController");
const { requireCandidateAuth } = require("../middleware/candidateAuth");
const { createLimiter, portalKey } = require("../middleware/rateLimit");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

// Session mint = a room credential + an agent dispatch (billable once the candidate joins).
// Materially LESS sensitive than the Deepgram path's equivalent — no model key rides in the
// response — but the same ceiling applies: one session per interview plus reconnects, not a
// credential vending machine.
const sessionLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 6,
  prefix: "rl:lk-session:",
  keyGenerator: portalKey,
  message: "Too many connection attempts — please wait a moment.",
});

// The probe is read-only and side-effect-free; the room asks once before it opens anything.
const probeLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 60,
  prefix: "rl:lk-probe:",
  keyGenerator: portalKey,
});

router.get("/available", requireCandidateAuth, probeLimiter, asyncHandler(livekitAvailable));
// The worker fetches this once per interview, right after dispatch, using the portal JWT from its
// dispatch metadata. Read-only; the browser has no reason to call it.
router.get("/brief", requireCandidateAuth, probeLimiter, asyncHandler(livekitBrief));
router.post("/session", requireCandidateAuth, sessionLimiter, asyncHandler(livekitSession));
// Close out the billing window. Idempotent, reachable via sendBeacon on tab close, and backstopped
// by the room_finished webhook (registered raw in server.js, not here) — so the limit only needs
// to allow for retries.
router.post("/end", requireCandidateAuth, sessionLimiter, asyncHandler(livekitEnd));
// Presence transitions from the worker. On the probe limiter rather than the session one: a phone
// on a bad connection can legitimately produce a run of these, and rate-limiting the audit trail
// would mean losing exactly the records of the worst connections.
router.post("/presence", requireCandidateAuth, probeLimiter, asyncHandler(livekitPresence));

// NOTE deliberately absent: /function and /transcript. The worker calls the EXISTING
// /api/interview-portal/realtime/* endpoints — engine contract, guardrail, and evidence handling
// stay single-sourced in voiceAgentRoutes/voiceAgentController.

module.exports = wrapRouter(router);
