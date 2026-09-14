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

// `stages` is capped at the six biggest for the dashboard funnel chart. The
// Candidates page needs a SPECIFIC stage's count, and a stage outside that top
// six would come back absent — indistinguishable from zero, which is how the
// page ends up reporting a wrong number with total confidence. `stageCounts`
// carries every active stage so a caller can trust the zero it does not find.
test("stageCounts reports every active stage, not just the six the funnel chart shows", async () => {
  const original = Candidate.aggregate;
  let response;
  const stages = [
    { _id: "applied", count: 90 },
    { _id: "rejected", count: 55 },
    { _id: "ats_passed", count: 31 },
    { _id: "interview_scheduled", count: 20 },
    { _id: "ai_interview_completed", count: 12 },
    { _id: "shortlisted", count: 9 },
    { _id: "under_review", count: 3 },  // 7th — truncated out of `stages`
    { _id: "joined", count: 2 },        // 8th — truncated out of `stages`
  ];
  Candidate.aggregate = async () => [{ total: [{ count: 222 }], periods: [{}], stages, attentionCount: [{ count: 0 }] }];
  try {
    await dashboardSummary({ user: { company: "6a9f5606821cdc7119a91f73" }, query: {} }, { json: v => { response = v; } });

    // The funnel chart's list stays capped, so that page is unchanged.
    assert.equal(response.stages.length, 6);

    // Every stage is present in the exact map, including the two the cap drops.
    assert.equal(response.stageCounts.under_review, 3);
    assert.equal(response.stageCounts.joined, 2);
    assert.equal(response.stageCounts.ats_passed, 31);
    assert.equal(response.stageCounts.rejected, 55);
    assert.equal(Object.keys(response.stageCounts).length, stages.length);

    // A stage with no candidates is genuinely absent, so a caller reading it as
    // 0 is correct rather than guessing.
    assert.equal(response.stageCounts.offer_sent, undefined);

    // No prior period to compare against reports null, never a percentage.
    assert.equal(response.applicantDelta, null);
  } finally { Candidate.aggregate = original; }
});
