const mongoose = require("mongoose");
const SetupDraft = require("../models/SetupDraft");
const Job = require("../models/Job");
const quota = require("./quotaService");
const { generateJobSlug } = require("../utils/slug");
const contract = require("../utils/setupDraft");

function scope(user, id) {
  if (!user?.company || !user?._id) throw contract.problem(403, "A company account is required.", "COMPANY_REQUIRED");
  if (id && !mongoose.isValidObjectId(id)) throw contract.problem(404, "Setup draft not found.", "DRAFT_NOT_FOUND");
  return { company: user.company, owner: user._id, ...(id ? { _id: id } : {}) };
}
function serialize(doc) {
  const draft = doc?.toObject ? doc.toObject() : doc;
  if (!draft) return null;
  const { reservedJobId, clientKey, lastMutation, __v, ...safe } = draft;
  return safe;
}
async function read(user, id) {
  const draft = await SetupDraft.findOne(scope(user, id)).lean();
  if (!draft) throw contract.problem(404, "Setup draft not found. It may belong to another recruiter.", "DRAFT_NOT_FOUND");
  return draft;
}
async function create(user, input) {
  const filter = { ...scope(user), clientKey: contract.key(input.clientKey) };
  const values = contract.normalize(input.values || {});
  if (!["description", "title"].includes(input.source || "description")) throw contract.problem(400, "Choose a supported source.", "INVALID_SOURCE");
  // A retry returns the original record; it never overwrites later saved work.
  try {
    return await SetupDraft.findOneAndUpdate(filter, { $setOnInsert: { ...filter, values, source: input.source || "description", reservedJobId: new mongoose.Types.ObjectId(), revision: 1, currentStep: "role", state: "editing", schemaVersion: 1 } }, { upsert: true, new: true, runValidators: true }).lean();
  } catch (error) {
    if (error.code !== 11000) throw error;
    return SetupDraft.findOne(filter).lean();
  }
}
async function save(user, id, input) {
  const expected = contract.revision(input.revision);
  const requestKey = contract.key(input.requestKey);
  const values = contract.normalize(input.values);
  if (!contract.STEPS.includes(input.currentStep) || !["description", "title"].includes(input.source)) throw contract.problem(400, "Unsupported setup step or source.", "INVALID_DRAFT");
  const fingerprint = contract.digest({ expected, values, currentStep: input.currentStep, source: input.source });
  const previous = await read(user, id);
  if (previous.lastMutation?.key === requestKey) {
    if (previous.lastMutation.digest !== fingerprint) throw contract.problem(409, "This request key was used for different changes.", "REQUEST_KEY_REUSED");
    return previous;
  }
  if (previous.state === "creating") throw contract.problem(409, "Job creation needs to finish before this draft can change. Resume job creation.", "DRAFT_CREATING");
  if (previous.state === "linked" && contract.digest(values) !== contract.digest(contract.normalize(previous.values))) throw contract.problem(409, "Edit the linked job to change its role details. Your draft values have been retained locally.", "JOB_ALREADY_CREATED");
  const saved = await SetupDraft.findOneAndUpdate({ ...scope(user, id), revision: expected, state: { $ne: "creating" } }, { $set: { values, currentStep: input.currentStep, source: input.source, lastMutation: { key: requestKey, digest: fingerprint } }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
  if (!saved) throw contract.problem(409, "This draft changed in another tab. Your local changes have not been overwritten.", "DRAFT_CONFLICT", { current: serialize(await read(user, id)) });
  return saved;
}
async function materialize(user, id, input) {
  const expected = contract.revision(input.revision);
  let draft = await read(user, id);
  if (draft.state === "linked") {
    const job = await Job.findOne({ _id: draft.job, company: user.company }).lean();
    if (!job) throw contract.problem(404, "The linked job was deleted. This saved draft remains available for reference.", "JOB_DELETED");
    return draft;
  }
  if (draft.state === "editing") {
    const errors = contract.roleErrors(contract.normalize(draft.values));
    if (Object.keys(errors).length) throw contract.problem(422, "Complete the role brief before creating the evaluation plan.", "ROLE_INCOMPLETE", { fieldErrors: errors });
    await quota.enforce(user.company, "jobs", { actor: user });
    draft = await SetupDraft.findOneAndUpdate({ ...scope(user, id), revision: expected, state: "editing" }, { $set: { state: "creating" }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
    if (!draft) throw contract.problem(409, "The draft changed. Reload its saved version before continuing.", "DRAFT_CONFLICT", { current: serialize(await read(user, id)) });
  }
  // The reserved ID and locked values make recovery safe even when a response
  // is lost after Job.create. Repeated attempts cannot create a second job.
  let job = await Job.findOne({ _id: draft.reservedJobId, company: user.company, setupDraft: draft._id }).lean();
  if (!job) {
    try {
      job = await Job.create({ ...contract.toJob(draft.values), _id: draft.reservedJobId, company: user.company, setupDraft: draft._id, slug: generateJobSlug(draft.values.title), status: "draft" });
    } catch (error) {
      if (error.code !== 11000) throw error;
      job = await Job.findOne({ _id: draft.reservedJobId, company: user.company, setupDraft: draft._id }).lean();
      if (!job) throw error;
    }
  }
  const linked = await SetupDraft.findOneAndUpdate({ ...scope(user, id), state: "creating" }, { $set: { job: job._id, state: "linked", currentStep: "evaluation" }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
  return linked || read(user, id);
}
async function remove(user, id) {
  const draft = await SetupDraft.findOneAndDelete(scope(user, id)).lean();
  if (!draft) throw contract.problem(404, "Setup draft not found.", "DRAFT_NOT_FOUND");
  return draft;
}
module.exports = { scope, serialize, read, create, save, materialize, remove };
