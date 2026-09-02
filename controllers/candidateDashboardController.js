const mongoose = require("mongoose");
const User = require("../models/User");
const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const Resume = require("../models/Resume");
const InterviewSession = require("../models/InterviewSession");
const AssessmentSession = require("../models/AssessmentSession");
const AssessmentPaper = require("../models/AssessmentPaper");
const Notification = require("../models/Notification");
const CandidateProfile = require("../models/CandidateProfile");
const CandidateDashboard = require("../models/CandidateDashboard");
const { notifyCandidate } = require("../services/notificationService");
const {
  toApplicationView,
  toSessionView,
  toAssessmentSessionView,
} = require("../utils/candidateSerializers");
const { buildNextActions } = require("../utils/candidateNextActions");
const { resendOrRescheduleInterview } = require("../services/interviewInvitationService");
const assessmentService = require("../services/assessmentService");
const { resendAssessment } = assessmentService;
// The interview portal owns the cancelled/expired gate and the session-token
// signing. Importing it (rather than restating either here) is what keeps the
// dashboard's "open my interview" identical to the magic link's.
const { openSessionForOwner } = require("./interviewPortalController");

async function getOrCreateProfile(userId) {
  let profile = await CandidateProfile.findOne({ user: userId });
  if (!profile) {
    profile = await CandidateProfile.create({ user: userId });
  }
  return profile;
}

async function computeProfileCompletion(user, profile, hasResume, applicationCount) {
  let score = 0;
  if (hasResume) score += 25;
  if (user.phone) score += 25;
  if (profile.headline && profile.location && profile.bio && profile.skills.length > 0) score += 25;
  if (applicationCount > 0) score += 25;
  return score;
}

async function getDashboard(req, res) {
  const user = req.user;
  const profile = await getOrCreateProfile(user._id);

  const applications = await Candidate.find({ "basicDetails.email": user.email })
    .populate({ path: "job", select: "title department company", populate: { path: "company", select: "name" } })
    .sort({ createdAt: -1 });
  const applicationIds = applications.map((a) => a._id);

  const resumes = await Resume.find({ candidateEmail: user.email }).sort({ createdAt: -1 }).limit(5);
  const hasResume = resumes.length > 0;

  const completion = await computeProfileCompletion(user, profile, hasResume, applications.length);
  if (completion !== profile.profileCompletionPercent) {
    profile.profileCompletionPercent = completion;
    await profile.save();
  }

  const appliedJobIds = applications.map((a) => a.job?._id).filter(Boolean);
  const recommendedJobs = await Job.find({
    status: "published",
    _id: { $nin: [...appliedJobIds, ...profile.savedJobs] },
    ...(profile.skills.length > 0 ? { requiredSkills: { $in: profile.skills } } : {}),
  })
    .populate("company", "name")
    .sort({ createdAt: -1 })
    .limit(5);

  const savedJobs = await Job.find({ _id: { $in: profile.savedJobs } }).populate("company", "name");

  const notifications = await Notification.find({
    $or: [{ candidate: { $in: applicationIds } }, { user: user._id }],
  })
    .sort({ createdAt: -1 })
    .limit(20);

  const now = new Date();
  const interviewSessions = await InterviewSession.find({ candidate: { $in: applicationIds } })
    .populate("job", "title department")
    .sort({ interviewAt: -1 });

  // Assessments were absent from this payload entirely, so a candidate who had
  // been invited to one saw nothing here and could only discover it by finding
  // the email. Since missing the start window auto-fails the application, that
  // omission decided outcomes.
  const assessmentSessions = await AssessmentSession.find({ candidate: { $in: applicationIds } })
    .populate("job", "title department")
    .sort({ expiresAt: -1 });

  const upcomingInterviews = interviewSessions.filter(
    (s) => (s.status === "scheduled" || s.status === "in_progress") && s.interviewAt >= now
  );
  const aiInterviewHistory = interviewSessions.filter((s) => s.status !== "scheduled" || s.interviewAt < now);

  const assessmentViews = assessmentSessions.map(toAssessmentSessionView);
  const interviewViews = interviewSessions.map(toSessionView);
  const applicationViews = applications.map(toApplicationView);

  // The differentiated part of this screen: for each application, who is it
  // waiting on and by when. Computed server-side from the real session
  // deadlines rather than restated from the stage label, because the stage
  // field lags the sessions — a candidate whose assessment closes in two hours
  // must be told that, not "Assessment Sent".
  const nextActions = buildNextActions({
    applications: applicationViews,
    interviewSessions: interviewViews,
    assessmentSessions: assessmentViews,
    now: now.getTime(),
  });

  // Candidate-facing serializers only (utils/candidateSerializers.js): raw
  // Candidate/InterviewSession docs carry recruiter-only material (evaluation,
  // proctoring risk, tokenHash, resumeText, hostility) that must never reach
  // the applicant's browser.
  const resumeView = (r) => ({ _id: r._id, originalName: r.originalName, createdAt: r.createdAt });
  res.json({
    profile: {
      headline: profile.headline,
      location: profile.location,
      skills: profile.skills,
      bio: profile.bio,
      profileCompletionPercent: profile.profileCompletionPercent,
    },
    resume: {
      hasResume,
      latest: resumes[0] ? resumeView(resumes[0]) : null,
      history: resumes.map(resumeView),
    },
    recommendedJobs,
    savedJobs,
    appliedJobs: applicationViews,
    notifications,
    upcomingInterviews: upcomingInterviews.map(toSessionView),
    aiInterviewHistory: aiInterviewHistory.map(toSessionView),
    assessments: assessmentViews,
    nextActions,
    // Server clock. The UI computes "due in 3 hours" against this rather than
    // the browser's clock, so a candidate with a skewed device is not told they
    // have time they do not have.
    serverTime: now.toISOString(),
  });
}

