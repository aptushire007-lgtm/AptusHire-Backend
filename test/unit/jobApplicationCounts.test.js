const { test } = require("node:test");
const assert = require("node:assert/strict");
const Job = require("../../models/Job");
const Candidate = require("../../models/Candidate");
const rubric = require("../../services/rubricService");
const { listJobs } = require("../../controllers/jobController");
test("job counts aggregate in tenant scope without returning candidate records", async () => {
  const originals = [Job.find, Candidate.aggregate, rubric.latestStatusesForJobs];
  const id = "6a9f5606821cdc7119a91f73";
  let pipeline, response;
  Job.find = () => ({ sort() { return this; }, lean: async () => [{ _id: id, title: "Engineer" }] });
  Candidate.aggregate = async (value) => { pipeline = value; return [{ _id: { job: id, stage: "under_review" }, count: 501 }]; };
  rubric.latestStatusesForJobs = async () => new Map();
  try {
    await listJobs({ user: { company: id }, query: { includeCounts: "1" } }, { json(value) { response = value; } });
    assert.equal(String(pipeline[0].$match.company), id);
    assert.deepEqual(pipeline[0].$match.job.$in, [id]);
    assert.deepEqual(response[0].applicationCounts, { total: 501, stages: { under_review: 501 } });
    assert.equal(response[0].applications, undefined);
  } finally { [Job.find, Candidate.aggregate, rubric.latestStatusesForJobs] = originals; }
});
