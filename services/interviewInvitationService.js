const crypto = require("crypto");
const InterviewSession = require("../models/InterviewSession");
const User = require("../models/User");
const { notifyCandidate } = require("./notificationService");
const { candidateLinkBase } = require("../utils/corsOrigins");

const SCHEDULE_DELAY_DAYS = Number(process.env.INTERVIEW_SCHEDULE_DELAY_DAYS) || 3;
const SCHEDULE_HOUR_UTC = Number(process.env.INTERVIEW_SCHEDULE_HOUR_UTC) || 11;
const LINK_VALIDITY_HOURS_AFTER_INTERVIEW = Number(process.env.INTERVIEW_LINK_VALIDITY_HOURS) || 48;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function computeInterviewAt() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + SCHEDULE_DELAY_DAYS);
  date.setUTCHours(SCHEDULE_HOUR_UTC, 0, 0, 0);
  return date;
}

function computeExpiresAt(interviewAt) {
  const expires = new Date(interviewAt);
  expires.setUTCHours(expires.getUTCHours() + LINK_VALIDITY_HOURS_AFTER_INTERVIEW);
  return expires;
}

function buildInterviewUrl(token) {
  // candidateLinkBase: PUBLIC_CANDIDATE_URL wins over the CORS origin list, so
  // an emailed link can never be built from a dev tunnel hostname that happens
  // to be listed first for CORS purposes (trailing slashes stripped — a double
  // slash breaks the SPA route match and renders a blank page).
  return `${candidateLinkBase()}/interview/${token}`;
}

// §3.1: a candidate can now have more than one InterviewSession (one per attempt), so every call
// site that used to do `InterviewSession.findOne({ candidate })` and get the only possible match
// needs to say which one it means. Absent an explicit attempt, "latest" is always the right default
// — it's what every existing caller actually wanted before attempts existed.
//
// Deliberately NOT `async` — returns the Mongoose Query itself (same as InterviewSession.findOne
// would), so callers that need `.select()`/`.populate()` can still chain onto it exactly as before;
// callers that just want the document can `await` it directly since a Query is thenable.
function findLatestSession(candidateId, company) {
  const filter = { candidate: candidateId };
  if (company) filter.company = company;
  return InterviewSession.findOne(filter).sort({ attempt: -1 });
}

// Idempotent by default: if a session already exists for this candidate (e.g. ATS was re-run after
// already passing once), we don't mint a new token or resend the email — that would invalidate a
// link the candidate may already have. Pass `{ newAttempt: true }` for an explicit second (or Nth)
// interview — the plan's own defect fix, so a redo no longer overwrites the first attempt's report.
async function createInterviewSessionIfNeeded(candidate, job, { newAttempt = false } = {}) {
  const existing = await findLatestSession(candidate._id, job.company);
  if (existing && !newAttempt) return existing;

  const token = crypto.randomBytes(32).toString("hex");
  const interviewAt = computeInterviewAt();
  const expiresAt = computeExpiresAt(interviewAt);
  const attempt = newAttempt ? (existing?.attempt || 0) + 1 : 1;

  const session = await InterviewSession.create({
    candidate: candidate._id,
    attempt,
    job: job._id,
    company: job.company,
    tokenHash: hashToken(token),
    interviewAt,
    expiresAt,
    instructions: job.interviewInstructions,
  });

  const interviewUrl = buildInterviewUrl(token);
  const sessionWithUrl = { ...session.toObject(), interviewUrl };

  const applicantUser = await User.findOne({ email: candidate.basicDetails.email, role: "candidate" });
  await notifyCandidate({
    candidateId: candidate._id,
    userId: applicantUser?._id,
    type: "interview_invite",
    title: `Interview invitation for ${job.title}`,
    message: `You're invited to an interview — take it any time before ${expiresAt.toLocaleString("en-US", { timeZone: process.env.MAIL_TIMEZONE || "Asia/Kolkata", timeZoneName: "short" })}. Check your email for the interview link and instructions.`,
    meta: { interviewSessionId: session._id, jobId: job._id },
    email: {
      to: candidate.basicDetails.email,
      template: "interviewInvitationEmailTemplate",
      args: [candidate, job, sessionWithUrl],
    },
  });

  return session;
}

