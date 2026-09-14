// Self-orchestrated realtime voice on LiveKit — LIVEKIT-REALTIME-PLAN.md, Phase LK-1.
//
// The platform's ONLY realtime voice pipeline (the Deepgram Voice Agent transport it superseded
// has been removed; turn-based remains the default and the fallback floor). The custody story is
// the reason it won: the browser receives a join-only room token and nothing else — no Settings
// block, no model keys, no transcript-relay duty. The Python worker (agent-worker/) holds the
// speech keys server-side and reaches the engine through the /api/interview-portal/realtime/*
// endpoints, authenticated with the candidate's own portal JWT handed over in agent-dispatch
// metadata (worker-only; never visible to room participants).
//
// Everything here is plumbing. The engine (aiInterviewService via voiceAgentService.dispatch)
// stays the sole question author and scorer, whichever pipeline carries the audio.

const CompanySettings = require("../models/CompanySettings"); // eslint-disable-line no-unused-vars — kept for parity with sibling services' imports
const InterviewSession = require("../models/InterviewSession");
const usageService = require("./usageService");
const speech = require("./speechService");
const llm = require("./llmService");
const storageService = require("./storageService");
const tenantContext = require("../utils/tenantContext");
const { publicBaseUrl } = require("../utils/corsOrigins");

const ROOM_PREFIX = "itv-";

// A realtime session that never closed cleanly still stops counting against the tenant's
// concurrency cap after this window — a crashed worker must not brick a company's interviewing.
// The metering webhook normally closes sessions long before this matters.
const ACTIVE_WINDOW_MS = 2 * 60 * 60 * 1000;

function configured() {
  return Boolean(
    process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
  );
}

// Off unless explicitly enabled. Turn-based is the default and the always-available floor: a
// livekit session that cannot start must drop the candidate back to it rather than cost them
// their interview.
function isEnabled(settings) {
  if (!configured()) return false;
  // The worker's STT/TTS is Deepgram and its reasoning is OpenRouter, and there is no
  // deterministic fallback once the audio is live. No keys ⇒ refuse up front, client falls back
  // to turn-based.
  if (!speech.isEnabled()) return false;
  if (!llm.isEnabled()) return false;
  const tenant = settings?.ai?.voiceMode;
  if (tenant === "livekit") return true;
  // ANY other explicit value pins the tenant off this pipeline — including the legacy "realtime"
  // string left in older CompanySettings docs by the retired Deepgram-agent pipeline, which must
  // land those tenants safely on turn-based, never on a pipeline they didn't choose.
  if (tenant) return false;
  return String(process.env.VOICE_MODE || "").toLowerCase() === "livekit";
}

function agentName() {
  return String(process.env.LIVEKIT_AGENT_NAME || "recruitment-interviewer").trim();
}

// Off unless explicitly enabled, same shape as evidenceClipService's clipsEnabled/
// secondaryCamEnabled: unset ⇒ env default (off); explicit tenant value wins either way. Only
// meaningful once isEnabled(settings) is already true — there is no video path off the LiveKit
// pipeline. Additionally requires persistent Cloudinary storage to be configured, so a tenant flag
// with no storage behind it must still behave as off rather than fail a live interview.
function videoEnabled(settings) {
  const override = settings?.ai?.videoEnabled;
  const wanted = typeof override === "boolean" ? override : process.env.LIVEKIT_VIDEO_ENABLED === "true";
  return wanted && storageService.isEnabled();
}

// Video's own per-minute rate, deliberately separate from costCents(). LiveKit Cloud bills camera
// participant-minutes and Egress output-minutes on top of the audio room-minute figure, and the
// audio rate itself (LIVEKIT_CENTS_PER_MIN) has not been calibrated against real production
// billing yet (LIVEKIT-REALTIME-PLAN.md's LK-5 cost-gate runbook step, still an owner-remainder
// task) — so this default is an even less certain placeholder than that one, and video usage is
// metered under its own UsageEvent kind ("realtime_video") rather than folded into "realtime" so
// the two can be told apart once real numbers exist.
function videoCostCents(durationMs) {
  const perMin = Number(process.env.LIVEKIT_VIDEO_CENTS_PER_MIN || 8);
  return Math.round((Math.max(0, durationMs) / 60000) * perMin * 100) / 100;
}

function roomName(session) {
  return `${ROOM_PREFIX}${session._id}`;
}

// Inverse of roomName, used by the metering webhook. Strict: a webhook event for a room we did
// not name (someone else's project traffic, a typo'd manual room) must map to nothing.
function sessionIdFromRoom(name) {
  const s = String(name || "");
  if (!s.startsWith(ROOM_PREFIX)) return null;
  const id = s.slice(ROOM_PREFIX.length);
  return /^[a-f0-9]{24}$/i.test(id) ? id : null;
}

