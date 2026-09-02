// Hiring-pipeline orchestration (Module 11). Validates stage transitions,
// records the append-only stage history, keeps the offer sub-document in sync,
// and fans out notifications + realtime socket updates to both the admin and
// the candidate. Controllers should go through here rather than mutating
// `candidate.status` directly, so validation, history, and notifications stay
// consistent.

const User = require("../models/User");
const ReviewItem = require("../models/ReviewItem");
const InterviewQueue = require("../models/InterviewQueue");
const { notifyCandidate, notifyAdmin } = require("./notificationService");
const { createInterviewSessionIfNeeded } = require("./interviewInvitationService");
const { emitToCandidateUser, emitToCompany } = require("../config/socket");
const {
  canTransition,
  normalizeStage,
  isValidStage,
  stageLabel,
  appendStageHistory,
  ROUND_STAGES,
} = require("../utils/pipeline");

// Per-stage notification config. `candidate`/`admin` describe the in-app +
// email notifications fired when a candidate ENTERS that stage. `email` (when
// present) names an emailTemplates key and how to build its args.
const STAGE_NOTIFICATIONS = {
  // No `candidate` entry: ensureInterviewInvite() already sent the authoritative
  // "interview_invite" email with the real magic link for this exact transition —
  // falling through to DEFAULT_NOTIFICATION here would double-notify the candidate
  // with a second, contentless "status updated" message right next to it.
  interview_scheduled: {
    admin: { type: "candidate_stage_changed", title: "Interview scheduled" },
  },
  // Same shape as interview_scheduled: the assessment invitation email (with the
  // real magic link) is sent by assessmentService — a generic candidate
  // notification here would double-notify right next to it.
  assessment_scheduled: {
    admin: { type: "candidate_stage_changed", title: "Assessment sent" },
  },
  assessment_completed: {
    candidate: { type: "assessment_completed", title: "Assessment completed" },
    admin: { type: "assessment_completed", title: "Assessment completed" },
  },
  ai_interview_completed: {
    candidate: { type: "interview_completed", title: "AI interview completed" },
    admin: { type: "interview_completed", title: "AI interview completed" },
  },
  under_review: {
    candidate: { type: "stage_changed", title: "Your application is under review" },
    admin: { type: "candidate_stage_changed", title: "Candidate under review" },
  },
  shortlisted: {
    candidate: { type: "next_round_scheduled", title: "You've been shortlisted", email: "stageUpdate" },
    admin: { type: "candidate_shortlisted", title: "Candidate shortlisted" },
  },
  hr_interview: {
    candidate: { type: "next_round_scheduled", title: "HR interview scheduled", email: "stageUpdate" },
    admin: { type: "candidate_stage_changed", title: "HR interview scheduled" },
  },
  technical_interview: {
    candidate: { type: "next_round_scheduled", title: "Technical interview scheduled", email: "stageUpdate" },
    admin: { type: "candidate_stage_changed", title: "Technical interview scheduled" },
  },
  manager_interview: {
    candidate: { type: "next_round_scheduled", title: "Manager interview scheduled", email: "stageUpdate" },
    admin: { type: "candidate_stage_changed", title: "Manager interview scheduled" },
  },
  selected: {
    candidate: { type: "stage_changed", title: "You've been selected", email: "stageUpdate" },
    admin: { type: "candidate_selected", title: "Candidate selected" },
  },
  offer_sent: {
    candidate: { type: "offer_letter", title: "You've received an offer", email: "offer" },
    admin: { type: "candidate_stage_changed", title: "Offer sent to candidate" },
  },
  offer_accepted: {
    candidate: { type: "offer_accepted", title: "Offer accepted" },
    admin: { type: "offer_accepted", title: "Candidate accepted the offer" },
  },
  joined: {
    candidate: { type: "joined", title: "Welcome aboard!", email: "stageUpdate" },
    admin: { type: "candidate_joined", title: "Candidate joined" },
  },
  rejected: {
    candidate: { type: "rejection", title: "Application update", email: "rejection" },
    admin: { type: "candidate_rejected", title: "Candidate rejected" },
  },
};

const DEFAULT_NOTIFICATION = {
  candidate: { type: "stage_changed", title: "Application status updated" },
  admin: { type: "candidate_stage_changed", title: "Candidate stage updated" },
};

function buildCandidateEmail(emailKind, candidate, job, label, note) {
  if (!emailKind) return undefined;
  const to = candidate.basicDetails.email;
  if (emailKind === "offer") {
    return { to, template: "offerLetterEmailTemplate", args: [candidate, job, candidate.offer || {}] };
  }
  if (emailKind === "rejection") {
    return { to, template: "rejectionEmailTemplate", args: [candidate, job] };
  }
  // Generic milestone update.
  return { to, template: "stageUpdateEmailTemplate", args: [candidate, job, label, note] };
}

