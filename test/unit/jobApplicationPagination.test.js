const { test } = require("node:test");
const assert = require("node:assert/strict");
const Candidate = require("../../models/Candidate");
const { listCandidatesForJob } = require("../../controllers/candidateController");
test("job applications paginate and apply escaped search inside the tenant/job boundary", async () => {
  const originalFind = Candidate.find, originalCount = Candidate.countDocuments;
  let filter, countFilter, skipped, limited, response;
  Candidate.find = (value) => {
    filter = value;
    return { sort() { return this; }, skip(value) { skipped = value; return this; }, limit(value) { limited = value; return Promise.resolve([{ _id: "application" }]); } };
  };
  Candidate.countDocuments = async (value) => { countFilter = value; return 501; };
  try {
    await listCandidatesForJob({ params: { id: "6a9f4d07821cdc7119a919e9" }, user: { company: "tenant" }, query: { page: "2.5", limit: "50", stage: "shortlisted", q: "a.*" } }, { json(value) { response = value; } });
    assert.equal(filter.company, "tenant");
    assert.equal(filter.job, "6a9f4d07821cdc7119a919e9");
    assert.equal(filter.status, "shortlisted");
    assert.equal(filter.$or[0]["basicDetails.name"].$regex, "a\\.\\*");
    assert.deepEqual(countFilter, filter);
    assert.equal(skipped, 50); assert.equal(limited, 50);
    assert.equal(response.total, 501); assert.equal(response.pages, 11);
  } finally { Candidate.find = originalFind; Candidate.countDocuments = originalCount; }
});
