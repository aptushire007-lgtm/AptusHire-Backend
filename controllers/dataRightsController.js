// DPDP data-principal rights (plan §5.2). The data fiduciary (the tenant/company) acts
// on requests from data principals (candidates): access/portability (export), erasure
// (right to be forgotten), and a public grievance/DPO contact. Erasure and export are
// admin-initiated and tenant-scoped; the DPO lookup is public so a candidate can find who
// to contact before they have (or after they lose) any account.

const mongoose = require("mongoose");
const Candidate = require("../models/Candidate");
const InterviewSession = require("../models/InterviewSession");
const CompanySettings = require("../models/CompanySettings");
const Company = require("../models/Company");
const { stageLabel } = require("../utils/pipeline");
const { purgeCandidateArtifacts } = require("../services/candidatePurgeService");
const { writeAuditLog } = require("../middleware/auditLog");

// A legally-complete "everything we hold about you" bundle for DPDP access/portability.
// Superset of the recruiter-facing /candidates/:id/export — adds the consent record, the
// full interview transcript + evaluation, and resume metadata. Tenant-scoped; downloadable.
async function exportCandidateData(req, res) {
  const candidate = await Candidate.findOne({ _id: req.params.id, company: req.user.company }).populate(
    "job",
    "title department"
  );
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });

  // §3.1: a candidate can have more than one interview attempt now — a "legally-complete"
  // DPDP bundle must disclose all of them, not just the latest.
  const sessions = await InterviewSession.find({ candidate: candidate._id, company: req.user.company }).sort({ attempt: 1 });

  const payload = {
    exportedAt: new Date().toISOString(),
    purpose: "DPDP data-principal access / portability request",
    profile: {
      name: candidate.basicDetails?.name,
      email: candidate.basicDetails?.email,
      phone: candidate.basicDetails?.phone,
      location: candidate.basicDetails?.location,
      linkedinUrl: candidate.basicDetails?.linkedinUrl,
      portfolioUrl: candidate.basicDetails?.portfolioUrl,
    },
    application: {
      job: candidate.job?.title,
      department: candidate.job?.department,
      currentStage: stageLabel(candidate.status),
      appliedAt: candidate.createdAt,
    },
    consent: candidate.consent || null,
    resume: { originalName: candidate.resumeOriginalName, extractedText: candidate.resumeText || "" },
    // Which parts of this application a machine wrote. A data-principal request
    // that returned the profile without disclosing that an extraction engine
    // drafted some of it would be answering the wrong question: the person is
    // entitled to know which of their "own" statements they authored and which
    // they approved. Each entry's `provenance` carries the résumé span it came from.
    autofill: candidate.autofill?.used ? candidate.autofill : null,
    skills: candidate.skills,
    skillProvenance: candidate.skillProvenance,
    experience: candidate.experience,
    education: candidate.education,
    projects: candidate.projects,
    certificates: candidate.certificates,
    ats: candidate.ats,
    offer: candidate.offer,
    timeline: (candidate.stageHistory || []).map((h) => ({
      stage: stageLabel(h.stage),
      by: h.by,
      note: h.note,
      at: h.at,
    })),
    interviews: sessions
      .filter((s) => s.aiInterview && s.aiInterview.status !== "not_started")
      .map((s) => ({
        attempt: s.attempt,
        status: s.aiInterview.status,
        engine: s.aiInterview.engine,
        startedAt: s.aiInterview.startedAt,
        completedAt: s.aiInterview.completedAt,
        transcript: (s.aiInterview.turns || []).map((t) => ({ role: t.role, kind: t.kind, text: t.text, at: t.at })),
        evaluation: s.aiInterview.evaluation || null,
      })),
  };

  // Explicit audit — the middleware skips GETs, but a DPDP data-access request must be
  // recorded (who accessed which candidate's full data, and when).
  writeAuditLog({
    req,
    action: "candidate.export",
    resourceType: "Candidate",
    resourceId: candidate._id,
    statusCode: 200,
  });

  const safeName = String(candidate.basicDetails?.name || "candidate").replace(/[^a-z0-9]+/gi, "_");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}_dpdp_export.json"`);
  res.send(JSON.stringify(payload, null, 2));
}

// DPDP erasure (right to be forgotten). Hard-deletes the candidate and ALL artifacts via
// the shared purge service (resume, identity photo, interview transcript, queue, usage).
// Irreversible — audit-logged with the actor + reason before the record disappears.
async function eraseCandidateData(req, res) {
  const candidate = await Candidate.findOne({ _id: req.params.id, company: req.user.company }).select(
    "_id company resumePath basicDetails"
  );
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });

  const erasedEmail = candidate.basicDetails?.email;
  const summary = await purgeCandidateArtifacts(candidate);

  // The candidate row is gone after purge, so stamp the audit detail here (the middleware
  // records the request outcome; this captures WHAT was erased and why).
  req.audit = {
    action: "candidate.erase",
    resourceType: "Candidate",
    resourceId: candidate._id,
    meta: { reason: req.body?.reason || "data-principal erasure request", erasedEmail, ...summary },
  };

  res.json({ message: "Candidate data erased", candidateId: candidate._id, summary });
}

// Public grievance / Data-Protection Officer contact for a company, so a candidate can
// exercise their rights or raise a complaint. Returns only the DPO contact + retention
// window — never any candidate or internal tenant data.
async function getDpoContact(req, res) {
  const { companyId } = req.params;
  if (!mongoose.isValidObjectId(companyId)) return res.status(404).json({ error: "Not found" });

  const company = await Company.findById(companyId).select("name status");
  if (!company) return res.status(404).json({ error: "Not found" });

  const settings = await CompanySettings.findOne({ company: companyId }).select("compliance");
  const dpo = settings?.compliance?.dpo || {};

  res.json({
    company: company.name,
    dpo: { name: dpo.name || null, email: dpo.email || null, phone: dpo.phone || null },
    retentionDays: settings?.compliance?.retentionDays || null,
    notice:
      "You may request access, correction, or erasure of your personal data, or raise a grievance, by contacting the Data-Protection Officer above.",
  });
}

module.exports = { exportCandidateData, eraseCandidateData, getDpoContact };