// Keeps the offer sub-document coherent with the pipeline stage.
function syncOffer(candidate, toStage, offerMessage) {
  if (toStage === "offer_sent") {
    candidate.offer = { status: "sent", message: offerMessage || candidate.offer?.message, sentAt: new Date() };
  } else if (toStage === "offer_accepted") {
    candidate.offer = { ...(candidate.offer?.toObject?.() || candidate.offer || {}), status: "accepted", respondedAt: new Date() };
  } else if (toStage === "rejected" && candidate.offer?.status === "sent") {
    candidate.offer.status = "declined";
    candidate.offer.respondedAt = new Date();
  }
}

/**
 * Apply a stage transition to an already-loaded Candidate document.
 * Mutates, validates, saves, and fires notifications + socket events.
 *
 * @param {object} candidate  Mongoose Candidate doc (job populated for nice copy)
 * @param {string} toStage    target stage key
 * @param {object} opts       { note, actorName, offerMessage }
 * @throws {Error} on invalid stage or disallowed transition (surfaced as 400 by the global handler)
 * @returns {Promise<object>} the saved candidate
 */
async function applyTransition(candidate, toStage, { note, actorName, offerMessage } = {}) {
  const target = normalizeStage(toStage);
  const from = normalizeStage(candidate.status);

  if (!isValidStage(target)) {
    const err = new Error(`Unknown pipeline stage: ${toStage}`);
    err.status = 400;
    throw err;
  }
  if (!canTransition(from, target)) {
    const err = new Error(`Cannot move a candidate from "${stageLabel(from)}" to "${stageLabel(target)}".`);
    err.status = 400;
    throw err;
  }

  candidate.status = target;
  appendStageHistory(candidate, target, { note, by: actorName || "system" });
  syncOffer(candidate, target, offerMessage);
  await candidate.save();

  // Keep the two satellite "needs action" caches honest. Review Queue and AI
  // Interviews are populated by their own narrow code paths (atsService,
  // reviewQueueController) but a stage move made from OUTSIDE those flows —
  // the candidate profile page, the Hiring Pipeline board — has no reason to
  // know about them. Without this, a candidate advanced/rejected there keeps
  // showing up as still "needs review" / "awaiting interview" indefinitely.
  await closeSatelliteQueues(candidate, target);
  await ensureInterviewInvite(candidate, target);
  await ensureAssessmentInvite(candidate, target, actorName);
  await cancelStaleAssessment(candidate, target, actorName);

  // Outcome capture (Phase 10.1): joins this candidate's engine score to what
  // actually happened, feeding the nightly calibration. Fire-and-forget — a
  // metering failure must never block a stage move.
  require("./scoreOutcomeService")
    .recordTransition(candidate, target, { by: actorName || "system" })
    .catch(() => {});

  await dispatchStageNotifications(candidate, target, note);
  emitStageUpdate(candidate);

  return candidate;
}

// A candidate is only ever "awaiting the AI interview" while parked at
// interview_scheduled; any other destination — forward past it, or rejected —
// means the machine-pass wait is over, so the queue entry is stale.
async function closeSatelliteQueues(candidate, toStage) {
  const openItem = await ReviewItem.findOne({
    company: candidate.company,
    candidate: candidate._id,
    status: "open",
  });
  if (openItem) {
    const decision = toStage === "rejected" ? "decline" : "advance";
    openItem.status = "resolved";
    openItem.resolution = {
      decision,
      note: `Auto-resolved: stage moved to "${stageLabel(toStage)}" outside the review queue.`,
      at: new Date(),
    };
    openItem.label = { ...(openItem.label?.toObject?.() || openItem.label || {}), humanDecision: decision };
    await openItem.save();
  }

  if (toStage !== "interview_scheduled") {
    await InterviewQueue.findOneAndUpdate(
      { company: candidate.company, candidate: candidate._id, status: "queued" },
      { status: "removed" }
    );
  }
}

// A recruiter manually moving a candidate INTO interview_scheduled — from the
// profile page or the Hiring Pipeline board — is deciding "send this person the
// AI interview" exactly as much as an automatic ATS pass is. Without this,
// atsService.advanceAfterAtsPass (the ATS-auto-pass path) was the ONLY way an
// InterviewQueue entry or InterviewSession magic-link ever got created, so a
// manual advancement left the candidate with a stage label and nothing else —
// no queue entry, no email, no interview link.
async function ensureInterviewInvite(candidate, toStage) {
  if (toStage !== "interview_scheduled") return;
  const job = candidate.job;
  if (!job || !job._id) return; // job wasn't populated by the caller — nothing safe to act on

  await InterviewQueue.findOneAndUpdate(
    { candidate: candidate._id },
    {
      candidate: candidate._id,
      job: job._id,
      company: job.company,
      atsScore: candidate.ats?.overallScore ?? 0,
      status: "queued",
    },
    { upsert: true, new: true }
  );
  await createInterviewSessionIfNeeded(candidate, job);
}

