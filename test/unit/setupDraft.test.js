const test = require("node:test");
const assert = require("node:assert/strict");
const SetupDraft = require("../../models/SetupDraft");
const Job = require("../../models/Job");
const quota = require("../../services/quotaService");
const service = require("../../services/setupDraftService");
const contract = require("../../utils/setupDraft");
const readiness = require("../../services/jobReadinessService");
const { sourceHashOf } = require("../../utils/rubricEngine");
const { sourceHashOf: questionHash } = require("../../services/questionSetService");
const user = { _id: "507f1f77bcf86cd799439010", company: "507f1f77bcf86cd799439011" };
const id = "507f1f77bcf86cd799439012";
const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));
function memory(t) {
  let draft = null, job = null, creates = 0;
  const matches = (doc, filter) => doc && Object.entries(filter).every(([k, v]) => v?.$ne ? doc[k] !== v.$ne : String(doc[k]) === String(v));
  const query = run => ({ lean: async () => clone(run()) });
  t.mock.method(SetupDraft, "findOne", filter => query(() => matches(draft, filter) ? draft : null));
  t.mock.method(SetupDraft, "findOneAndUpdate", (filter, change, options) => query(() => {
    if (!draft && options?.upsert) draft = { _id: id, ...clone(change.$setOnInsert) };
    else if (!matches(draft, filter)) return null;
    if (change.$set) Object.assign(draft, clone(change.$set));
    if (change.$inc) for (const [key, amount] of Object.entries(change.$inc)) draft[key] += amount;
    return draft;
  }));
  t.mock.method(SetupDraft, "findOneAndDelete", filter => query(() => {
    if (!matches(draft, filter)) return null;
    const removed = draft;
    draft = null;
    return removed;
  }));
  t.mock.method(Job, "findOne", filter => query(() => matches(job, filter) ? job : null));
  t.mock.method(Job, "create", async payload => { creates++; job = clone(payload); return clone(job); });
  t.mock.method(quota, "enforce", async () => {});
  return { draft: () => draft, job: () => job, creates: () => creates };
}
const start = values => service.create(user, { values, clientKey: "stable-request-key-1234" });
test("private draft creation is idempotent and permits incomplete role details", async t => {
  const store = memory(t);
  const first = await start({ title: "Engineer" });
  const again = await start({ title: "Changed retry" });
  assert.equal(first._id, again._id); assert.equal(again.values.title, "Engineer"); assert.equal(store.creates(), 0);
  assert.equal(service.serialize(first).reservedJobId, undefined);
  await assert.rejects(service.read({ ...user, _id: "507f1f77bcf86cd799439019" }, id), error => error.status === 404);
  await assert.rejects(service.read({ ...user, company: "507f1f77bcf86cd799439019" }, id), error => error.status === 404);
});
test("revision checks reject lost edits and exact update retries do not increment again", async t => {
  memory(t); const first = await start({ title: "Engineer" });
  const input = { revision: 1, requestKey: "update-request-key-123", source: "description", currentStep: "role", values: { ...first.values, description: "Build" } };
  const saved = await service.save(user, id, input);
  assert.equal(saved.revision, 2); assert.equal((await service.save(user, id, input)).revision, 2);
  await assert.rejects(service.save(user, id, { ...input, values: { ...input.values, title: "Different" } }), error => error.code === "REQUEST_KEY_REUSED");
  await assert.rejects(service.save(user, id, { ...input, requestKey: "another-request-key-1" }), error => error.code === "DRAFT_CONFLICT" && error.current.revision === 2);
});
test("creation requires a real description and quota acceptance before locking the draft", async t => {
  const store = memory(t); await start({ title: "Engineer" });
  await assert.rejects(service.materialize(user, id, { revision: 1 }), error => error.code === "ROLE_INCOMPLETE");
  assert.equal(store.draft().state, "editing");
  store.draft().values.description = "Build";
  quota.enforce.mock.mockImplementation(async () => { throw contract.problem(403, "Job limit reached"); });
  await assert.rejects(service.materialize(user, id, { revision: 1 }), /limit reached/);
  assert.equal(store.draft().state, "editing"); assert.equal(store.creates(), 0);
});
test("a lost creation response recovers the same reserved job without creating a duplicate", async t => {
  const store = memory(t); await start({ title: "Engineer", description: "Build" });
  const original = Job.create;
  t.mock.method(Job, "create", async payload => { await original(payload); throw new Error("response lost"); });
  await assert.rejects(service.materialize(user, id, { revision: 1 }), /response lost/);
  assert.equal(store.draft().state, "creating");
  const recovered = await service.materialize(user, id, { revision: 1 });
  assert.equal(recovered.state, "linked"); assert.equal(String(recovered.job), String(store.job()._id)); assert.equal(store.creates(), 1);
  const again = await service.materialize(user, id, { revision: 1 });
  assert.equal(again.job, recovered.job); assert.equal(store.creates(), 1);
});
test("draft validation rejects unexpected fields and enforces materialized number bounds", () => {
  assert.throws(() => contract.normalize({ company: "forged" }), /Unknown draft field/);
  assert.throws(() => contract.normalize({ requiredSkills: "x".repeat(5001) }), /format or length/);
  assert.ok(contract.roleErrors(contract.normalize({ title: "Role", description: "Build", numberOfOpenings: "0" })).numberOfOpenings);
});
function artifacts(extra = {}) {
  const job = { _id: id, company: user.company, title: "Engineer", description: "Build", requiredSkills: [], status: "draft", numberOfOpenings: 1, assessmentPolicy: "off", ...extra };
  const rubric = { _id: "rubric1", version: 1, status: "approved", sourceHash: sourceHashOf(job) };
  const questions = { version: 1, status: "approved", sourceHash: questionHash(job, rubric), questions: [{ id: "q1", text: "Describe your approach." }] };
  return { job, rubric, questions, settings: {} };
}
test("readiness is invalidated by stale sources, missing questions, filled capacity and changed journey facts", () => {
  const input = artifacts({ setupDraft: id });
  const first = readiness.assess(input); assert.equal(first.evaluationReady, true); assert.equal(first.canPublish, false);
  input.draft = { revision: 3, journeyReview: { fingerprint: first.fingerprint } };
  assert.equal(readiness.assess(input).canPublish, true);
  input.job.location = "Remote"; assert.equal(readiness.assess(input).journeyReviewed, false);
  input.job.description = "A changed brief"; assert.equal(readiness.assess(input).evaluationReady, false);
  const missing = artifacts(); missing.questions = null; assert.equal(readiness.assess(missing).canPublish, false);
  assert.equal(readiness.assess({ ...artifacts(), filledOpenings: 1 }).canPublish, false);
});
test("assessment readiness requires enough active items in every section and an enabled engine", () => {
  const input = artifacts({ assessmentPolicy: "manual" });
  input.paper = { _id: "paper1", rubric: "rubric1", status: "approved", sections: [{ id: "s1", servedItemCount: 2 }], items: [{ sectionId: "s1", status: "active" }, { sectionId: "s1", status: "retired" }] };
  assert.equal(readiness.assess(input).evaluationReady, false);
  input.paper.items[1].status = "active"; assert.equal(readiness.assess(input).evaluationReady, true);
  input.settings = { assessments: { enabled: false } }; assert.equal(readiness.assess(input).evaluationReady, false);
  input.job.assessmentPolicy = "off"; assert.equal(readiness.assess(input).evaluationReady, true);
});
const controller = require("../../controllers/setupDraftController");
const response = () => ({ statusCode: 200, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
test("a teammate can review shared job configuration without reading the private setup", async t => {
  const store = memory(t); await start({ title: "Engineer", description: "Build" });
  await service.materialize(user, id, { revision: 1 });
  const colleague = { ...user, _id: "507f1f77bcf86cd799439019" };
  await assert.rejects(service.read(colleague, id), error => error.status === 404);
  t.mock.method(readiness, "get", async () => ({ evaluationReady: true, fingerprint: "current-version", journeyReviewed: Boolean(store.draft().journeyReview), setupRevision: store.draft().revision }));
  const res = response();
  await controller.reviewJobJourney({ user: colleague, params: { id: store.job()._id }, body: { revision: store.draft().revision, fingerprint: "current-version" } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.journeyReviewed, true); assert.equal(res.body.values, undefined);
  assert.equal(store.draft().journeyReview.reviewedBy, colleague._id);
});
test("reconfirming an unchanged journey advances from Journey back to Review", async t => {
  const store = memory(t); await start({ title: "Engineer", description: "Build" }); await service.materialize(user, id, { revision: 1 });
  Object.assign(store.draft(), { currentStep: "journey", journeyReview: { fingerprint: "same" } });
  t.mock.method(readiness, "get", async () => ({ evaluationReady: true, fingerprint: "same" }));
  const res = response();
  await controller.reviewJourney({ user, params: { draftId: id }, body: { revision: store.draft().revision, fingerprint: "same" } }, res);
  assert.equal(res.body.currentStep, "review");
});
test("generic job create/update cannot bypass explicit publication review", async t => {
  memory(t);
  const jobs = require("../../controllers/jobController");
  t.mock.method(require("../../services/rubricService"), "compile", async () => ({ version: 1 }));
  const res = response();
  await jobs.createJob({ user, body: { title: "Engineer", description: "Build", status: "published", setupDraft: id, _id: id } }, res);
  assert.equal(res.body.status, "draft"); assert.equal(res.body.setupDraft, undefined); assert.equal(res.body._id, undefined);
  t.mock.method(Job, "findOne", async () => ({ _id: id, company: user.company, status: "draft", __v: 1 }));
  await assert.rejects(jobs.updateJob({ user, params: { id }, body: { status: "published", revision: 1 } }, response()), error => error.code === "PUBLICATION_REVIEW_REQUIRED");
  await assert.rejects(jobs.updateJob({ user, params: { id }, body: { title: "Stale", revision: 0 } }, response()), error => error.code === "JOB_CONFLICT");
});
test("private setup draft can be removed and enforces tenant isolation", async t => {
  const store = memory(t);
  await start({ title: "Engineer" });
  assert.ok(store.draft());
  await assert.rejects(service.remove({ ...user, _id: "507f1f77bcf86cd799439019" }, id), error => error.status === 404);
  const deleted = await service.remove(user, id);
  assert.equal(deleted._id, id);
  assert.equal(store.draft(), null);
  await assert.rejects(service.remove(user, id), error => error.status === 404);
});
test("setup and shared journey routes enforce authentication and recruiter role over HTTP", async t => {
  const express = require("express"), jwt = require("jsonwebtoken");
  const app = express(); app.use(express.json()); app.use("/jobs", require("../../routes/jobRoutes"));
  const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [method, path] of [["POST", "/setup-drafts"], ["GET", `/setup-drafts/${id}`], ["DELETE", `/setup-drafts/${id}`], ["POST", `/${id}/review-journey`], ["GET", `/${id}/readiness`]]) {
    assert.equal((await fetch(`${base}/jobs${path}`, { method })).status, 401);
  }
  t.mock.method(jwt, "verify", () => ({ userId: user._id }));
  t.mock.method(require("../../models/User"), "findById", async () => ({ ...user, role: "candidate" }));
  assert.equal((await fetch(`${base}/jobs/setup-drafts`, { method: "POST", headers: { authorization: "Bearer synthetic-token" } })).status, 403);
  assert.equal((await fetch(`${base}/jobs/${id}/review-journey`, { method: "POST", headers: { authorization: "Bearer synthetic-token" } })).status, 403);
});
