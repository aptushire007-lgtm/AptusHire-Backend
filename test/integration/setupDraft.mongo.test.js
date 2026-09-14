const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server-core");
const SetupDraft = require("../../models/SetupDraft");
const Job = require("../../models/Job");
const service = require("../../services/setupDraftService");
const quota = require("../../services/quotaService");
let server, uri;
before(async () => {
  // Own disposable localhost server; never read MONGODB_URI or application .env.
  server = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1" }, spawn: { windowsHide: true } });
  uri = server.getUri("recruitment_ux_integration");
  await mongoose.connect(uri, { autoIndex: true });
  await Promise.all([SetupDraft.init(), Job.init()]);
}, { timeout: 600000 });
after(async () => { await mongoose.disconnect(); if (server) await server.stop(); });
const actor = () => ({ _id: new mongoose.Types.ObjectId(), company: new mongoose.Types.ObjectId() });
const input = title => ({ clientKey: "stable-test-request-1234", source: "description", values: { title, description: "Build dependable recruitment software." } });

test("concurrent retries use the unique draft key and survive reconnection", async () => {
  const user = actor();
  const drafts = await Promise.all(Array.from({ length: 12 }, () => service.create(user, input("Concurrent role"))));
  assert.equal(new Set(drafts.map(draft => String(draft._id))).size, 1);
  assert.equal(await SetupDraft.countDocuments({ company: user.company }), 1);
  const indexes = await SetupDraft.collection.indexes();
  assert.ok(indexes.some(index => index.unique && index.key.company === 1 && index.key.owner === 1 && index.key.clientKey === 1));
  await mongoose.disconnect(); await mongoose.connect(uri, { autoIndex: true });
  const loaded = await service.read(user, drafts[0]._id);
  assert.equal(loaded.values.title, "Concurrent role"); assert.equal(loaded.revision, 1);
  await assert.rejects(service.read({ ...user, _id: new mongoose.Types.ObjectId() }, loaded._id), error => error.status === 404);
  await assert.rejects(service.read({ ...user, company: new mongoose.Types.ObjectId() }, loaded._id), error => error.status === 404);
});
test("competing saves admit one revision and preserve the winning values on retry", async () => {
  const user = actor(), draft = await service.create(user, input("Original"));
  const updates = ["First", "Second"].map((title, index) => ({ revision: 1, requestKey: `revision-request-key-${index}`, source: "description", currentStep: "role", values: { ...draft.values, title } }));
  const results = await Promise.allSettled(updates.map(update => service.save(user, draft._id, update)));
  const winning = results.findIndex(result => result.status === "fulfilled");
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results[1 - winning].reason.code, "DRAFT_CONFLICT");
  const retried = await service.save(user, draft._id, updates[winning]);
  assert.equal(retried.revision, 2); assert.equal(retried.values.title, updates[winning].values.title);
});
test("concurrent materialization and recovery create exactly one tenant-scoped job", async t => {
  t.mock.method(quota, "enforce", async () => {}); // Quota policy is unit-tested separately.
  const user = actor(), draft = await service.create(user, input("One job"));
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => service.materialize(user, draft._id, { revision: 1 })));
  assert.ok(attempts.some(result => result.status === "fulfilled"));
  for (const result of attempts.filter(result => result.status === "rejected")) assert.equal(result.reason.code, "DRAFT_CONFLICT");
  const recovered = await service.materialize(user, draft._id, { revision: 1 });
  assert.equal(recovered.state, "linked");
  assert.equal(await Job.countDocuments({ company: user.company }), 1);
  assert.equal(String(recovered.job), String(draft.reservedJobId));
  const saved = await service.save(user, draft._id, { revision: recovered.revision, requestKey: "linked-stage-request-123", values: recovered.values, source: recovered.source, currentStep: "journey" });
  assert.equal(saved.currentStep, "journey");
});
test("a real persisted job survives a lost creation response and is not duplicated", async t => {
  t.mock.method(quota, "enforce", async () => {});
  const user = actor(), draft = await service.create(user, input("Recover creation"));
  const create = Job.create.bind(Job);
  t.mock.method(Job, "create", async payload => { await create(payload); throw new Error("simulated response loss after write"); });
  await assert.rejects(service.materialize(user, draft._id, { revision: 1 }), /response loss/);
  assert.equal((await service.read(user, draft._id)).state, "creating");
  const recovered = await service.materialize(user, draft._id, { revision: 1 });
  assert.equal(recovered.state, "linked"); assert.equal(await Job.countDocuments({ setupDraft: draft._id }), 1);
  await Job.deleteOne({ _id: recovered.job, company: user.company });
  await assert.rejects(service.materialize(user, draft._id, { revision: 1 }), error => error.code === "JOB_DELETED");
  assert.equal(await Job.countDocuments({ setupDraft: draft._id }), 0);
});
test("concurrent job edits fail with a version conflict instead of silently overwriting", async () => {
  const user = actor();
  const job = await Job.create({ company: user.company, title: "Versioned role", description: "Build" });
  const first = await Job.findById(job._id), second = await Job.findById(job._id);
  first.title = "Saved title"; await first.save();
  second.title = "Stale edit";
  await assert.rejects(second.save(), error => error.name === "VersionError");
  assert.equal((await Job.findById(job._id)).title, "Saved title");
});
