const { schedule } = require("../utils/cronSchedule");
const InterviewSession = require("../models/InterviewSession");
const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const User = require("../models/User");
const tenantContext = require("../utils/tenantContext");
const { notifyCandidate } = require("../services/notificationService");

const WINDOWS = [
  { field: "reminder24hSent", hoursBefore: 24, toleranceMinutes: 15 },
  { field: "reminder1hSent", hoursBefore: 1, toleranceMinutes: 15 },
];

async function sendDueReminders() {
  const now = Date.now();

  for (const window of WINDOWS) {
    const targetTime = now + window.hoursBefore * 60 * 60 * 1000;
    const rangeStart = new Date(targetTime - window.toleranceMinutes * 60 * 1000);
    const rangeEnd = new Date(targetTime + window.toleranceMinutes * 60 * 1000);

    const sessions = await InterviewSession.find({
      status: "scheduled",
      interviewAt: { $gte: rangeStart, $lte: rangeEnd },
      [window.field]: false,
    }).select("_id");

    for (const { _id } of sessions) {
      // Atomic claim-before-send: only the worker that flips the flag from false→true
      // sends this reminder. Safe even if the reminder job runs on more than one worker,
      // and dedupes the read-then-write race that could double-email at scale.
      const claimed = await InterviewSession.findOneAndUpdate(
        { _id, [window.field]: false },
        { $set: { [window.field]: true } },
        { new: true }
      );
      if (!claimed) continue; // another worker already claimed it

      const candidate = await Candidate.findById(claimed.candidate);
      const job = await Job.findById(claimed.job);
      if (!candidate || !job) continue;

      const applicantUser = await User.findOne({ email: candidate.basicDetails.email, role: "candidate" });

      try {
        await notifyCandidate({
          candidateId: candidate._id,
          userId: applicantUser?._id,
          type: "interview_reminder",
          title: `Interview reminder: ${job.title}`,
          message: `Your interview for ${job.title} is coming up on ${claimed.interviewAt.toLocaleString("en-US")}.`,
          meta: { interviewSessionId: claimed._id, jobId: job._id },
          email: {
            to: candidate.basicDetails.email,
            template: "interviewReminderEmailTemplate",
            args: [candidate, job, claimed],
          },
        });
      } catch (err) {
        console.error("[interviewReminderJob] failed to notify candidate:", err.message);
        // Send failed — release the claim so a later tick retries instead of silently dropping it.
        await InterviewSession.updateOne({ _id: claimed._id }, { $set: { [window.field]: false } });
      }
    }
  }
}

// Abandonment sweep: an interview the candidate started and never finished, whose link has since
// expired, is closed out and its partial work scored — the same score-what-exists guarantee the
// assessment engine makes in assessmentReminderJob.sweepExpired. Without this the session rots at
// in_progress: answers unscored, probes never assessed, and the recruiter's report renders every
// criterion "Untested" as though a finished interview found nothing.
//
// Two guards keep this away from anyone still interviewing:
//   - expiresAt < now       — the portal can no longer be entered on this link at all;
//   - updatedAt ≥ 1h stale  — a live interview writes turns constantly, so any session touched
//                             within the hour is left alone (e.g. someone who started minutes
//                             before expiry and is legitimately still talking).
// finalizeAbandoned re-checks both on the loaded doc, so a recruiter resend racing this sweep
// (which pushes expiresAt into the future) wins and the session is left untouched.
const ABANDON_STALE_MS = 60 * 60 * 1000;
const ABANDON_BATCH = 50;

async function sweepAbandoned() {
  const aiInterviewService = require("../services/aiInterviewService");
  const now = Date.now();
  const due = await InterviewSession.find({
    "aiInterview.status": "in_progress",
    expiresAt: { $lt: new Date(now) },
    updatedAt: { $lt: new Date(now - ABANDON_STALE_MS) },
  }).limit(ABANDON_BATCH);
  for (const session of due) {
    try {
      await aiInterviewService.finalizeAbandoned(session);
    } catch (err) {
      console.error(`[interviewReminderJob] abandonment sweep failed for session ${session._id}:`, err.message);
    }
  }
}

// §3.6: a candidate who closes the tab / walks away is left holding a LIVE room for up to 48h
// under sweepAbandoned above, because that sweep only ever fires once expiresAt has already
// passed. This sweep instead watches presence directly — the client already emits a "left" event
// on tab-close/backgrounding (livekitPresence), it just went nowhere. Runs on its own, tighter,
// cadence (2 minutes, see startInterviewReminderJob) rather than a per-session timer, matching the
// plan's own "either works" framing and avoiding new per-session bookkeeping.
const ABANDON_AFTER_LEAVE_MS = Number(process.env.INTERVIEW_ABANDON_AFTER_LEAVE_MS) || 10 * 60 * 1000;

async function sweepAbandonedByPresence() {
  const aiInterviewService = require("../services/aiInterviewService");
  const now = Date.now();
  // Cheap first-pass filter in Mongo (status + staleness); "is the LAST presence event 'left'" is
  // checked in JS below rather than via a query operator — the array is small (a handful of
  // presence events per session at most) and this mirrors sweepAbandoned's own batch-then-loop
  // shape rather than adding a new index for an array-tail check.
  const candidates = await InterviewSession.find({
    "aiInterview.status": "in_progress",
    updatedAt: { $lt: new Date(now - ABANDON_AFTER_LEAVE_MS) },
  })
    .select("aiInterview.presence aiInterview.status expiresAt updatedAt")
    .limit(ABANDON_BATCH);

  for (const session of candidates) {
    const presence = session.aiInterview?.presence || [];
    const last = presence[presence.length - 1];
    if (!last || last.event !== "left") continue;
    try {
      await aiInterviewService.finalizeAbandoned(session, { becausePresenceLeft: true });
    } catch (err) {
      console.error(`[interviewReminderJob] presence abandonment sweep failed for session ${session._id}:`, err.message);
    }
  }
}

function startInterviewReminderJob() {
  schedule("*/15 * * * *", () => {
    // Runs across all tenants — mark trusted so the tenantScope guardrail doesn't scope it.
    tenantContext
      .runAsSystem(async () => {
        await sendDueReminders();
        await sweepAbandoned();
      })
      .catch((err) => console.error("[interviewReminderJob] run failed:", err.message));
  });
  console.log("[interviewReminderJob] scheduled every 15 minutes");

  schedule("*/2 * * * *", () => {
    tenantContext
      .runAsSystem(() => sweepAbandonedByPresence())
      .catch((err) => console.error("[interviewReminderJob] presence sweep run failed:", err.message));
  });
  console.log("[interviewReminderJob] presence-abandonment sweep scheduled every 2 minutes");
}

module.exports = { startInterviewReminderJob, sweepAbandoned, sweepAbandonedByPresence };
