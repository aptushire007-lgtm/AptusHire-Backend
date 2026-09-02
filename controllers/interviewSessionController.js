const InterviewSession = require("../models/InterviewSession");
const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const ProctoringEvidence = require("../models/ProctoringEvidence");
const storageService = require("../services/storageService");
const livekit = require("../services/livekitService");
const interviewRecordingService = require("../services/interviewRecordingService");
const { writeAuditLog } = require("../middleware/auditLog");
const { hashToken, resendOrRescheduleInterview, findLatestSession } = require("../services/interviewInvitationService");

async function verifyToken(req, res) {
  const { token } = req.params;
  const tokenHash = hashToken(token);

  const session = await InterviewSession.findOne({ tokenHash }).populate("candidate", "basicDetails").populate("job", "title department");
  if (!session) return res.status(404).json({ error: "Invalid interview link" });

  if (session.status === "cancelled") {
    return res.status(410).json({ error: "This interview has been cancelled" });
  }
  if (new Date() > session.expiresAt) {
    if (session.status !== "expired") {
      session.status = "expired";
      await session.save();
    }
    return res.status(410).json({ error: "This interview link has expired" });
  }

  if (!session.accessedAt) {
    session.accessedAt = new Date();
    await session.save();
  }

  res.json({
    candidateName: session.candidate.basicDetails.name,
    jobTitle: session.job.title,
    department: session.job.department,
    interviewAt: session.interviewAt,
    expiresAt: session.expiresAt,
    instructions: session.instructions,
    status: session.status,
  });
}

async function getForCandidate(req, res) {
  const session = await findLatestSession(req.params.id, req.user.company).populate("job", "title department");
  if (!session) return res.status(404).json({ error: "No interview session found for this candidate" });
  res.json(session);
}

// Load the session + its candidate + job for an admin action, all scoped to the
// caller's company (tenantScope also enforces this as a safety net). Returns null
// if the candidate has no interview session yet. Resend/reschedule always target the LATEST
// attempt — an earlier, already-completed attempt is final and resendOrRescheduleInterview
// refuses it anyway.
async function loadAdminSessionContext(candidateId, companyId) {
  const session = await findLatestSession(candidateId, companyId);
  if (!session) return null;
  const candidate = await Candidate.findOne({ _id: candidateId, company: companyId });
  const job = candidate ? await Job.findById(candidate.job) : null;
  return { session, candidate, job };
}

// A forced override of a live interview ends the candidate's current session — worth its
// own durable audit trail beyond the email/notification the resend already sends.
function auditForcedOverride(req, session) {
  writeAuditLog({
    req,
    company: req.user.company,
    action: "interview.link.force_resend",
    resourceType: "InterviewSession",
    resourceId: String(session._id),
    meta: { candidate: String(session.candidate) },
  });
}

// POST /interview-sessions/candidate/:id/resend  body: { force? }
// Re-send the interview invitation (rotates the magic-link token, refreshes the
// validity window, keeps the same scheduled time). `force` overrides the default
// refusal to rotate a link that's live mid-interview — see interviewInvitationService.
async function resendInterview(req, res) {
  const ctx = await loadAdminSessionContext(req.params.id, req.user.company);
  if (!ctx) return res.status(404).json({ error: "No interview session found for this candidate" });
  if (!ctx.candidate || !ctx.job) return res.status(404).json({ error: "Candidate or job not found for this session" });

  const { session, interviewUrl, forcedLiveOverride } = await resendOrRescheduleInterview(ctx.session, ctx.candidate, ctx.job, {
    force: Boolean(req.body?.force),
  });
  if (forcedLiveOverride) auditForcedOverride(req, session);
  res.json({ ok: true, interviewUrl, interviewAt: session.interviewAt, expiresAt: session.expiresAt, status: session.status });
}

