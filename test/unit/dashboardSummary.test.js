const { test } = require("node:test");
const assert = require("node:assert/strict");
const Candidate = require("../../models/Candidate");
const { dashboardSummary } = require("../../controllers/dashboardSummaryController");

test("summary scopes both collections and bounds evidence lists without loading all applications", async () => {
  const original = Candidate.aggregate;
  let pipeline, response;
  Candidate.aggregate = async value => { pipeline = value; return [{ total: [{ count: 1501 }], periods: [{ last30: 30, prior30: 20 }], stages: [{ _id: "shortlisted", count: 501 }], attentionCount: [{ count: 85 }] }]; };
  try {
    const id = "6a9f5606821cdc7119a91f73";
    await dashboardSummary({ user: { company: id }, query: { page: "2" } }, { json: value => { response = value; } });
    assert.equal(String(pipeline[0].$match.company), id);
    assert.equal(String(pipeline[1].$lookup.pipeline[0].$match.company), id);
    const facets = pipeline.find(step => step.$facet).$facet;
    assert.deepEqual(facets.attention[2], { $skip: 20 });
    assert.deepEqual(facets.attention[3], { $limit: 20 });
    assert.equal(facets.recent[2].$limit, 5);
    assert.equal(facets.interviews[2].$limit, 4);
    assert.equal(response.total, 1501);
    assert.equal(response.shortlisted, 501);
    assert.equal(response.applicantDelta, 50);
    assert.equal(response.attentionTotal, 85);
    assert.equal(response.buckets.length, 12);
  } finally { Candidate.aggregate = original; }
});
