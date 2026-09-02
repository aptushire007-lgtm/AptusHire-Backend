// Assessment reminders (ASSESSMENT-ENGINE-PLAN A4.6) — same cron pattern as the
// interview reminder job: every 15 minutes, 24h + 1h before the START DEADLINE
// of a not-yet-started session, each guarded by an atomic claim-before-send
// flag. Also sweeps sessions past expiry so partial work gets scored (the
// score-what-exists guarantee) instead of rotting at in_progress.

const { schedule } = require("../utils/cronSchedule");
const AssessmentSession = require("../models/AssessmentSession");
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

    const sessions = await AssessmentSession.find({
      status: "scheduled",
      startDeadline: { $gte: rangeStart, $lte: rangeEnd },
      [window.field]: false,
    }).select("_id");

    for (const { _id } of sessions) {
      // Atomic claim-before-send: only the worker that flips the flag sends.
      const claimed = await AssessmentSession.findOneAndUpdate(
        { _id, [window.field]: false },
        { $set: { [window.field]: true } },
        { new: true }
      );
      if (!claimed) continue;

      const candidate = await Candidate.findById(claimed.candidate);
      const job = await Job.findById(claimed.job);
      if (!candidate || !job) continue;
      const applicantUser = await User.findOne({ email: candidate.basicDetails.email, role: "candidate" });

      try {
        await notifyCandidate({
          candidateId: candidate._id,
          userId: applicantUser?._id,
          type: "assessment_reminder",
          title: `Assessment reminder: ${job.title}`,
          message: `Your skills assessment for ${job.title} must be started by ${claimed.startDeadline.toLocaleString("en-US")}.`,
          meta: { assessmentSessionId: claimed._id, jobId: job._id },
          email: {
            to: candidate.basicDetails.email,
            template: "assessmentReminderEmailTemplate",
            args: [candidate, job, claimed],
          },
        });
      } catch (err) {
        console.error("[assessmentReminderJob] failed to notify candidate:", err.message);
        await AssessmentSession.updateOne({ _id: claimed._id }, { $set: { [window.field]: false } });
      }
    }
  }
}

// Expiry sweep: close out sessions whose window ended. In-progress work is
// finalized (scored + labelled completedBy: "expiry"); untouched invitations
// simply expire and never consumed quota.
async function sweepExpired() {
  const assessmentService = require("../services/assessmentService");
  const due = await AssessmentSession.find({
    status: { $in: ["scheduled", "in_progress", "paused"] },
    expiresAt: { $lt: new Date() },
  }).limit(100);
  for (const session of due) {
    try {
      await assessmentService.expireSession(session);
    } catch (err) {
      console.error(`[assessmentReminderJob] expiry sweep failed for session ${session._id}:`, err.message);
    }
  }
}

function startAssessmentReminderJob() {
  schedule("*/15 * * * *", () => {
    tenantContext
      .runAsSystem(async () => {
        await sendDueReminders();
        await sweepExpired();
      })
      .catch((err) => console.error("[assessmentReminderJob] run failed:", err.message));
  });
  console.log("[assessmentReminderJob] scheduled every 15 minutes");
}

module.exports = { startAssessmentReminderJob };
