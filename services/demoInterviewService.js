// Superadmin "demo interview link" generation — lets platform staff hand out a working
// /interview/:token link to a prospect/tester without routing them through a real tenant's
// apply → ATS → invite pipeline. Everything lives under one persistent, lazily-created "demo"
// Company so InterviewSession/Candidate/Job's tenantScope requirement (a real `company`) is
// satisfied without borrowing a real tenant's data. Deliberately separate from
// interviewInvitationService.js, which is the real candidate-invite flow and sends email —
// nothing here should touch that.
const crypto = require("crypto");
const Company = require("../models/Company");
const Job = require("../models/Job");
const Candidate = require("../models/Candidate");
const InterviewSession = require("../models/InterviewSession");
const { hashToken } = require("./interviewInvitationService");
const { candidateLinkBase, normalizeBase } = require("../utils/corsOrigins");

// Same shape as interviewInvitationService's buildInterviewUrl, but able to target a domain
// OTHER than this server's own PUBLIC_CANDIDATE_URL. A superadmin's local dev box is commonly
// configured to build real candidate links against a LAN IP or dev tunnel (for phone-camera QR
// pairing) — a demo link generated there needs to point at the actual public candidate SPA
// instead, without touching that unrelated env config.
function buildDemoInterviewUrl(token, linkBase) {
  const base = linkBase ? normalizeBase(linkBase) : candidateLinkBase();
  return `${base}/interview/${token}`;
}

const DEMO_COMPANY_CODE = "DEMO-INTERNAL";
const DEFAULT_JOB_TITLE = "AI Interview Demo — General Role";
const DEFAULT_JOB_DESCRIPTION =
  "A general-purpose demo role used to showcase the AI interview experience. Not a real position.";
const DEFAULT_EXPIRES_DAYS = 7;

async function getOrCreateDemoCompany() {
  const existing = await Company.findOne({ companyCode: DEMO_COMPANY_CODE });
  if (existing) return existing;
  // status: "active" so the existing "View as tenant" feature (requireActiveCompany) can
  // browse this tenant's candidates/reports read-only without any special-casing.
  return Company.create({
    companyCode: DEMO_COMPANY_CODE,
    name: "AI Interview Demo",
    companySize: "1-10",
    country: "India",
    state: "-",
    city: "-",
    address: "Internal demo tenant - no physical address",
    status: "active",
  });
}

async function getOrCreateDemoJob(company, { title, description } = {}) {
  const jobTitle = (title || "").trim() || DEFAULT_JOB_TITLE;
  const existing = await Job.findOne({ company: company._id, title: jobTitle });
  if (existing) return existing;
  return Job.create({
    company: company._id,
    title: jobTitle,
    description: (description || "").trim() || DEFAULT_JOB_DESCRIPTION,
    status: "published",
  });
}

// Creates a fresh throwaway candidate + interview session and returns a one-time link — only
// the token hash is ever persisted (same posture as resendOrRescheduleInterview), so this is
// the only moment the raw link exists.
async function createDemoInterviewLink({ label, jobTitle, jobDescription, expiresInDays, linkBase } = {}) {
  const company = await getOrCreateDemoCompany();
  const job = await getOrCreateDemoJob(company, { title: jobTitle, description: jobDescription });

  const shortId = crypto.randomBytes(4).toString("hex");
  const candidateName = (label || "").trim() || `Demo Candidate ${shortId}`;
  const candidate = await Candidate.create({
    company: company._id,
    job: job._id,
    basicDetails: { name: candidateName, email: `demo+${shortId}@internal.demo` },
    // Never dereferenced: this candidate skips ATS entirely (created straight at
    // "ats_passed"), so nothing ever tries to read the résumé file behind this path.
    resumePath: "uploads/_demo-placeholder.pdf",
    status: "ats_passed",
    // A real candidate gives this at apply time; here the super admin is standing up the
    // placeholder candidate, so it's granted directly — otherwise the interview would silently
    // run on the no-AI deterministic fallback instead of demonstrating the real thing.
    consent: { aiProcessing: true, dataProcessing: true, at: new Date() },
  });

  const days = Math.min(30, Math.max(1, Number(expiresInDays) || DEFAULT_EXPIRES_DAYS));
  const token = crypto.randomBytes(32).toString("hex");
  const session = await InterviewSession.create({
    candidate: candidate._id,
    job: job._id,
    company: company._id,
    tokenHash: hashToken(token),
    interviewAt: new Date(),
    expiresAt: new Date(Date.now() + days * 24 * 3600 * 1000),
    instructions: job.interviewInstructions,
  });

  return {
    sessionId: String(session._id),
    candidateId: String(candidate._id),
    label: candidateName,
    jobTitle: job.title,
    link: buildDemoInterviewUrl(token, linkBase),
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

async function listDemoInterviewLinks({ page = 1, limit = 25 } = {}) {
  const company = await getOrCreateDemoCompany();
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    InterviewSession.find({ company: company._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("candidate", "basicDetails.name basicDetails.email")
      .populate("job", "title")
      .lean(),
    InterviewSession.countDocuments({ company: company._id }),
  ]);
  return { items, total, page, limit };
}

// Mints a fresh token for an existing demo session (skips the email-sending half of
// resendOrRescheduleInterview — nobody to email here). Returns null when the session doesn't
// exist or doesn't belong to the demo tenant, so the controller can 404.
async function reissueDemoInterviewLink(sessionId, { linkBase } = {}) {
  const company = await getOrCreateDemoCompany();
  const session = await InterviewSession.findOne({ _id: sessionId, company: company._id });
  if (!session) return null;
  if (session.status === "completed" || session.aiInterview?.status === "completed") {
    throw new Error("This demo interview has already been completed and can no longer be reissued");
  }

  const token = crypto.randomBytes(32).toString("hex");
  session.tokenHash = hashToken(token);
  session.sessionEpoch = (session.sessionEpoch || 0) + 1;
  session.interviewAt = new Date();
  session.expiresAt = new Date(Date.now() + DEFAULT_EXPIRES_DAYS * 24 * 3600 * 1000);
  session.status = "scheduled";
  session.accessedAt = undefined;
  await session.save();

  return { sessionId: String(session._id), link: buildDemoInterviewUrl(token, linkBase), expiresAt: session.expiresAt };
}

async function revokeDemoInterviewLink(sessionId) {
  const company = await getOrCreateDemoCompany();
  const session = await InterviewSession.findOne({ _id: sessionId, company: company._id });
  if (!session) return null;
  session.status = "cancelled";
  await session.save();
  return { sessionId: String(session._id), status: session.status };
}

module.exports = {
  getOrCreateDemoCompany,
  getOrCreateDemoJob,
  createDemoInterviewLink,
  listDemoInterviewLinks,
  reissueDemoInterviewLink,
  revokeDemoInterviewLink,
};
