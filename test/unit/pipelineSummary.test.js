const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createPipelineSummary } = require("../../utils/pipelineSummary");
const Candidate = require("../../models/Candidate");
const { pipelineRead } = require("../../controllers/pipelineReadController");

test("streamed metrics preserve default-zero, legacy-stage and historical pass-through semantics", () => {
  const now = Date.UTC(2026, 8, 9), day = 86400000;
  const summary = createPipelineSummary(now);
  summary.add({ status: "applied", createdAt: new Date(now - day), ats: { overallScore: 0, decision: "pending" } });
  summary.add({ status: "next_round", createdAt: new Date(now - 8 * day), stageHistory: [{ stage: "shortlisted", at: new Date(now - 3 * day) }], ats: { overallScore: 0, decision: "review" } });
  summary.add({ status: "rejected", stageHistory: [{ stage: "offer_sent" }], ats: { overallScore: 80, decision: "pass" } });
  const { kpis, stages } = summary.result();
  assert.equal(kpis.total, 3);
  assert.equal(kpis.active, 2);
  assert.equal(kpis.scoredCount, 2);
  assert.equal(kpis.avgScore, 40);
  assert.equal(kpis.shortlisted, 2);
  assert.equal(kpis.passThroughPct, 67);
  assert.equal(kpis.avgDaysInStage, 2);
  assert.equal(stages.shortlisted, 1);
});

test("pipeline read bounds page payload, scopes job joins, closes cursor and rejects invalid jobs", async () => {
  const original = Candidate.aggregate;
  const pipelines = [];
  let closed = false, response;
  const id = "6a9f5606821cdc7119a91f73";
  Candidate.aggregate = pipeline => {
    pipelines.push(pipeline);
    if (pipelines.length === 1) return { cursor: () => ({
      async *[Symbol.asyncIterator]() { for (let i = 0; i < 501; i++) yield { status: "applied" }; },
      async close() { closed = true; },
    }) };
    return Promise.resolve(pipelines.length === 2 ? [] : [{ total: [{ count: 502 }], jobs: [{ _id: id, count: 501 }] }]);
  };
  try {
    await pipelineRead({ user: { company: id }, query: { q: ".*", page: 999 } }, { json(value) { response = value; } });
    assert.equal(closed, true);
    assert.equal(response.page, 11);
    assert.equal(response.historicalCount, 1);
    assert.equal(response.kpis.total, 501);
    assert.ok(pipelines[1].some(stage => stage.$limit === 50));
    for (const pipeline of pipelines) {
      assert.equal(String(pipeline[0].$match.company), id);
      assert.equal(String(pipeline[1].$lookup.pipeline[0].$match.company), id);
    }
    let status;
    await pipelineRead({ user: { company: id }, query: { job: "bad" } }, { status(code) { status = code; return this; }, json() {} });
    assert.equal(status, 400);
  } finally { Candidate.aggregate = original; }
});