// POST /interview-sessions/candidate/:id/reschedule  body: { interviewAt, force? }
// Move the interview to a new time and re-send the invitation with a fresh link.
async function rescheduleInterview(req, res) {
  const { interviewAt } = req.body;
  if (!interviewAt) return res.status(400).json({ error: "interviewAt is required" });
  const when = new Date(interviewAt);
  if (Number.isNaN(when.getTime())) return res.status(400).json({ error: "interviewAt is not a valid date" });
  if (when.getTime() <= Date.now()) return res.status(400).json({ error: "interviewAt must be in the future" });

  const ctx = await loadAdminSessionContext(req.params.id, req.user.company);
  if (!ctx) return res.status(404).json({ error: "No interview session found for this candidate" });
  if (!ctx.candidate || !ctx.job) return res.status(404).json({ error: "Candidate or job not found for this session" });

  const { session, interviewUrl, forcedLiveOverride } = await resendOrRescheduleInterview(ctx.session, ctx.candidate, ctx.job, {
    interviewAt: when,
    force: Boolean(req.body?.force),
  });
  if (forcedLiveOverride) auditForcedOverride(req, session);
  res.json({ ok: true, interviewUrl, interviewAt: session.interviewAt, expiresAt: session.expiresAt, status: session.status });
}

// ---------------------------------------------------------------------------
// Phase 14.5 — evidence-clip review (human eyes only)
// ---------------------------------------------------------------------------

// GET /interview-sessions/candidate/:id/evidence — clip metadata for the
// candidate's session, next to the flags they evidence. Never the bytes.
async function listEvidence(req, res) {
  const rows = await ProctoringEvidence.find({ company: req.user.company, candidate: req.params.id })
    .sort({ capturedAt: 1 })
    .select("-clipKey -__v")
    .lean();
  res.json({ items: rows });
}

// GET /interview-sessions/candidate/:id/turn-audio/:turnIndex — stream one answer's recorded
// audio to a reviewer. Same posture as evidence clips: scoped to the caller's own company (never
// another tenant's candidate), and every view writes an AuditLog row before a single byte is
// sent. The storage key itself is never exposed to any client — only this route can resolve it.
async function streamTurnAudio(req, res) {
  const session = await findLatestSession(req.params.id, req.user.company).select("aiInterview.turns");
  if (!session) return res.status(404).json({ error: "No interview session found for this candidate" });
  const turnIndex = Number(req.params.turnIndex);
  const turn = Number.isInteger(turnIndex) ? session.aiInterview?.turns?.[turnIndex] : null;
  if (!turn?.audioKey) return res.status(404).json({ error: "No audio recorded for that answer" });

  writeAuditLog({
    req,
    company: req.user.company,
    action: "interview.answer_audio.view",
    resourceType: "InterviewSession",
    resourceId: String(session._id),
    meta: { turnIndex },
  });

  const buffer = await storageService.getObjectBuffer(turn.audioKey);
  res.setHeader("Content-Type", turn.audioMimeType || "audio/webm");
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
}

// GET /interview-sessions/evidence/:evidenceId — stream one clip to the
// reviewer. Access to biometric-adjacent footage must itself be auditable:
// EVERY view writes an AuditLog row before a single byte is sent.
async function streamEvidenceClip(req, res) {
  const row = await ProctoringEvidence.findOne({ _id: req.params.evidenceId, company: req.user.company });
  if (!row) return res.status(404).json({ error: "Evidence clip not found" });

  writeAuditLog({
    req,
    company: req.user.company,
    action: "evidence.view",
    resourceType: "ProctoringEvidence",
    resourceId: String(row._id),
    meta: { eventType: row.eventType, source: row.source, session: String(row.session) },
  });

  const buffer = await storageService.getObjectBuffer(row.clipKey);
  res.setHeader("Content-Type", row.mimeType || "video/webm");
  res.setHeader("Content-Length", buffer.length);
  res.setHeader("Cache-Control", "no-store");
  res.send(buffer);
}

