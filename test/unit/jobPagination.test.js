const { test } = require("node:test");
const assert = require("node:assert/strict");
const Job = require("../../models/Job");
const Candidate = require("../../models/Candidate");
const rubric = require("../../services/rubricService");
const { listJobs } = require("../../controllers/jobController");

test("listJobs applies database-level skip, limit and countDocuments when paginated", async () => {
  const originals = [Job.find, Job.countDocuments, Candidate.aggregate, rubric.latestStatusesForJobs];
  const companyId = "6a9f5606821cdc7119a91f73";
  const mockJobId = "6a9f5606821cdc7119a91f74";
  let skipVal = null, limitVal = null, countQuery = null;
  let response = null;

  Job.countDocuments = async (query) => {
    countQuery = query;
    return 35;
  };
  Job.find = (query) => ({
    sort() { return this; },
    skip(n) { skipVal = n; return this; },
    limit(n) { limitVal = n; return this; },
    lean: async () => [{ _id: mockJobId, title: "Staff Backend Engineer", company: companyId }],
  });
  Candidate.aggregate = async (pipeline) => [
    { _id: { job: mockJobId, stage: "applied" }, count: 12 },
  ];
  rubric.latestStatusesForJobs = async () => new Map([[mockJobId, "approved"]]);

  try {
    const req = {
      user: { company: companyId },
      query: { page: "2", limit: "10", search: "Staff", includeCounts: "1" },
    };
    const res = {
      json(data) { response = data; },
    };

    await listJobs(req, res);

    assert.equal(skipVal, 10, "skip should be (page - 1) * limit = 10");
    assert.equal(limitVal, 10, "limit should be 10");
    assert.equal(response.total, 35);
    assert.equal(response.page, 2);
    assert.equal(response.limit, 10);
    assert.equal(response.totalPages, 4);
    assert.equal(response.items.length, 1);
    assert.equal(response.items[0].rubricStatus, "approved");
    assert.deepEqual(response.items[0].applicationCounts, { total: 12, stages: { applied: 12 } });
  } finally {
    [Job.find, Job.countDocuments, Candidate.aggregate, rubric.latestStatusesForJobs] = originals;
  }
});

