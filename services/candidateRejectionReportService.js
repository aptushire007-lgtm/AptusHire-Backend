const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const AtsAssessment = require("../models/AtsAssessment");
const AssessmentSession = require("../models/AssessmentSession");
const InterviewSession = require("../models/InterviewSession");
const CandidateRejectionReport = require("../models/CandidateRejectionReport");

const STATUS_LABELS = {
  strong: "Strong Match",
  match: "Match",
  partial: "Partial Match",
  weak: "Weak Match",
  absent: "No Evidence",
  contradicted: "Contradicted / Insufficient Evidence",
  not_assessed: "Not Assessed",
};

function text(value) {
  return String(value || "").trim();
}

function termsForJob(job) {
  const terms = [...(job.requiredSkills || []), ...(job.preferredSkills || [])].map(text).filter(Boolean);
  const source = `${job.requirements || ""}\n${job.description || ""}`;
  for (const match of source.matchAll(/\b[A-Za-z][A-Za-z0-9+#. -]{1,40}\b/g)) {
    const value = match[0].trim();
    if (/\b(?:experience|knowledge|ability|proficiency|familiarity|certification)\b/i.test(value)) terms.push(value);
  }
  return [...new Map(terms.map((term) => [term.toLowerCase(), term])).values()].slice(0, 50);
}

function resumeText(candidate) {
  return [
    candidate.resumeText,
    ...(candidate.skills || []),
    ...(candidate.experience || []).flatMap((item) => [item.title, item.company, item.description]),
    ...(candidate.projects || []).flatMap((item) => [item.name, item.description, ...(item.technologies || [])]),
    ...(candidate.education || []).flatMap((item) => [item.degree, item.fieldOfStudy, item.institution]),
    ...(candidate.certificates || []).flatMap((item) => [item.name, item.issuer]),
  ].map(text).join(" ");
}

function statusForRequirement(requirement, candidate, findings, assessmentByCriterion, interviewTopics) {
  const key = requirement.toLowerCase();
  const resumeMatch = resumeText(candidate).toLowerCase().includes(key);
  const finding = findings.find((item) => item.label.toLowerCase().includes(key) || key.includes(item.label.toLowerCase()));
  const assessment = finding ? assessmentByCriterion.get(finding.criterionId) : null;
  const interview = interviewTopics.some((topic) => topic.includes(key));
  if (finding?.status === "contradicted") return { status: "contradicted", evidence: "ATS evidence marked this requirement contradicted." };
  if (assessment && assessment.score < 50) return { status: "weak", evidence: `Assessment performance was ${assessment.score}%.` };
  if (resumeMatch && (assessment || interview)) return { status: "match", evidence: "Resume evidence was also assessed or discussed." };
  if (resumeMatch) return { status: "partial", evidence: "The requirement appears in the submitted resume, but corroborating performance evidence is limited." };
  return { status: "absent", evidence: "No supporting evidence was found in the submitted resume or mapped evidence." };
}

function scoreFromAssessment(session) {
  const result = session?.result;
  if (!result?.scoredAt || !result.totalItems) return null;
  return Math.round((Number(result.totalCorrect || 0) / Number(result.totalItems)) * 100);
}

function buildReportData({ candidate, job, ats, assessmentSession, interviewSession, evidenceAssessment }) {
  const findings = evidenceAssessment?.criterionFindings || [];
  const assessmentByCriterion = new Map((assessmentSession?.result?.perCriterion || []).map((item) => [
    item.criterionId,
    { score: item.itemCount ? Math.round((item.correctCount / item.itemCount) * 100) : null },
  ]));
  const interview = interviewSession?.aiInterview;
  const interviewScore = Number.isFinite(Number(interview?.evaluation?.overallScore)) ? Number(interview.evaluation.overallScore) : null;
  const interviewTopics = (interview?.turns || []).map((turn) => text(turn.topic).toLowerCase()).filter(Boolean);
  const requirements = termsForJob(job);
  const requirementAnalysis = requirements.map((requirement) => {
    const result = statusForRequirement(requirement, candidate, findings, assessmentByCriterion, interviewTopics);
    return { requirement, resumeEvidence: resumeText(candidate).toLowerCase().includes(requirement.toLowerCase()) ? "Present" : "Insufficient evidence", status: STATUS_LABELS[result.status], evidence: result.evidence, importance: (job.requiredSkills || []).some((skill) => skill.toLowerCase() === requirement.toLowerCase()) ? "High" : "Medium" };
  });
  const weakRequirements = requirementAnalysis.filter((item) => ["Weak Match", "No Evidence", "Contradicted / Insufficient Evidence"].includes(item.status));
  const reasons = [];
  if (ats?.overallScore != null && ats.threshold != null && Number(ats.overallScore) < Number(ats.threshold)) reasons.push({ reason: "ATS alignment score was below the configured threshold.", severity: "Critical", evidence: `ATS score ${ats.overallScore}%; configured threshold ${ats.threshold}%.`, requirement: "Overall ATS threshold" });
  for (const item of weakRequirements.slice(0, 5)) reasons.push({ reason: `${item.requirement} was not sufficiently demonstrated.`, severity: item.importance === "High" ? "High" : "Medium", evidence: item.evidence, requirement: item.requirement });
  reasons.sort((a, b) => ({ Critical: 0, High: 1, Medium: 2, Low: 3 }[a.severity] - ({ Critical: 0, High: 1, Medium: 2, Low: 3 }[b.severity])));
  const gaps = weakRequirements.map((item) => ({ skill: item.requirement, category: "Technical or role requirement", evidence: item.evidence, expected: "Evidence meeting the job requirement", distinction: item.status === "No Evidence" ? "Not demonstrated; this does not establish that the candidate lacks the skill." : item.status }));
  const overall = { jdAlignment: ats?.overallScore ?? null, resumeAlignment: requirementAnalysis.length ? Math.round((requirementAnalysis.filter((item) => ["Strong Match", "Match"].includes(item.status)).length / requirementAnalysis.length) * 100) : null, assessment: scoreFromAssessment(assessmentSession), interview: interviewScore, evidenceConfidence: evidenceAssessment?.confidence != null ? Math.round(Number(evidenceAssessment.confidence) * 100) : null, roleReadiness: ats?.overallScore ?? null };
  const availableSources = [ats, assessmentSession?.result?.scoredAt ? assessmentSession : null, interview?.evaluation?.overallScore != null ? interview : null].filter(Boolean).length;
  const summary = reasons.length ? `The application was not selected because ${reasons[0].reason.toLowerCase()} ${reasons[0].evidence}` : "The application was not selected, but the available evidence does not identify a specific additional rejection reason.";
  return {
    summary,
    overallAlignment: overall,
    rejectionReasons: reasons,
    requirementAnalysis,
    assessmentAnalysis: assessmentSession ? { status: scoreFromAssessment(assessmentSession) == null ? "Not Assessed" : "Assessed", overallScore: scoreFromAssessment(assessmentSession), perCriterion: assessmentSession.result?.perCriterion || [], completedBy: assessmentSession.result?.completedBy || null } : { status: "Not Assessed", note: "No completed assessment result is available." },
    interviewAnalysis: interview ? { status: interviewScore == null ? "Not Assessed" : "Assessed", overallScore: interviewScore, competencies: { technicalKnowledge: interview.evaluation?.technicalKnowledge ?? null, communication: interview.evaluation?.communication ?? null, problemSolving: interview.evaluation?.problemSolving ?? null }, strengths: interview.evaluation?.strengths || [], weaknesses: interview.evaluation?.weaknesses || [] } : { status: "Not Assessed", note: "No interview evidence is available." },
    claimValidation: (candidate.skills || []).slice(0, 50).map((claim) => ({ claim, resumeEvidence: resumeText(candidate).toLowerCase().includes(claim.toLowerCase()) ? "Present" : "Not found", assessmentEvidence: assessmentSession ? "Available only where mapped by the assessment" : "Not Assessed", interviewEvidence: interview ? "Available only where discussed" : "Not Assessed", status: "Insufficient Evidence", confidence: "Medium" })),
    skillGaps: gaps,
    areasOfImprovement: gaps.map((gap) => ({ skill: gap.skill, currentEvidence: gap.evidence, expectedLevel: gap.expected, gap: gap.distinction, whyItMatters: "This requirement is part of the role alignment evidence.", recommendedPractice: `Build and document a project demonstrating ${gap.skill}.` })),
    improvementPlan: gaps.length ? [{ period: "Immediate - 1 to 2 weeks", actions: gaps.slice(0, 3).map((gap) => `Study and practice ${gap.skill}.`) }, { period: "Short term - 1 month", actions: gaps.slice(0, 2).map((gap) => `Complete a measurable project using ${gap.skill}.`) }, { period: "Medium term - 2 to 3 months", actions: ["Reassess against the role requirements with evidence from projects and assessments."] }] : [],
    reapplicationReadiness: { current: reasons.length ? "Not Ready" : "Review Required", requiredImprovements: gaps.map((gap) => gap.skill), condition: gaps.length ? "Reapply after the identified requirements meet the configured assessment and evidence thresholds." : "The available data does not support a specific readiness condition." },
    evidence: [{ source: "Candidate.ats", reference: String(candidate._id) }, { source: "Job", reference: String(job._id) }, ...(assessmentSession ? [{ source: "AssessmentSession", reference: String(assessmentSession._id) }] : []), ...(interviewSession ? [{ source: "InterviewSession", reference: String(interviewSession._id) }] : [])],
    confidence: availableSources >= 3 ? "High" : availableSources >= 2 ? "Medium" : "Low",
  };
}

async function generateCandidateRejectionReport(candidateId, { companyId, force = false } = {}) {
  const candidate = await Candidate.findOne({ _id: candidateId, company: companyId }).lean();
  if (!candidate) return null;
  const job = await Job.findOne({ _id: candidate.job, company: companyId }).lean();
  if (!job) return null;
  const [ats, evidenceAssessment, assessmentSession, interviewSession, latest] = await Promise.all([
    Promise.resolve(candidate.ats || null),
    AtsAssessment.findOne({ candidate: candidate._id, company: companyId }).sort({ createdAt: -1 }).lean(),
    AssessmentSession.findOne({ candidate: candidate._id, company: companyId, status: { $in: ["completed", "expired"] } }).sort({ createdAt: -1 }).lean(),
    InterviewSession.findOne({ candidate: candidate._id, company: companyId }).sort({ createdAt: -1 }).lean(),
    CandidateRejectionReport.findOne({ candidate: candidate._id, company: companyId }).sort({ reportVersion: -1 }).lean(),
  ]);
  if (latest && !force) return latest;
  const data = buildReportData({ candidate, job, ats, assessmentSession, interviewSession, evidenceAssessment });
  return CandidateRejectionReport.create({ candidate: candidate._id, applicationId: candidate._id, job: job._id, company: companyId, reportVersion: (latest?.reportVersion || 0) + 1, atsVersion: evidenceAssessment?.scorerVersion || candidate.ats?.engine, ...data });
}

async function getCandidateRejectionReport(candidateId, companyId) {
  return CandidateRejectionReport.findOne({ candidate: candidateId, company: companyId }).sort({ reportVersion: -1 }).lean();
}

module.exports = { generateCandidateRejectionReport, getCandidateRejectionReport, buildReportData };