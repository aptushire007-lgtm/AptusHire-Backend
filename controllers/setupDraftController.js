const SetupDraft = require("../models/SetupDraft");
const Job = require("../models/Job");
const service = require("../services/setupDraftService");
const readinessService = require("../services/jobReadinessService");
const { problem, revision } = require("../utils/setupDraft");

// Structured validation/conflict payloads are consumed without throwing away the
// client's input. Unexpected server errors still use the normal error middleware.
function endpoint(handler) {
  return async (req, res) => {
    try { return await handler(req, res); }
    catch (error) {
      if (error.name === "VersionError") return res.status(409).json({ error: "This job changed while saving. Reload the latest version before applying your edits.", code: "JOB_CONFLICT" });
      if (!error.status) throw error;
      return res.status(error.status).json({ error: error.message, code: error.code, ...(error.current ? { current: error.current } : {}), ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}), ...(error.readiness ? { readiness: error.readiness } : {}) });
    }
  };
}
async function view(user, draft) {
  const result = service.serialize(draft);
  if (draft.job) {
    const job = await Job.findOne({ _id: draft.job, company: user.company }).lean();
    result.linkedJob = job;
    result.jobMissing = !job;
    if (job) result.readiness = await readinessService.get(job, user.company);
  }
  return result;
}
const list = endpoint(async (req, res) => {
  const page = req.query.page === undefined ? 1 : Number(req.query.page);
  if (!Number.isSafeInteger(page) || page < 1) throw problem(400, "Choose a valid saved-setup page.", "INVALID_PAGE");
  const limit = 12;
  const filter = service.scope(req.user);
  const [items, total] = await Promise.all([SetupDraft.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).select("values.title job state currentStep updatedAt revision").populate("job", "title status").lean(), SetupDraft.countDocuments(filter)]);
  res.json({ items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
});
const create = endpoint(async (req, res) => {
  const draft = await service.create(req.user, req.body);
  req.audit = { action: "setup.started", resourceType: "SetupDraft", resourceId: draft._id, meta: { revision: draft.revision } };
  res.status(201).json(await view(req.user, draft));
});
const read = endpoint(async (req, res) => res.json(await view(req.user, await service.read(req.user, req.params.draftId))));
const save = endpoint(async (req, res) => {
  const draft = await service.save(req.user, req.params.draftId, req.body);
  req.audit = { action: "setup.saved", resourceType: "SetupDraft", resourceId: draft._id, meta: { revision: draft.revision, step: draft.currentStep } };
  res.json(await view(req.user, draft));
});
const materialize = endpoint(async (req, res) => {
  const draft = await service.materialize(req.user, req.params.draftId, req.body);
  req.audit = { action: "setup.job_created", resourceType: "Job", resourceId: draft.job, meta: { draftId: draft._id } };
  res.json(await view(req.user, draft));
});
const reviewJourney = endpoint(async (req, res) => {
  const draft = await service.read(req.user, req.params.draftId);
  if (!draft.job) throw problem(409, "Create the evaluation plan first.", "JOB_REQUIRED");
  const readiness = await readinessService.get(draft.job, req.user.company);
  if (!readiness.evaluationReady || req.body.fingerprint !== readiness.fingerprint) throw problem(409, "The candidate journey changed or has unfinished evaluation checks. Reload it before confirming your review.", "JOURNEY_CHANGED", { readiness });
  const expected = revision(req.body.revision);
  const alreadyReviewed = draft.journeyReview?.fingerprint === readiness.fingerprint;
  if (alreadyReviewed && draft.currentStep === "review") return res.json(await view(req.user, draft));
  const updated = await SetupDraft.findOneAndUpdate({ ...service.scope(req.user, req.params.draftId), revision: alreadyReviewed ? draft.revision : expected, state: "linked" }, { $set: { journeyReview: { fingerprint: readiness.fingerprint, reviewedAt: new Date(), reviewedBy: req.user._id }, currentStep: "review" }, $inc: { revision: 1 } }, { new: true }).lean();
  if (!updated) throw problem(409, "The setup changed in another tab. Reload before continuing.", "DRAFT_CONFLICT", { current: service.serialize(await service.read(req.user, req.params.draftId)) });
  req.audit = { action: "setup.journey_reviewed", resourceType: "Job", resourceId: draft.job, meta: { draftId: draft._id, fingerprint: readiness.fingerprint } };
  res.json(await view(req.user, updated));
});
const readiness = endpoint(async (req, res) => res.json(await readinessService.get(req.params.id, req.user.company)));
// Shared job administrators may review the candidate-facing configuration,
// without gaining access to the creator's private draft values or draft list.
const reviewJobJourney = endpoint(async (req, res) => {
  const job = await Job.findOne({ _id: req.params.id, company: req.user.company }).lean();
  if (!job?.setupDraft) throw problem(404, "Guided setup is not available for this job.", "JOB_NOT_FOUND");
  const current = await readinessService.get(job, req.user.company);
  if (!current.evaluationReady || req.body.fingerprint !== current.fingerprint) throw problem(409, "The journey changed. Refresh and review its current evaluation content.", "JOURNEY_CHANGED");
  const expected = revision(req.body.revision);
  if (!current.journeyReviewed) {
    const updated = await SetupDraft.findOneAndUpdate({ _id: job.setupDraft, company: req.user.company, job: job._id, state: "linked", revision: expected }, { $set: { journeyReview: { fingerprint: current.fingerprint, reviewedAt: new Date(), reviewedBy: req.user._id } }, $inc: { revision: 1 } }, { new: true }).lean();
    if (!updated) throw problem(409, "The setup changed. Refresh the journey before confirming.", "JOURNEY_CHANGED");
  }
  req.audit = { action: "setup.journey_reviewed", resourceType: "Job", resourceId: job._id, meta: { fingerprint: current.fingerprint } };
  res.json(await readinessService.get(job, req.user.company));
});
module.exports = { list, create, read, save, materialize, reviewJourney, reviewJobJourney, readiness, endpoint };