// A recruiter dragging a candidate INTO assessment_scheduled on the pipeline
// board is assigning the assessment exactly as much as the "Send assessment"
// button is (mirrors ensureInterviewInvite's rationale). Without this the board
// move would leave a stage label with no session, no link, no email. Lazy
// require: assessmentService itself imports applyTransition from this module.
async function ensureAssessmentInvite(candidate, toStage, actorName) {
  if (toStage !== "assessment_scheduled") return;
  const job = candidate.job;
  if (!job || !job._id) return;
  try {
    const assessmentService = require("./assessmentService");
    const existing = await assessmentService.liveSessionFor(candidate._id, job._id);
    if (existing) return;
    await assessmentService.sendAssessment(candidate, job, { mode: "manual", actorName: actorName || "recruiter (pipeline board)" });
  } catch (err) {
    console.error(`[pipeline] assessment invite for candidate ${candidate._id} failed: ${err.message}`);
  }
}

// A candidate moved to rejected — or skipped forward to the interview while an
// assessment invitation was still open — must not keep a live session ghosting
// in the tracker (and the link must stop working).
async function cancelStaleAssessment(candidate, toStage, actorName) {
  if (!["rejected", "interview_scheduled"].includes(toStage)) return;
  try {
    const assessmentService = require("./assessmentService");
    const live = await assessmentService.liveSessionFor(candidate._id, candidate.job?._id || candidate.job);
    if (!live || live.startedAt) return; // never kill an attempt in progress — expiry/scoring owns that
    live.status = "cancelled";
    await live.save();
    console.log(`[pipeline] cancelled unstarted assessment session for candidate ${candidate._id} (moved to ${toStage} by ${actorName || "system"})`);
  } catch (err) {
    console.error(`[pipeline] stale assessment cleanup failed: ${err.message}`);
  }
}

async function dispatchStageNotifications(candidate, toStage, note) {
  const config = STAGE_NOTIFICATIONS[toStage] || DEFAULT_NOTIFICATION;
  const job = candidate.job && candidate.job.title ? candidate.job : null;
  const jobTitle = job?.title || "the role";
  const label = stageLabel(toStage);
  const candidateName = candidate.basicDetails.name;

  if (config.admin) {
    await notifyAdmin({
      companyId: candidate.company,
      type: config.admin.type,
      title: config.admin.title,
      message: `${candidateName}'s application for ${jobTitle} moved to "${label}".`,
      meta: { candidateId: candidate._id, stage: toStage },
    });
  }

  if (config.candidate) {
    const applicantUser = await User.findOne({ email: candidate.basicDetails.email, role: "candidate" });
    await notifyCandidate({
      candidateId: candidate._id,
      userId: applicantUser?._id,
      type: config.candidate.type,
      title: config.candidate.title,
      message: `Your application for ${jobTitle} is now: ${label}.${note ? ` ${note}` : ""}`,
      meta: { jobId: candidate.job?._id || candidate.job, stage: toStage },
      email: job ? buildCandidateEmail(config.candidate.email, candidate, job, label, note) : undefined,
    });
  }
}

// Dedicated realtime event (separate from notification:new) so both dashboards
// can live-update a status tracker / pipeline board without a page refresh.
function emitStageUpdate(candidate) {
  const payload = {
    candidateId: String(candidate._id),
    status: candidate.status,
    stageHistory: candidate.stageHistory,
    offer: candidate.offer,
    jobId: String(candidate.job?._id || candidate.job || ""),
  };
  emitToCompany(candidate.company, "candidate:stage", payload);

  // Candidate-side push is only possible for registered accounts.
  User.findOne({ email: candidate.basicDetails.email, role: "candidate" })
    .then((user) => {
      if (user) emitToCandidateUser(user._id, "candidate:stage", payload);
    })
    .catch(() => {});
}

// STAGE_NOTIFICATIONS/DEFAULT_NOTIFICATION are exported for the enum-coverage
// test: these are the only notify* call sites whose `type` is not a literal, so
// the static scan cannot see them (test/unit/notificationTypes.test.js).
module.exports = { applyTransition, emitStageUpdate, ROUND_STAGES, STAGE_NOTIFICATIONS, DEFAULT_NOTIFICATION };