// GET /interview-sessions/candidate/:id/recording[?mint=1] — status of the candidate's video
// recording (Phase 7, default-off — most sessions have none), and, only when explicitly asked
// for via ?mint=1, a short-lived Range-capable playback URL.
//
// Two different things share one route on purpose: the report page checks status passively on
// every load (so it knows whether to show a play button at all), and that check must NOT be an
// audit-logged "view" — a recruiter opening a report browses it constantly, and logging that as
// "recording viewed" would make the audit trail claim something that never happened. Only the
// explicit mint — the recruiter pressing play, which actually hands out a URL that can play the
// video — is logged, same posture as evidence clips and turn audio.
async function getRecordingUrl(req, res) {
  const session = await findLatestSession(req.params.id, req.user.company).select(
    "aiInterview.recordingStatus aiInterview.recordingKey aiInterview.recordingDurationMs " +
      "aiInterview.recordingStartedAt aiInterview.recordingSource"
  );
  if (!session) return res.status(404).json({ error: "No interview session found for this candidate" });

  const ai = session.aiInterview || {};
  const status = ai.recordingStatus || "none";
  // `startedAt` is the capture clock, and it is only sent for rows that actually have one.
  // Browser-captured recordings stamp it on their first chunk; LiveKit Egress rows never can, and
  // the report degrades its transcript timestamps to plain labels rather than seek somewhere
  // confidently wrong. `source` is what tells the player which of those two it is holding.
  const base = {
    status,
    url: null,
    durationMs: ai.recordingDurationMs || null,
    startedAt: ai.recordingStartedAt || null,
    source: ai.recordingSource || null,
  };
  const mint = req.query?.mint === "1";
  if (!mint) return res.json(base);

  writeAuditLog({
    req,
    company: req.user.company,
    action: "interview.recording.view",
    resourceType: "InterviewSession",
    resourceId: String(session._id),
  });

  // Both producers land on the same field (`aiInterview.recordingKey`) and the same signed-URL
  // mint, so one call serves historical Egress rows and browser-captured ones alike. The
  // LiveKit-owned helper is gone from this path: where the file came from stopped being LiveKit's
  // business the moment recording did.
  const url = await interviewRecordingService.playbackUrl(session);
  res.json({ ...base, url });
}

// Mirrors the model's enum, and must keep mirroring it: this list is the browse page's default
// filter, so a status missing here does not show as unfiltered — those rows vanish from the
// listing entirely. "partial" is exactly the state a recruiter most needs to find (footage exists,
// assembly did not), so dropping it would hide the one case that is actionable.
const RECORDING_STATUSES = ["pending", "recording", "completed", "partial", "failed"];

// Browse-all view backing the admin "Recordings" page — every session that has attempted a
// recording (any status, not just completed) for this company, most recent first. Mirrors
// adminNotificationController.listMine's { items, total, page, limit, totalPages } envelope. No
// signed playback URL here — that stays a per-candidate, audit-logged mint via getRecordingUrl
// above; this endpoint only lists who has one, so selecting a row hands off to the existing report
// page rather than duplicating video playback.
async function listRecordings(req, res) {
  const { page = 1, limit = 20, status } = req.query;

  const statusFilter = RECORDING_STATUSES.includes(status) ? [status] : RECORDING_STATUSES;
  const filter = { company: req.user.company, "aiInterview.recordingStatus": { $in: statusFilter } };

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(100, Math.max(1, Number(limit)));

  const [sessions, total] = await Promise.all([
    InterviewSession.find(filter)
      .select("aiInterview.recordingStatus aiInterview.recordingDurationMs candidate job updatedAt")
      .populate("candidate", "basicDetails.name basicDetails.email")
      .populate("job", "title")
      .sort({ updatedAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    InterviewSession.countDocuments(filter),
  ]);

  const recordings = sessions.map((s) => ({
    sessionId: s._id,
    candidateId: s.candidate?._id || null,
    candidateName: s.candidate?.basicDetails?.name || "Unnamed applicant",
    candidateEmail: s.candidate?.basicDetails?.email || null,
    jobTitle: s.job?.title || null,
    status: s.aiInterview?.recordingStatus || "none",
    durationMs: s.aiInterview?.recordingDurationMs || null,
    updatedAt: s.updatedAt,
  }));

  res.json({ recordings, total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 });
}

module.exports = {
  verifyToken,
  getForCandidate,
  resendInterview,
  rescheduleInterview,
  listEvidence,
  streamEvidenceClip,
  streamTurnAudio,
  getRecordingUrl,
  listRecordings,
};
