// HTTP layer for per-job approved question sets. Admin-only and tenant-scoped; the lifecycle
// rules live in services/questionSetService and models/QuestionSet.
//
// Approval is the human-in-the-loop boundary, the same one the rubric and the persona have, and
// here it is the strongest of the three: this is the only place a human types text that will be
// read aloud, verbatim, to every candidate for a role. The auditLog middleware records who
// approved which version via req.audit.
//
// Note what these routes CANNOT do: they cannot change a weight, a threshold, or a score. A
// question set decides what is ASKED. What an answer is worth stays with the versioned rubric.

const questionSetService = require("../services/questionSetService");
const Job = require("../models/Job");

// GET /api/jobs/:jobId/question-set — every version, plus what an interview would use right now.
//
// If this job has NO set at all, one is compiled here and now from the job description and the
// approved rubric. That is deliberate: an approval workflow that opens on a blank page and says
// "write eight interview questions" is one nobody completes, and the recruiter has already told
// us everything needed to write them. They arrive at a finished set to read, not a form to fill.
//
// Safe to call repeatedly — the compile is idempotent per (JD + rubric version + prompt version),
// so re-opening the screen returns the same draft rather than spending again or churning versions.
async function listQuestionSets(req, res) {
  let versions = await questionSetService.listForJob(req.user.company, req.params.jobId);

  if (!versions.length) {
    const job = await Job.findOne({ _id: req.params.jobId, company: req.user.company });
    if (job) {
      try {
        await questionSetService.autoDraft(job);
        versions = await questionSetService.listForJob(req.user.company, req.params.jobId);
      } catch (err) {
        // Never fail the screen over this — an empty list is a working (if less helpful) state,
        // and the recruiter can still author a set by hand.
        console.error("[questionSet] auto-draft on list failed:", err.message);
      }
    }
  }

  const active = versions.find((s) => s.status === "approved") || null;
  res.json({
    active,
    versions,
    // Surfaced explicitly so "this job has no approved set" never reads as a configured choice.
    // Without one the interview still runs — claim-probes plus adaptive questions, as before.
    effective: active
      ? { source: "approved_set", version: active.version, questionCount: active.questions.length }
      : { source: "none", note: "No approved set — interviews use résumé claim-probes and adaptive questions only." },
  });
}

// POST /api/jobs/:jobId/question-set/review — vet without saving, so the authoring screen can
// show problems while the recruiter types rather than only when they try to approve.
async function reviewQuestionSet(req, res) {
  res.json(questionSetService.review(req.body?.questions));
}

// POST /api/jobs/:jobId/question-set/auto-draft — recompile from the job description and rubric.
// The same call the list endpoint makes implicitly; exposed so a recruiter who has since rewritten
// the JD can pull a fresh draft without hand-editing the old one.
async function autoDraftQuestionSet(req, res) {
  const job = await Job.findOne({ _id: req.params.jobId, company: req.user.company });
  if (!job) throw Object.assign(new Error("Job not found"), { status: 404 });
  const set = await questionSetService.autoDraft(job, { forceFallback: req.body?.forceFallback === true });
  req.audit = {
    action: "questionSet.autoDraft",
    resourceType: "QuestionSet",
    resourceId: set._id,
    meta: {
      job: String(set.job),
      version: set.version,
      questionCount: set.questions.length,
      engine: set.compiledBy?.engine,
      dropped: (set.droppedAtCompile || []).length,
    },
  };
  res.status(201).json(set);
}

// POST /api/jobs/:jobId/question-set — create the next draft version for this job.
async function createQuestionSet(req, res) {
  const set = await questionSetService.createDraft(req.user.company, req.params.jobId, req.body || {});
  req.audit = {
    action: "questionSet.create",
    resourceType: "QuestionSet",
    resourceId: set._id,
    meta: { job: String(set.job), version: set.version, questionCount: set.questions.length },
  };
  res.status(201).json(set);
}

// PATCH /api/jobs/:jobId/question-set/:id — drafts only. An approved set is frozen.
async function updateQuestionSet(req, res) {
  const set = await questionSetService.updateDraft(req.params.id, req.user.company, req.body || {});
  req.audit = {
    action: "questionSet.update",
    resourceType: "QuestionSet",
    resourceId: set._id,
    meta: { job: String(set.job), version: set.version, questionCount: set.questions.length },
  };
  res.json(set);
}

// POST /api/jobs/:jobId/question-set/:id/approve — freeze this version, archive the one it replaces.
async function approveQuestionSet(req, res) {
  try {
    const set = await questionSetService.approve(req.params.id, req.user.company, req.user);
    req.audit = {
      action: "questionSet.approve",
      resourceType: "QuestionSet",
      resourceId: set._id,
      meta: {
        job: String(set.job),
        version: set.version,
        questionCount: set.questions.length,
        frozenAt: set.frozenAt,
      },
    };
    res.json(set);
  } catch (err) {
    // Vetting failures carry the full per-question issue list. The global error handler would
    // flatten that to a bare message, and a recruiter fixing three problems one round-trip at a
    // time will give up — so they are returned intact.
    if (err.issues) {
      return res.status(err.status || 400).json({ error: err.message, issues: err.issues });
    }
    throw err;
  }
}

module.exports = {
  listQuestionSets,
  reviewQuestionSet,
  autoDraftQuestionSet,
  createQuestionSet,
  updateQuestionSet,
  approveQuestionSet,
};