async function updateProfile(req, res) {
  const { headline, location, skills, bio } = req.body;
  const profile = await getOrCreateProfile(req.user._id);

  if (headline !== undefined) profile.headline = headline;
  if (location !== undefined) profile.location = location;
  if (bio !== undefined) profile.bio = bio;
  if (Array.isArray(skills)) profile.skills = skills;

  await profile.save();

  await notifyCandidate({
    userId: req.user._id,
    type: "profile_updated",
    title: "Profile updated",
    message: "Your candidate profile was updated successfully.",
  });

  res.json(profile);
}

async function toggleSavedJob(req, res) {
  const { jobId } = req.params;
  const job = await Job.findById(jobId);
  // Only published jobs are candidate-visible — don't let a candidate save/probe another
  // tenant's draft/closed posting by id.
  if (!job || job.status !== "published") return res.status(404).json({ error: "Job not found" });

  const profile = await getOrCreateProfile(req.user._id);
  const index = profile.savedJobs.findIndex((id) => String(id) === String(jobId));

  if (index >= 0) {
    profile.savedJobs.splice(index, 1);
  } else {
    profile.savedJobs.push(jobId);
  }

  await profile.save();
  res.json({ saved: index < 0, savedJobs: profile.savedJobs });
}

// Locate an interview/assessment session that belongs to the authenticated
// account, with its candidate and job populated. Shared by every candidate-side
// session route so the ownership rule has exactly one implementation.
//
// Ownership is the application's email matching the account's — a session id
// alone grants nothing. An unknown id, a malformed id and someone else's
// session all return the SAME 404, so probing ids reveals nothing about which
// ones exist.
async function loadOwnSession(req) {
  const { kind, id } = req.params;
  const notFound = () => Object.assign(new Error("Session not found"), { status: 404 });

  if (kind !== "assessment" && kind !== "interview") {
    throw Object.assign(new Error("Unknown session type"), { status: 404 });
  }
  if (!mongoose.isValidObjectId(id)) throw notFound();

  const Model = kind === "assessment" ? AssessmentSession : InterviewSession;
  const session = await Model.findById(id).populate("candidate").populate("job");
  if (!session) throw notFound();
  if (session.candidate?.basicDetails?.email !== req.user.email) throw notFound();
  if (!session.job) throw Object.assign(new Error("Job not found"), { status: 404 });

  return { kind, session, candidate: session.candidate, job: session.job };
}

