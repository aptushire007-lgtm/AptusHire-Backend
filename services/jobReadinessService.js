const Job = require("../models/Job");
const RoleRubric = require("../models/RoleRubric");
const QuestionSet = require("../models/QuestionSet");
const AssessmentPaper = require("../models/AssessmentPaper");
const SetupDraft = require("../models/SetupDraft");
const CompanySettings = require("../models/CompanySettings");
const { sourceHashOf } = require("../utils/rubricEngine");
const { sourceHashOf: questionSourceHash } = require("./questionSetService");
const capacity = require("./jobCapacityService");
const { digest, problem } = require("../utils/setupDraft");
const { isValidObjectId } = require("mongoose");

function assess({ job, rubric, questions, paper, settings, filledOpenings = 0, draft }) {
  const base = `/jobs/${job._id}`;
  const hasAssessment = ["auto", "manual"].includes(job.assessmentPolicy);
  const rubricReady = rubric?.status === "approved" && rubric.sourceHash === sourceHashOf(job);
  const questionReady = questions?.status === "approved" && (!questions.sourceHash || questions.sourceHash === questionSourceHash(job, rubric)) && questions.questions?.length > 0;
  const paperReady = paper?.status === "approved" && paper.sections?.length > 0 && paper.sections.every(section => paper.items?.filter(item => item.status === "active" && item.sectionId === section.id).length >= section.servedItemCount);
  const assessmentEnabled = !["false", "0"].includes(process.env.ASSESSMENT_ENGINE_ENABLED) && settings?.assessments?.enabled !== false;
  const checks = [
    { key: "role", title: "Role brief", required: true, ready: Boolean(job.title?.trim() && job.description?.trim()), reason: "Title and description must be present.", href: `${base}/edit` },
    { key: "rubric", title: "Scoring rubric", required: true, ready: rubricReady, reason: rubric?.status === "approved" && !rubricReady ? "The role brief changed after this rubric was compiled. Review a new version." : "Review and approve the latest rubric.", href: `${base}/rubric`, version: rubric?.version, state: rubric?.status || "missing" },
    { key: "questions", title: "Interview questions", required: true, ready: questionReady, reason: "Approve a question set for the current role and rubric.", href: `${base}/questions`, version: questions?.version, state: questions?.status || "missing" },
    { key: "assessment", title: "Skills assessment", required: hasAssessment, ready: !hasAssessment || Boolean(paperReady && assessmentEnabled), reason: !hasAssessment ? "Assessment is off for this role." : !assessmentEnabled ? "Assessments are not enabled for this workspace. Change the policy or enable assessments." : !paper ? "No assessment paper has been created yet. Compile and approve an assessment paper." : paper.status !== "approved" ? "Approve the assessment paper before publishing." : !paperReady ? "All test sections must have enough approved questions in pool." : "Assessment test is approved and ready.", href: `${base}/assessment`, version: paper?.version, state: !hasAssessment ? "not_required" : paper?.status || "missing" },
    { key: "capacity", title: "Hiring capacity", required: true, ready: Number(job.numberOfOpenings || 1) > filledOpenings, reason: "All planned openings are filled. Increase capacity before reopening recruitment.", href: `${base}/edit` },
  ].map(check => ({ ...check, status: check.ready ? check.required ? "ready" : "not_required" : "needs_attention" }));
  const journey = {
    assessmentPolicy: job.assessmentPolicy || "off",
    minimumQuestions: job.interviewMinQuestions ?? null,
    maximumQuestions: job.interviewMaxQuestions ?? null,
    interviewInstructions: job.interviewInstructions || "",
    questions: (questions?.status === "approved" ? questions.questions : []).map(question => ({ id: question.id, text: question.text })),
    questionVersion: questions?.status === "approved" ? questions.version : null,
    assessmentTiming: hasAssessment && paper?.status === "approved" ? paper.timing : null,
    assessmentSections: hasAssessment && paper?.status === "approved" ? (paper.sections || []).map(section => ({ title: section.title, timeLimitSec: section.timeLimitSec, servedItemCount: section.servedItemCount })) : [],
    assessmentInstructions: hasAssessment && paper?.status === "approved" ? paper.instructions || "" : "",
    autoRejectAllowed: settings?.compliance?.autoRejectAllowed === true,
    screeningThreshold: job.atsThreshold ?? 60,
    consentText: "Candidates consent to the employer processing their resume, profile and interview responses for recruitment, including an AI-assisted interview that may use their camera and a third-party AI model. Separate device and recording disclosures appear before the interview.",
    consentPreviewKind: "summary",
  };
  const fingerprint = digest({ job: String(job._id), source: sourceHashOf(job), role: [job.department || "", job.location || "", job.numberOfOpenings ?? 1], policy: journey, rubric: rubric?._id && String(rubric._id), paper: hasAssessment && paper?._id && String(paper._id), settingsUpdatedAt: settings?.updatedAt || null });
  const journeyReviewed = draft?.journeyReview?.fingerprint === fingerprint;
  if (job.setupDraft) checks.push({ key: "journey", title: "Candidate journey", required: true, ready: journeyReviewed, status: journeyReviewed ? "ready" : "needs_attention", reason: "Review the current candidate journey before publication. Changes to the role, evaluation or workspace settings require another review.", href: `${base}/journey` });
  return { jobId: String(job._id), publicationStatus: job.status, checks, evaluationReady: checks.filter(check => ["rubric", "questions", "assessment"].includes(check.key)).every(check => check.ready), canPublish: checks.every(check => !check.required || check.ready), journey, fingerprint, journeyReviewed, setupRevision: draft?.revision, checkedAt: new Date().toISOString() };
}
async function get(jobOrId, company) {
  if ((typeof jobOrId !== "object" || jobOrId.title === undefined) && !isValidObjectId(jobOrId)) throw problem(404, "Job not found.", "JOB_NOT_FOUND");
  const job = typeof jobOrId === "object" && jobOrId.title !== undefined ? jobOrId : await Job.findOne({ _id: jobOrId, company }).lean();
  if (!job || String(job.company?._id || job.company) !== String(company)) throw problem(404, "Job not found.", "JOB_NOT_FOUND");
  const filter = { job: job._id, company };
  const [rubric, questions, paper, settings, snapshot, draft] = await Promise.all([
    RoleRubric.findOne({ ...filter, status: "approved" }).sort({ version: -1 }).lean()
      .then(r => r || RoleRubric.findOne(filter).sort({ version: -1 }).lean()),
    QuestionSet.findOne({ ...filter, status: "approved" }).sort({ version: -1 }).lean()
      .then(q => q || QuestionSet.findOne(filter).sort({ version: -1 }).lean()),
    AssessmentPaper.findOne({ ...filter, status: "approved" }).sort({ version: -1 }).lean()
      .then(p => p || AssessmentPaper.findOne(filter).sort({ version: -1 }).lean()),
    CompanySettings.findOne({ company }).select("compliance assessments updatedAt").lean(),
    capacity.capacitySnapshot(job._id, company),
    job.setupDraft ? SetupDraft.findOne({ _id: job.setupDraft, company }).select("journeyReview revision").lean() : null,
  ]);
  return assess({ job, rubric, questions, paper, settings, filledOpenings: snapshot.filledOpenings, draft });
}
async function assertPublishable(job, company) {
  const readiness = await get(job, company);
  if (!readiness.canPublish) throw problem(409, "Finish the required setup checks before publishing.", "JOB_NOT_READY", { readiness });
  return readiness;
}
module.exports = { assess, get, assertPublishable };
