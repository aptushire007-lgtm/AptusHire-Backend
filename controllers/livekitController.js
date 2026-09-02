// HTTP surface for the LiveKit realtime pipeline — services/livekitService.js.
//
// Same separation rule as voiceAgentController: behind a flag, defaults off, reviewable and
// removable as one unit. The worker's function calls and transcript flushes do NOT land here —
// they reuse /api/interview-portal/realtime/function and /transcript, so the engine contract,
// guardrail, and evidence handling stay single-sourced in voiceAgentController.
//
// What this controller owns: the availability probe, the session mint (consent + budget +
// concurrency gates, room token, agent dispatch), the client-side metering close, and the
// room_finished webhook that makes metering server-truth.

const CompanySettings = require("../models/CompanySettings");
const Candidate = require("../models/Candidate");
const livekit = require("../services/livekitService");
const interviewRecording = require("../services/interviewRecordingService");
const voiceAgent = require("../services/voiceAgentService");
const aiInterview = require("../services/aiInterviewService");
const usageService = require("../services/usageService");
const personaService = require("../services/personaService");
const quotaService = require("../services/quotaService");

// Read-only, consent-free, mints nothing — the probe-mints-session bug class stays fixed.
async function livekitAvailable(req, res) {
  const settings = await CompanySettings.findOne({ company: req.interviewSession.company }).select("ai compliance");
  res.json({ enabled: livekit.isEnabled(settings) });
}

// Mint the room credential and summon the worker. The browser receives {url, token, room} and
// NOTHING else — no Settings block, no model keys, no prompt. That absence is the point of the
// whole migration (LIVEKIT-REALTIME-PLAN.md §0).
async function livekitSession(req, res) {
  const session = req.interviewSession;
  const settings = await CompanySettings.findOne({ company: session.company }).select("ai compliance");

  if (!livekit.isEnabled(settings)) {
    // 404 is what the client reads as "not enabled" — it falls back to the next pipeline down.
    return res.status(404).json({ error: "LiveKit realtime interview is not enabled", code: "LIVEKIT_DISABLED" });
  }
  // Same hard gates as the turn-based path: consent and budget are pipeline-independent facts
  // about the candidate and the tenant, not transport details.
  if (!session.voiceConsent?.given) {
    return res.status(403).json({ error: "Voice consent has not been given for this interview", code: "VOICE_CONSENT_REQUIRED" });
  }

  const candidate = await Candidate.findById(session.candidate).populate("job");
  if (!candidate) return res.status(404).json({ error: "Candidate not found for this interview" });

  if (!aiInterview.consentOk(candidate, settings)) {
    return res.status(403).json({
      error: "AI processing consent has not been given for this interview",
      code: "AI_CONSENT_REQUIRED",
    });
  }
  try {
    if (await usageService.isOverBudget(session.company, settings?.ai)) {
      console.warn(`[livekit] company ${session.company} over LLM budget — refusing a realtime session`);
      return res.status(402).json({ error: "This workspace is over its AI budget", code: "OVER_BUDGET" });
    }
  } catch (err) {
    console.error("[livekit] budget check failed, proceeding:", err.message);
  }

  // ---- Per-tenant concurrency cap (multi-tenant fairness) -----------------
  //
  // Plan tiers may define maxConcurrentRealtime; tenants whose plan doesn't get the deployment
  // default. A refusal here is a SCHEDULING message, never an adverse outcome — and a re-mint for
  // this same session (reconnect) is exempt, because kicking a live interview off its own slot
  // for being popular would be the bug this cap exists to prevent.
  const reconnecting =
    session.aiInterview?.realtimeStartedAt && !session.aiInterview?.realtimeMeteredAt;
  if (!reconnecting) {
    let cap = Number(process.env.LIVEKIT_MAX_CONCURRENT_SESSIONS || 2);
    try {
      const q = await quotaService.check(session.company, "concurrentRealtime");
      if (Number.isFinite(q.limit)) cap = q.limit;
    } catch (err) {
      console.error("[livekit] concurrency quota check failed, using default cap:", err.message);
    }
    const active = await livekit.activeSessionCount(session.company);
    if (active >= cap) {
      return res.status(429).json({
        error: "All live interview slots are busy right now — please try again in a few minutes.",
        code: "REALTIME_BUSY",
        retryAfterSeconds: 300,
      });
    }
  }

  const persona = await personaService.resolveForSession(session);
  await personaService.stampOnSession(session, persona);

  // The worker's credential for the /realtime/* engine endpoints is the candidate's OWN portal
  // JWT — never anything broader. It rides in dispatch metadata (worker-only, not visible to
  // room participants).
  const portalToken = String(req.headers.authorization || "").split(" ")[1] || "";

  const token = await livekit.mintCandidateToken(session);
  try {
    await livekit.dispatchAgent(session, portalToken);
  } catch (err) {
    // No agent ⇒ no interview. Refuse BEFORE stamping the billing clock; the client falls back
    // to the next pipeline instead of joining an empty room.
    console.error(`[livekit] agent dispatch failed for session ${session._id}: ${err.message}`);
    return res.status(503).json({ error: "The interviewer could not be started", code: "AGENT_DISPATCH_FAILED" });
  }

  if (!reconnecting) {
    // A fresh mint opens a fresh billing window: clear the previous close-out marker so a
    // candidate who re-enters after a fully-metered earlier segment is metered again for the new
    // one (two UsageEvents, both windows billed) instead of the second segment riding free.
    session.aiInterview.realtimeStartedAt = new Date();
    session.aiInterview.realtimeMeteredAt = null;
  }
  // Which interviewer instructions this session actually ran under. Stamped on EVERY mint, not
  // only the first: a reconnect that lands after a deploy runs the new prompt, and recording the
  // old version would make the session's own audit record wrong in the one case it matters.
  session.aiInterview.agentPromptVersion = voiceAgent.AGENT_PROMPT_VERSION;

  // Video (Phase 7, default-off): only on a fresh mint, never a reconnect — Egress was already
  // started for this room the first time, and starting a second one against the same room would
  // just fail (or double-record) rather than resume anything. `videoOn` also tells the browser
  // whether to publish its camera track at all; when the flag is off this is a no-op exactly as
  // it was before this feature existed.
  const videoOn = !reconnecting && livekit.videoEnabled(settings);
  // Egress runs ONLY when the browser is not already recording. Both paths write the same
  // `recordingStatus`/`recordingKey` fields, so with both on the second one to finish would
  // overwrite the first and the tenant would be billed Egress output-minutes for a file nobody
  // plays. Client capture wins because it is the one that can actually complete without an
  // external webhook (docs/INTERVIEW-RECORDING-MEDIARECORDER-PLAN.md).
  //
  // The Egress branch is left standing rather than deleted: the plan's Step 5 is explicit that the
  // working-if-costly path is only removed once its replacement is proven on real interviews, so
  // a tenant with sessionRecording off keeps exactly the behaviour it has today.
  const clientRecording = interviewRecording.enabled(settings);
  if (videoOn && !clientRecording) {
    const rec = await livekit.startRecording(session);
    session.aiInterview.recordingStatus = rec.started ? "recording" : "failed";
    session.aiInterview.recordingSource = "egress";
    if (rec.egressId) session.aiInterview.egressId = rec.egressId;
  }

  session.markModified("aiInterview");
  await session.save();

  res.json({
    url: process.env.LIVEKIT_URL,
    token,
    room: livekit.roomName(session),
    persona: { name: persona.name, source: persona.source },
    videoEnabled: videoOn,
  });
}

