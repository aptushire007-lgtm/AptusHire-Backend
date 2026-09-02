// RoleRubric model guards (BUILD-PLAN Phase 3). Schema-level validation runs
// offline via validateSync; the frozen-immutability decision logic is a pure
// exported checker (frozenViolation) so it is testable without a DB. The full
// hook wiring (post-init capture, save rejection, query-update ban) is exercised
// live against Mongo by scripts/smokeRubric.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const RoleRubric = require("../../models/RoleRubric");

function validDoc(overrides = {}) {
  return new RoleRubric({
    job: new mongoose.Types.ObjectId(),
    company: new mongoose.Types.ObjectId(),
    version: 1,
    sourceHash: "abc123",
    criteria: [
      {
        id: "c1",
        label: "Node.js proficiency",
        kind: "must_have",
        weight: 1,
        rationale: "The JD lists Node.js as required.",
        evidenceTypes: ["skill"],
      },
    ],
    thresholds: { advance: 60, review: 45 },
    compiledBy: { engine: "fallback", at: new Date() },
    ...overrides,
  });
}

test("a valid rubric passes schema validation", () => {
  assert.equal(validDoc().validateSync(), undefined);
});

test("GUARDRAIL: a criterion without a rationale is rejected by the schema", () => {
  const missing = validDoc();
  missing.criteria[0].rationale = undefined;
  assert.ok(missing.validateSync(), "missing rationale must fail validation");

  // Whitespace-only rationale trims to "" and must also fail.
  const blank = validDoc();
  blank.criteria[0].rationale = "   ";
  assert.ok(blank.validateSync(), "blank rationale must fail validation");
});

test("thresholds: review above advance is rejected", () => {
  const doc = validDoc({ thresholds: { advance: 50, review: 60 } });
  const err = doc.validateSync();
  assert.ok(err, "review > advance must fail");
  assert.match(String(err.message), /review/);
});

test("compiledBy.engine only admits ai|fallback — provenance cannot be vague", () => {
  const doc = validDoc({ compiledBy: { engine: "mystery", at: new Date() } });
  assert.ok(doc.validateSync());
});

test("frozenViolation: drafts are freely mutable", () => {
  assert.equal(RoleRubric.frozenViolation(false, ["criteria", "thresholds"], "draft"), null);
});

test("frozenViolation: a frozen rubric rejects any content change", () => {
  const msg = RoleRubric.frozenViolation(true, ["criteria", "criteria.0.weight", "updatedAt"], "approved");
  assert.match(msg, /frozen/);
  assert.match(msg, /criteria/);
});

test("frozenViolation: the ONLY change a frozen rubric admits is status → archived", () => {
  assert.equal(RoleRubric.frozenViolation(true, ["status", "updatedAt"], "archived"), null);
  assert.match(RoleRubric.frozenViolation(true, ["status"], "draft"), /only change to "archived"/);
  assert.match(RoleRubric.frozenViolation(true, ["status", "frozenAt"], "archived"), /frozen/);
});

test("frozenViolation: touching frozenAt itself is a violation (no unfreezing)", () => {
  assert.match(RoleRubric.frozenViolation(true, ["frozenAt"], "approved"), /frozenAt/);
});