// POST /candidate-dashboard/sessions/:kind/:id/open
//
// Start (or resume) the candidate's own interview/assessment straight from the
// dashboard, with no emailed link involved.
//
// Why this exists rather than "show them the link": only the token HASH is
// stored, so the magic link is unrecoverable by design — a dashboard could
// never display it, and the only alternative was to mint a NEW token, which
// silently breaks the link already sitting in the candidate's inbox. Instead
// the account itself is treated as a second, equally valid proof of the same
// identity: the mailbox proves you can read the invitation, the login proves
// you own the address it was sent to. Both mint the same session-scoped portal
// token through the same gate (openSessionForOwner / assessmentService.
// openSession), and neither invalidates the other.
//
// The consequence that matters to a candidate: a lost, spam-filtered, or
// dead-hostname invitation no longer costs them the opportunity, and nothing
// they hold stops working because they used the dashboard instead.
async function openOwnSession(req, res) {
  let ctx;
  try {
    ctx = await loadOwnSession(req);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  try {
    if (ctx.kind === "interview") {
      return res.json(await openSessionForOwner(ctx.session));
    }
    const { token, session } = await assessmentService.openSession(ctx.session);
    const paper = await AssessmentPaper.findById(session.paper);
    return res.json({
      token,
      session: assessmentService.dashboardPayload(session, session.candidate, session.job, paper),
    });
  } catch (err) {
    // Cancelled/expired are the gate's own refusals, not faults — surface their
    // wording verbatim so the dashboard says the same thing the portal would.
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}

// POST /candidate-dashboard/sessions/:kind/:id/resend
//
// Self-serve recovery of the candidate's own access link. Until now, resend was
// admin-only for both assessments and interviews, so a candidate who lost the
// invitation email had no route back in and simply timed out — failing on a mail
// problem rather than on merit, with a support ticket as the only remedy.
//
// The security shape matters more than the feature:
//   - Ownership is proved by the application's email matching the authenticated
//     account, so a session id alone grants nothing.
//   - The new link is ONLY ever emailed to the address already on the
//     application. It is never returned in the response, so this endpoint
//     discloses no secret to its caller and is useless to an attacker holding a
//     stolen token but not the mailbox.
//   - Both underlying services already refuse to resend a completed session or
//     to rotate the token out from under a live attempt. Those guards are
//     reused rather than restated, so candidate and recruiter recovery can
//     never drift apart.
async function resendOwnSessionLink(req, res) {
  let kind;
  let session;
  let candidate;
  let job;
  try {
    ({ kind, session, candidate, job } = await loadOwnSession(req));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }

  try {
    if (kind === "assessment") {
      await resendAssessment(session, candidate, job);
    } else {
      await resendOrRescheduleInterview(session, candidate, job, {});
    }
  } catch (err) {
    // Guard rejections are conflicts, not server faults: the session is already
    // completed, or live on a valid link. Surface the service's own wording.
    if (err.status) return res.status(err.status).json({ error: err.message });
    // Anything without an explicit status is a fault, not a conflict. Blanket-
    // 409ing it labelled server bugs as "already in progress" and printed raw
    // internals (e.g. a Mongoose ValidationError) onto the candidate's screen.
    throw err;
  }

  res.json({
    ok: true,
    // Where it went, never what was sent. Confirming the destination is what
    // makes the action trustworthy without disclosing the link.
    sentTo: candidate.basicDetails.email,
    message: "A fresh link is on its way to your email.",
  });
}

async function initializeDashboard(userId, userName, userEmail) {
  let dashboard = await CandidateDashboard.findOne({ user: userId });
  if (!dashboard) {
    dashboard = await CandidateDashboard.create({ user: userId });
  }
  await getOrCreateProfile(userId);

  if (!dashboard.welcomeNotificationSent) {
    await notifyCandidate({
      userId,
      type: "welcome",
      title: "Welcome to your dashboard",
      message: `Hi ${userName}, your candidate dashboard is ready. Upload your resume and start applying to jobs.`,
      email: userEmail ? { to: userEmail, template: "welcomeEmailTemplate", args: [{ name: userName }] } : undefined,
    });
    dashboard.welcomeNotificationSent = true;
    await dashboard.save();
  }

  return dashboard;
}

module.exports = {
  getDashboard,
  updateProfile,
  toggleSavedJob,
  openOwnSession,
  resendOwnSessionLink,
  initializeDashboard,
};