// Resend an interview link, or reschedule it to a new time. Because we only ever
// store the token *hash* (never the raw token), the original link can't be
// reconstructed — so both operations mint a *fresh* token. That is also the safer
// default: any previously-shared/expired link stops working. Pass `interviewAt` to
// reschedule; omit it to resend the same slot with a refreshed validity window.
// Unlike createInterviewSessionIfNeeded (which is idempotent on auto-apply), this is
// an explicit recruiter action and always rotates the token and re-emails.
//
// `force` overrides the live-interview guard below — an explicit "issue a new link
// right now, I understand this ends the candidate's current session" from the
// recruiter, surfaced by the admin UI as a confirmation prompt, not a default.
async function resendOrRescheduleInterview(session, candidate, job, { interviewAt, force = false } = {}) {
  // A completed interview is final — never re-issue a link for it, forced or not.
  if (session.status === "completed" || session.aiInterview?.status === "completed") {
    throw new Error("This interview has already been completed and can no longer be resent or rescheduled");
  }
  // A *live* in-progress attempt must not have its token rotated out from under
  // the candidate BY DEFAULT. But an in-progress interview whose link has EXPIRED is a
  // locked-out candidate, not a live attempt — re-issuing the link is the only
  // recovery (startInterview resumes the existing transcript, so nothing the
  // candidate answered is lost). `force` lets a recruiter override the default and
  // deliberately end the live session anyway (e.g. wrong candidate is on the call,
  // link was shared with the wrong person, session is stuck).
  const linkExpired = session.status === "expired" || (session.expiresAt && session.expiresAt.getTime() < Date.now());
  const inProgress = session.status === "in_progress" || session.aiInterview?.status === "in_progress";
  if (inProgress && !linkExpired && !force) {
    throw new Error(
      "This interview is in progress on a valid link — resending now would cut the candidate off. Re-issue it after the link expires, or force a new link if you're sure."
    );
  }

  const nextInterviewAt = interviewAt ? new Date(interviewAt) : session.interviewAt;
  if (Number.isNaN(nextInterviewAt.getTime())) {
    throw new Error("Invalid interview date/time");
  }

  const token = crypto.randomBytes(32).toString("hex");
  session.tokenHash = hashToken(token);
  // Kills any portal JWT already issued from the OLD link (candidateAuth.js checks this
  // against the token's embedded epoch) — not just future logins with the old raw URL.
  session.sessionEpoch = (session.sessionEpoch || 0) + 1;
  session.interviewAt = nextInterviewAt;
  // Anchoring validity to nextInterviewAt is only safe when that slot is still
  // ahead of us. A resend (interviewAt omitted) keeps the OLD session.interviewAt,
  // which for a long-overdue interview can already be more than the validity
  // window in the past — computeExpiresAt would then hand back a link that is
  // already dead on arrival, silently breaking "resend" 's promise of a working
  // link. Anchor to now instead whenever that would happen.
  const anchoredExpiresAt = computeExpiresAt(nextInterviewAt);
  session.expiresAt = anchoredExpiresAt.getTime() > Date.now() ? anchoredExpiresAt : computeExpiresAt(new Date());
  session.status = "scheduled";
  session.accessedAt = undefined; // fresh link — clear the "already opened" marker
  // Let the reminder cron fire again for the (possibly new) slot.
  session.reminder24hSent = false;
  session.reminder1hSent = false;
  await session.save();

  const interviewUrl = buildInterviewUrl(token);
  const sessionWithUrl = { ...session.toObject(), interviewUrl };
  const rescheduled = Boolean(interviewAt);

  const applicantUser = await User.findOne({ email: candidate.basicDetails.email, role: "candidate" });
  await notifyCandidate({
    candidateId: candidate._id,
    userId: applicantUser?._id,
    type: "interview_invite",
    title: rescheduled ? `Interview rescheduled for ${job.title}` : `Your interview link for ${job.title}`,
    message: rescheduled
      ? `Your interview has been rescheduled to ${nextInterviewAt.toLocaleString("en-US")}. Check your email for the updated interview link.`
      : `Here is your interview link for ${job.title}. Your interview is scheduled for ${nextInterviewAt.toLocaleString("en-US")}. Check your email for the link and instructions.`,
    meta: { interviewSessionId: session._id, jobId: job._id },
    email: {
      to: candidate.basicDetails.email,
      template: "interviewInvitationEmailTemplate",
      args: [candidate, job, sessionWithUrl],
    },
  });

  // interviewUrl is returned so the caller (recruiter) can copy/share the link directly —
  // it can't be reconstructed later since only the token hash is persisted. forcedLiveOverride
  // tells the controller whether this call actually ended a live session, for audit logging.
  return { session, interviewUrl, forcedLiveOverride: inProgress && !linkExpired && force };
}

module.exports = {
  createInterviewSessionIfNeeded,
  resendOrRescheduleInterview,
  hashToken,
  buildInterviewUrl,
  findLatestSession,
};