// What the worker needs to be the engine's mouth: the prompt, the function contract, the
// transcript vocabulary and the approved voice. Fetched BY THE WORKER with the candidate's portal
// JWT immediately after dispatch — the browser never requests it, and nothing in it is a
// credential. Single-sourced from voiceAgentService.sessionBrief so the Deepgram agent and the
// LiveKit worker can never drift into conducting different interviews.
async function livekitBrief(req, res) {
  const session = req.interviewSession;
  const settings = await CompanySettings.findOne({ company: session.company }).select("ai compliance");
  if (!livekit.isEnabled(settings)) {
    return res.status(404).json({ error: "LiveKit realtime interview is not enabled", code: "LIVEKIT_DISABLED" });
  }
  if (!session.voiceConsent?.given) {
    return res.status(403).json({ error: "Voice consent has not been given for this interview", code: "VOICE_CONSENT_REQUIRED" });
  }
  const candidate = await Candidate.findById(session.candidate).populate("job");
  if (!candidate) return res.status(404).json({ error: "Candidate not found for this interview" });
  const persona = await personaService.resolveForSession(session);
  res.json(await voiceAgent.sessionBrief(session, { candidate, job: candidate.job, persona }));
}

// Client-side close: fast path on clean disconnects and sendBeacon on tab close. The
// room_finished webhook below is the backstop that catches everything else. Both funnel into the
// same idempotent meterSession, so whichever arrives first wins and the other no-ops.
async function livekitEnd(req, res) {
  res.json(await livekit.meterSession(req.interviewSession));
}

// The worker reporting that the candidate dropped out of the room, came back, or never did.
//
// Audit only. It cannot end an interview, cannot change a status, and cannot reach a score — see
// InterviewSession.presence for why a connection event must never be read as evidence about the
// person. The worker is the only caller that can see these transitions, which is why it is an
// endpoint rather than something the browser reports.
async function livekitPresence(req, res) {
  const aiInterview = require("../services/aiInterviewService");
  const { event, awayMs } = req.body || {};
  res.json(
    await aiInterview.recordPresence(req.interviewSession, {
      event: String(event || ""),
      awayMs: Number(awayMs),
    })
  );
}

// The authoritative meter. Mounted in server.js BEFORE express.json() with a raw-body parser —
// LiveKit signs the exact bytes (JWT in the Authorization header keyed by API key/secret), same
// rule as the Razorpay webhook and for the same reason.
async function livekitWebhook(req, res) {
  if (!livekit.configured()) return res.status(404).json({ error: "not configured" });
  let event;
  try {
    const { WebhookReceiver } = require("livekit-server-sdk");
    const receiver = new WebhookReceiver(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
    event = await receiver.receive(req.body.toString("utf8"), req.get("Authorization"));
  } catch (err) {
    // Bad signature / malformed body. 400 (not 200) so LiveKit's delivery log shows the failure,
    // and nothing unverified ever reaches the metering path.
    console.error("[livekit] webhook rejected:", err.message);
    return res.status(400).json({ error: "invalid webhook" });
  }
  try {
    res.json(await livekit.handleWebhookEvent(event));
  } catch (err) {
    // Verified event, our handling failed. 500 so LiveKit RETRIES — a dropped room_finished is a
    // potentially unmetered session, which is the failure this webhook exists to prevent.
    console.error("[livekit] webhook handling failed:", err.message);
    res.status(500).json({ error: "webhook handling failed" });
  }
}

module.exports = {
  livekitAvailable,
  livekitSession,
  livekitBrief,
  livekitEnd,
  livekitPresence,
  livekitWebhook,
};
