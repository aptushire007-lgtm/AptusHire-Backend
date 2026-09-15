// Auto-apply sweep — hourly. A candidate who has turned on "Auto-apply to my
// strong matches" (JobListings.jsx AutoApplyModal) gets submitted, on their
// behalf, to every new Strong (and optionally Good) match they haven't already
// applied to — using the exact same application-creation core and post-apply
// pipeline (notifications + ATS screening) a human's own "Apply" click uses,
// so an auto-submitted application is indistinguishable downstream from a
// manually submitted one. See createApplicationForCandidate/runPostApplyPipeline
// in controllers/candidateController.js — nothing about the apply flow itself
// is reimplemented here.
//
// Runs across every tenant, so — like assessmentReminderJob/subscriptionExpiryJob
// — the whole sweep executes inside tenantContext.runAsSystem(): the
// tenantScope Mongoose plugin otherwise either scopes queries to nothing or
// hard-fails in strict mode outside a request's own tenant context.

const { schedule } = require("../utils/cronSchedule");
const tenantContext = require("../utils/tenantContext");
const CandidateProfile = require("../models/CandidateProfile");
const ResumeVersion = require("../models/ResumeVersion");
const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const User = require("../models/User");
const { rankRecommendedJobs } = require("../utils/candidateRecommendations");
const { createApplicationForCandidate, runPostApplyPipeline } = require("../controllers/candidateController");

// Mirrors the frontend's own bucketing (JobListings.jsx getMatchLabel): a
// candidate's rank position within a wider pool than the dashboard's top-5,
// since "Good match" is structurally unreachable inside a 5-item list.
const STRONG_MATCH_LIMIT = 5;
const GOOD_MATCH_LIMIT = 15;
const POOL_SIZE = 200;

async function runAutoApplyForCandidate(profile) {
  const auto = profile.autoApply;
  if (!auto?.enabled || !auto.resumeVersion) return;

  const user = await User.findById(profile.user);
  if (!user || user.role !== "candidate") return;

  // The chosen résumé may have been archived/deleted since auto-apply was
  // turned on — nothing to submit with, so skip quietly rather than error
  // every hour until the candidate notices and picks a new one.
  const resumeVersion = await ResumeVersion.findOne({
    _id: auto.resumeVersion,
    user: user._id,
    isArchived: false,
  });
  if (!resumeVersion) return;

  const email = String(user.email || "").toLowerCase().trim();

  const applications = await Candidate.find({
    $or: [{ candidateUser: user._id }, { "basicDetails.email": email }],
  }).select("job");
  const appliedJobIds = applications.map((a) => a.job).filter(Boolean);

  const pool = await Job.find({
    status: "published",
    _id: { $nin: [...appliedJobIds, ...(profile.dismissedJobs || [])] },
  })
    .select("-numberOfOpenings -filledOpenings -pendingOffers -autoClosedAt -closureReason")
    .sort({ createdAt: -1 })
    .limit(POOL_SIZE)
    .lean();

  const ranked = rankRecommendedJobs(pool, {
    profile,
    resumes: [resumeVersion],
    now: Date.now(),
    limit: auto.includeGoodMatches ? GOOD_MATCH_LIMIT : STRONG_MATCH_LIMIT,
  });
  if (ranked.length === 0) return;

  for (const rankedJob of ranked) {
    // Re-fetch fresh rather than trust the pool snapshot: the pool query and
    // this write can straddle a job being filled/closed, or a manual
    // application landing in the gap — createApplicationForCandidate's own
    // duplicate check catches the latter, this catches the former.
    const job = await Job.findById(rankedJob._id);
    if (!job || job.status !== "published") continue;

    try {
      const candidate = await createApplicationForCandidate({
        job,
        email,
        candidateUser: user._id,
        resumeRef: {
          size: resumeVersion.sizeBytes,
          originalName: resumeVersion.label,
          mimeType: resumeVersion.mimeType,
          resume: { filePath: resumeVersion.filePath, autofill: resumeVersion.autofill },
          resumeVersionId: resumeVersion._id,
          versionDoc: resumeVersion,
        },
        formFields: {
          name: user.name,
          phone: profile.personal?.phone,
          location: profile.personal?.locationCity || profile.location,
        },
        consent: {
          aiProcessing: profile.preferences?.aiScreeningConsent !== false,
          dataProcessing: profile.preferences?.dataRetentionConsent !== false,
        },
        source: { channel: "auto_apply", capturedAt: new Date() },
      });

      await runPostApplyPipeline(candidate, job);
    } catch (err) {
      // 409 = already applied — a lost race with a manual apply, not a fault.
      if (err.status === 409) continue;
      console.error(`[autoApplyJob] failed to auto-apply candidate ${user._id} to job ${job._id}:`, err.message);
    }
  }
}

async function runAutoApplySweep() {
  const profiles = await CandidateProfile.find({ "autoApply.enabled": true });
  for (const profile of profiles) {
    try {
      await runAutoApplyForCandidate(profile);
    } catch (err) {
      console.error(`[autoApplyJob] sweep failed for profile ${profile._id}:`, err.message);
    }
    profile.autoApply.lastRunAt = new Date();
    await profile.save().catch((err) => console.error(`[autoApplyJob] failed to stamp lastRunAt for profile ${profile._id}:`, err.message));
  }
}

function startAutoApplyJob() {
  schedule("0 * * * *", () => {
    tenantContext.runAsSystem(runAutoApplySweep).catch((err) => console.error("[autoApplyJob] run failed:", err.message));
  });
  console.log("[autoApplyJob] scheduled hourly");
}

module.exports = { startAutoApplyJob, runAutoApplySweep };
