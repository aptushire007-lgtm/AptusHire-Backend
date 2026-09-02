// Candidate-facing assessment portal (ASSESSMENT-ENGINE-PLAN A2.4/A2.5).
// Everything here is allow-listed and server-authoritative:
//   - item payloads come from assessmentService.itemsPayload, which never reads
//     `key` (a serializer test pins that no portal response contains one);
//   - remaining time is computed server-side on every write — the client timer
//     is display only;
//   - proctoring severity/risk are assigned server-side from event types,
//     mirroring the interview portal's ingestion.

const AssessmentPaper = require("../models/AssessmentPaper");
const assessmentService = require("../services/assessmentService");
const proctoring = require("../utils/proctoring");

const PROCTORING_EVENT_TAIL = 300;
const PROCTORING_MAX_PER_FLUSH = 100;

async function login(req, res) {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token is required" });
  const { token: jwtToken, session } = await assessmentService.loginWithToken(token);
  const paper = await AssessmentPaper.findById(session.paper);
  res.json({
    token: jwtToken,
    session: assessmentService.dashboardPayload(session, session.candidate, session.job, paper),
  });
}

async function me(req, res) {
  const session = await req.assessmentSession.populate(["candidate", "job"]);
  const paper = await AssessmentPaper.findById(session.paper);
  res.json({ session: assessmentService.dashboardPayload(session, session.candidate, session.job, paper) });
}

// System check (reuses the interview pre-check grammar; camera is only required
// when the paper runs proctoring).
async function submitChecks(req, res) {
  const session = req.assessmentSession;
  const { camera, microphone, fullscreen, deviceCompatible, browserInfo, downloadMbps } = req.body || {};
  session.deviceCheck = {
    camera: !!camera,
    microphone: !!microphone,
    screenShare: false,
    fullscreen: !!fullscreen,
    deviceCompatible: !!deviceCompatible,
    browserInfo: typeof browserInfo === "string" ? browserInfo.slice(0, 300) : undefined,
    completedAt: new Date(),
  };
  if (Number.isFinite(Number(downloadMbps))) {
    session.speedTest = { downloadMbps: Math.round(Number(downloadMbps) * 10) / 10, testedAt: new Date() };
  }
  await session.save();
  res.json({ deviceCheck: session.deviceCheck, speedTest: session.speedTest });
}

async function start(req, res) {
  const session = await assessmentService.startAssessment(req.assessmentSession);
  const paper = await AssessmentPaper.findById(session.paper);
  await session.populate(["candidate", "job"]);
  res.json({ session: assessmentService.dashboardPayload(session, session.candidate, session.job, paper) });
}

async function startSection(req, res) {
  const { sectionId } = req.params;
  const { section, state, remainingSec, items } = await assessmentService.startSection(req.assessmentSession, sectionId);
  res.json({
    section: { id: section.id, title: section.title, timeLimitSec: section.timeLimitSec },
    state: { status: state.status, startedAt: state.startedAt },
    remainingSec,
    items,
  });
}

async function saveResponse(req, res) {
  const { itemId, response, markedForReview, timeSpentMs } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "itemId is required" });
  const { remainingSec } = await assessmentService.saveResponse(req.assessmentSession, {
    itemId,
    response,
    markedForReview,
    timeSpentMs,
  });
  res.json({ saved: true, remainingSec });
}

async function submitSection(req, res) {
  const { sectionId } = req.params;
  const session = await assessmentService.submitSection(req.assessmentSession, sectionId);
  res.json({ sectionState: session.sectionState });
}

async function submit(req, res) {
  const session = await assessmentService.submitAssessment(req.assessmentSession);
  res.json({
    status: session.status,
    completedAt: session.completedAt,
    // Honest completion screen: what happens next, never the score (bands and
    // reports are the recruiter's decision surface, not the candidate's).
    message: "Your assessment has been submitted. If you advance, your AI interview invitation will arrive by email.",
  });
}

// --- Proctoring (mirrors the interview portal's server-side ingestion) -------

async function proctoringConsent(req, res) {
  const session = req.assessmentSession;
  const given = !!req.body?.given;
  const p = session.proctoring || {};
  p.consent = { given, declined: !given, at: new Date() };
  if (typeof req.body?.visionEnabled === "boolean") p.visionEnabled = req.body.visionEnabled;
  session.proctoring = p;
  session.markModified("proctoring");
  await session.save();
  res.json({ consent: p.consent, visionEnabled: p.visionEnabled });
}

async function proctoringEvents(req, res) {
  const session = req.assessmentSession;
  const incoming = Array.isArray(req.body?.events) ? req.body.events.slice(0, PROCTORING_MAX_PER_FLUSH) : [];

  const p = session.proctoring || {};
  if (typeof req.body?.visionEnabled === "boolean") p.visionEnabled = req.body.visionEnabled;
  const counts = { ...(p.counts || {}) };
  const accepted = [];

  for (const raw of incoming) {
    const type = String(raw?.type || "");
    if (!proctoring.isKnownType(type)) continue;
    if (type === "phone_cam_lost") continue; // server-derived only
    counts[type] = (counts[type] || 0) + 1;
    accepted.push({ type, severity: proctoring.severityOf(type), meta: proctoring.sanitizeMeta(type, raw?.meta), at: new Date() });
  }

  const { riskScore, riskBand } = proctoring.computeRisk(counts);
  p.counts = counts;
  p.riskScore = riskScore;
  p.riskBand = riskBand;
  p.totalEvents = (p.totalEvents || 0) + accepted.length;
  p.events = [...(p.events || []), ...accepted].slice(-PROCTORING_EVENT_TAIL);
  if (accepted.length) p.lastEventAt = new Date();
  session.proctoring = p;
  session.markModified("proctoring");
  await session.save();

  // A4.2 soft-lock: opt-in. Counted over HIGH-severity events this session has accumulated.
  // `action: "pause"` (default) fails open; `action: "auto_submit"` counts a narrower, stronger
  // signal set instead and ends the session outright — see maybeSoftLock.
  const highCount = (p.events || []).filter((e) => e.severity === "high").length;
  const { paused, terminated } = await assessmentService.maybeSoftLock(session, highCount);

  res.json({ riskBand, paused, terminated });
}

module.exports = {
  login,
  me,
  submitChecks,
  start,
  startSection,
  saveResponse,
  submitSection,
  submit,
  proctoringConsent,
  proctoringEvents,
};