// LIVEKIT_URL is the client-facing wss:// endpoint; the server SDK's REST clients want https://.
function httpUrl() {
  return String(process.env.LIVEKIT_URL || "")
    .replace(/^wss:/i, "https:")
    .replace(/^ws:/i, "http:");
}

// The candidate's room credential: join THEIR room, publish mic, subscribe to the agent. Nothing
// else — no roomCreate, no roomAdmin, no roomList. TTL tracks the interview session's own expiry
// (same derivation as the portal JWT) so a leaked token dies with the session.
async function mintCandidateToken(session) {
  const { AccessToken } = require("livekit-server-sdk");
  const expiresAt = session.expiresAt ? new Date(session.expiresAt).getTime() : NaN;
  const msLeft = Number.isFinite(expiresAt) ? expiresAt - Date.now() : NaN;
  const ttl = Number.isFinite(msLeft) ? Math.max(60, Math.min(3 * 3600, Math.floor(msLeft / 1000))) : 3600;

  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: `candidate-${session._id}`,
    ttl,
  });
  at.addGrant({
    roomJoin: true,
    room: roomName(session),
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    roomCreate: false,
    roomAdmin: false,
    roomList: false,
  });
  return at.toJwt();
}

// Explicit dispatch: summon the worker into this session's room, carrying the ONLY context it
// gets — the session id, the candidate's portal JWT (its credential for the /realtime/* function
// endpoints), and a backend URL hint. Dispatch metadata is delivered to the worker's job request,
// NOT to room participants, which is why the portal token may ride in it: the only party who
// could read it server-side already holds broader credentials, and the candidate it names
// already owns it.
//
// Guarded against double-summoning: a reconnecting candidate re-mints a token, but a second
// dispatch into a room that still has an agent would seat two interviewers.
async function dispatchAgent(session, portalToken) {
  const { AgentDispatchClient } = require("livekit-server-sdk");
  const client = new AgentDispatchClient(httpUrl(), process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  const room = roomName(session);

  try {
    const existing = await client.listDispatch(room);
    if ((existing || []).some((d) => d.agentName === agentName())) {
      return { dispatched: false, reason: "agent already dispatched to this room" };
    }
  } catch (err) {
    // Best-effort duplicate guard, not a gate — on a fresh room this can 404 depending on
    // server version, and refusing to dispatch because we couldn't LIST would strand the room.
    console.warn(`[livekit] listDispatch failed for ${room} (continuing): ${err.message}`);
  }

  const metadata = JSON.stringify({
    sessionId: String(session._id),
    portalToken,
    // normalizeBase, not the raw env: a schemeless host reaches the worker as an
    // httpx URL error, and the interview dies before the first question.
    backendUrl: publicBaseUrl(),
  });
  await client.createDispatch(room, agentName(), { metadata });
  return { dispatched: true };
}

// §3.6: tear down a candidate's room when their interview is finalized as abandoned — most
// pointedly the presence-triggered path (aiInterviewService.finalizeAbandoned), which fires while
// the link is still technically valid, so the room otherwise stays live and joinable for up to the
// full 48h validity window after the candidate has already walked away. Best-effort: a room that
// was never dispatched, or is already gone, is not an error, and this must never block or fail the
// finalization it's called from.
async function deleteRoom(session) {
  if (!configured()) return { deleted: false, reason: "not_configured" };
  const { RoomServiceClient } = require("livekit-server-sdk");
  const client = new RoomServiceClient(httpUrl(), process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  try {
    await client.deleteRoom(roomName(session));
    return { deleted: true };
  } catch (err) {
    console.warn(`[livekit] room delete failed for ${roomName(session)} (likely already gone): ${err.message}`);
    return { deleted: false, reason: err.message };
  }
}

// LiveKit Egress cannot write directly to Cloudinary. Full-session browser recording uses
// interviewRecordingService and uploads through storageService instead.
async function startRecording(session) {
  return { started: false, reason: "cloudinary_uses_browser_recording_pipeline" };
}

// LiveKit bills per session-minute like the Deepgram agent but at a different (lower) rate, so it
// gets its own knob. Default is the plan's pre-validation estimate; Phase LK-5's cost gate
// replaces it with the measured all-in number before any paying tenant is enabled.
function costCents(durationMs) {
  const perMin = Number(process.env.LIVEKIT_CENTS_PER_MIN || 4);
  return Math.round((Math.max(0, durationMs) / 60000) * perMin * 100) / 100;
}

// Close out a session's billing window. Idempotent (realtimeMeteredAt guard) because it has THREE
// callers that can race: the client's /end on disconnect, sendBeacon on tab close, and the
// room_finished webhook — and a double-report must not double-bill. Shared with the Deepgram
// path's field names so recruiter reporting reads one schema.
async function meterSession(session) {
  const ai = session.aiInterview;
  const startedAt = ai?.realtimeStartedAt;
  if (!startedAt || ai?.realtimeMeteredAt) return { metered: false };

  const durationMs = Math.max(0, Date.now() - new Date(startedAt).getTime());
  // Atomic test-and-set, NOT doc.save(): three callers race here (client /end, sendBeacon,
  // webhook) and, worse, a doc-level save() at interview end bumps the version under the slow
  // detached finalization and fails it with a VersionError — found live in the LK-2 e2e. The
  // filter is the idempotency guard: exactly one caller matches, everyone else no-ops.
  const result = await InterviewSession.updateOne(
    { _id: session._id, "aiInterview.realtimeMeteredAt": null, "aiInterview.realtimeStartedAt": { $ne: null } },
    { $set: { "aiInterview.realtimeMeteredAt": new Date(), "aiInterview.realtimeDurationMs": durationMs } }
  );
  if (!result.modifiedCount) return { metered: false };
  ai.realtimeMeteredAt = new Date();
  ai.realtimeDurationMs = durationMs;

  try {
    await usageService.recordUsage({
      company: session.company,
      session: session._id,
      candidate: session.candidate,
      kind: "realtime",
      provider: "livekit",
      model: "agent-worker",
      usage: { costCents: costCents(durationMs) },
      latencyMs: durationMs,
      engine: "ai",
    });
  } catch (err) {
    console.error("[livekit] session metering failed:", err.message);
  }

  // Video ran for the same window as the audio session (Egress was started alongside the room
  // mint and stops when the room does), so the same durationMs is the video meter's input too.
  // Only when a recording actually started for this session — sessions with video off never set
  // egressId — so a tenant without the flag on is never charged for video it never used.
  if (ai?.egressId) {
    try {
      await usageService.recordUsage({
        company: session.company,
        session: session._id,
        candidate: session.candidate,
        kind: "realtime_video",
        provider: "livekit",
        model: "egress",
        usage: { costCents: videoCostCents(durationMs) },
        latencyMs: durationMs,
        engine: "ai",
      });
    } catch (err) {
      console.error("[livekit] video session metering failed:", err.message);
    }
  }
  return { metered: true, durationMs };
}

// Record the outcome of a recording started by startRecording(). Not the billing meter — that is
// the room-minute figure from meterSession — this only writes down WHERE the file landed (or that
// it didn't), because playback needs a key and a status, not a cost.
async function handleEgressEnded(egressInfo) {
  // Direct LiveKit Egress storage is unsupported after the Cloudinary migration.
  // Browser recording is finalized by interviewRecordingService instead.
  return { handled: false, reason: "cloudinary_uses_browser_recording_pipeline" };
}

// The webhook is the AUTHORITATIVE meter: it fires when the room actually closed, which catches
// the killed-tab / crashed-worker cases the client-side /end cannot. Runs as system — a webhook
// has no tenant context, and the room name is the only routing key. Also the authoritative source
// for the recording's outcome (egress_ended) — recording start is best-effort and fire-and-forget
// from livekitController, so this is the only place that ever learns whether it actually finished.
async function handleWebhookEvent(event) {
  if (event?.event === "egress_ended") {
    return tenantContext.runAsSystem(() => handleEgressEnded(event.egressInfo));
  }
  if (!event || event.event !== "room_finished") return { handled: false, reason: "not room_finished" };
  const sessionId = sessionIdFromRoom(event.room?.name);
  if (!sessionId) return { handled: false, reason: "not an interview room" };

  return tenantContext.runAsSystem(async () => {
    const session = await InterviewSession.findById(sessionId);
    if (!session) return { handled: false, reason: "no such session" };
    const result = await meterSession(session);
    return { handled: true, ...result };
  });
}

// A short-lived URL the admin app can hand to a <video> element directly — Range-capable, never
// buffered through this process. Returns null when there is nothing to play (no completed
// recording, or persistent storage not configured), which the caller renders as "no recording" rather than an
// error.
//
// Compatibility helper; historical Egress files resolve through private R2 playback too.
async function getRecordingPlaybackUrl(session) {
  return require("./interviewRecordingService").playbackUrl(session);
}

// How many of this company's realtime sessions are live right now — the fairness denominator for
// the per-tenant concurrency cap (multi-tenant plan §4: one tenant's hiring drive must not starve
// every other company's interviews).
async function activeSessionCount(companyId) {
  return InterviewSession.countDocuments({
    company: companyId,
    "aiInterview.realtimeStartedAt": { $gte: new Date(Date.now() - ACTIVE_WINDOW_MS) },
    "aiInterview.realtimeMeteredAt": null,
  });
}

module.exports = {
  configured,
  isEnabled,
  videoEnabled,
  agentName,
  roomName,
  sessionIdFromRoom,
  httpUrl,
  mintCandidateToken,
  dispatchAgent,
  deleteRoom,
  startRecording,
  costCents,
  videoCostCents,
  meterSession,
  handleWebhookEvent,
  handleEgressEnded,
  getRecordingPlaybackUrl,
  activeSessionCount,
  ACTIVE_WINDOW_MS,
};
