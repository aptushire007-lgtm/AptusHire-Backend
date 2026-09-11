const { test } = require("node:test");
const assert = require("node:assert/strict");
const Candidate = require("../../models/Candidate");
const { relatedApplications, listCandidates } = require("../../controllers/candidateController");
test("a missing identity never queries unrelated empty-email applications", async () => {
  const original = Candidate.findOne, originalFind = Candidate.find;
  let response;
  Candidate.findOne = () => ({ select: async () => ({ _id: "6a9f5606821cdc7119a91f73", basicDetails: { email: " " } }) });
  Candidate.find = () => { throw new Error("Must not query siblings without identity"); };
  try {
    await relatedApplications({ params: { id: "6a9f5606821cdc7119a91f73" }, user: { company: "tenant" } }, { json(value) { response = value; } });
    assert.deepEqual(response, { count: 0, identityBasis: "unavailable", applications: [] });
  } finally { Candidate.findOne = original; Candidate.find = originalFind; }
});
test("grouped candidate lists retain tenant scope and never group by email", async () => {
  const original = Candidate.aggregate;
  let pipeline;
  Candidate.aggregate = async (value) => { pipeline = value; return [{ rows: [], meta: [] }]; };
  try {
    await listCandidates({ user: { company: "6a9f5606821cdc7119a91f73" }, query: { groupBy: "candidate", q: "a.*", reached: "shortlisted", from: "2026-01-01" } }, { json() {} });
    assert.equal(String(pipeline[0].$match.company), "6a9f5606821cdc7119a91f73");
    assert.equal(pipeline[0].$match.$or[0]["basicDetails.name"].$regex, "a\\.\\*");
    assert.deepEqual(pipeline[0].$match["stageHistory.stage"], { $in: ["shortlisted", "next_round"] });
    assert.equal(pipeline[0].$match.createdAt.$gte.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.deepEqual(pipeline.find((stage) => stage.$group).$group._id, { $ifNull: ["$candidateUser", "$_id"] });
    const lookup = pipeline.find((stage) => stage.$facet).$facet.rows.find((stage) => stage.$lookup).$lookup;
    assert.equal(String(lookup.pipeline[0].$match.company), "6a9f5606821cdc7119a91f73");
  } finally { Candidate.aggregate = original; }
});
