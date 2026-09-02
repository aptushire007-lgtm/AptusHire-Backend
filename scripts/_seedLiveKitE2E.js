// Seeds a ready-to-run LiveKit interview session for the LK-2 end-to-end probe
// (agent-worker/interview_probe.py), and prints the magic-link token the probe
// exchanges for a portal JWT.
//
//   npm run seed:demo                      # once — the demo company must exist
//   node scripts/_seedLiveKitE2E.js        # prints {sessionId, token}
//
// Mirrors the real apply→ATS→invite flow's outputs without the resume upload and
// email: same InterviewSession shape as interviewInvitationService (verified
// against createInterviewSessionIfNeeded), voice + AI-processing consent
// pre-granted, and the demo tenant flipped to voiceMode "livekit". LOCAL DEV
// ONLY — never run against production data.

require("dotenv").config();
require("../config/dnsOverride").applyDnsOverride();
const crypto = require("crypto");
const mongoose = require("mongoose");

const User = require("../models/User");
const Job = require("../models/Job");
const Candidate = require("../models/Candidate");
const InterviewSession = require("../models/InterviewSession");
const CompanySettings = require("../models/CompanySettings");
const { hashToken } = require("../services/interviewInvitationService");
const { generateJobSlug } = require("../utils/slug");

const JOB_TITLE = "Backend Engineer (LK E2E)";
// Unique per run: an earlier version reused one candidate and DELETED their previous session
// each seed — which destroyed a completed interview before its finalization could be inspected.
// Sessions under test must never share a candidate.
const PROBE_EMAIL = `lk-probe-${Date.now()}@demo.test`;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const admin = await User.findOne({ email: "admin@demo.test", role: "admin" });
  if (!admin?.company) throw new Error("Demo company not found — run `npm run seed:demo` first.");
  const company = admin.company;

  // The tenant flip that turns the pipeline on for exactly this company.
  await CompanySettings.updateOne({ company }, { $set: { "ai.voiceMode": "livekit" } }, { upsert: true });

  let job = await Job.findOne({ company, title: JOB_TITLE });
  if (!job) {
    job = await Job.create({
      company,
      title: JOB_TITLE,
      slug: generateJobSlug(JOB_TITLE),
      description:
        "Backend role used by the LiveKit e2e probe. Node.js services, Kubernetes deployments, " +
        "PostgreSQL data modelling, REST API design.",
      requiredSkills: ["node.js", "kubernetes", "postgresql", "rest apis"],
      status: "published",
    });
  }

  let candidate = await Candidate.findOne({ company, "basicDetails.email": PROBE_EMAIL });
  if (!candidate) {
    candidate = await Candidate.create({
      company,
      job: job._id,
      basicDetails: { name: "Lk Probe", email: PROBE_EMAIL, phone: "+917777777777" },
      consent: { aiProcessing: true },
      // Past ATS, pre-interview — the stage a real invitee sits at. The resumePath is a
      // placeholder nothing dereferences unless ATS is re-run, which this flow never does.
      status: "ats_passed",
      resumePath: "uploads/_lk-probe-placeholder.pdf",
    });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const session = await InterviewSession.create({
    candidate: candidate._id,
    job: job._id,
    company,
    tokenHash: hashToken(token),
    interviewAt: new Date(),
    expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
    voiceConsent: { given: true, at: new Date() },
  });

  console.log(JSON.stringify({ sessionId: String(session._id), token }));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
