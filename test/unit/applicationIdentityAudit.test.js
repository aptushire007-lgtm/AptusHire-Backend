const { test } = require("node:test");
const assert = require("node:assert/strict");
const { auditApplicationIdentities: audit } = require("../../utils/applicationIdentityAudit");
const app = (id, fields = {}) => ({ _id: id, company: "tenant-a", ...fields });
test("same account across jobs groups without changing application evidence", () => {
  const input = [app("1", { candidateUser: "u", resumeHash: "a" }), app("2", { candidateUser: "u", resumeHash: "b" })];
  const copy = structuredClone(input);
  assert.equal(audit(input).groups.length, 1);
  assert.deepEqual(audit(input), audit([...input].reverse()));
  assert.deepEqual(input, copy);
});
test("the same identity is isolated by company", () => {
  assert.equal(audit([app("1", { candidateUser: "u" }), app("2", { company: "tenant-b", candidateUser: "u" })]).groups.length, 2);
});
test("shared normalized email flags a review, never merges accounts", () => {
  const result = audit([app("1", { candidateUser: "u", basicDetails: { email: " A@EXAMPLE.COM " } }), app("2", { candidateUser: "v", basicDetails: { email: "a@example.com" } })]);
  assert.equal(result.groups.length, 2);
  assert.equal(result.review.length, 1);
  assert.ok(!JSON.stringify(result).includes("example.com"));
});
test("missing identities remain separate and plus aliases are not collapsed", () => {
  const result = audit([app("1", { basicDetails: { email: "a@example.com" } }), app("2", { basicDetails: { email: "a+tag@example.com" } })]);
  assert.equal(result.unlinkedApplications, 2);
  assert.equal(result.groups.length, 2);
  assert.equal(result.review.length, 0);
});
test("invalid tenant and duplicate IDs fail closed", () => {
  assert.throws(() => audit([app("1", { company: null })]));
  assert.throws(() => audit([app("1"), app("1")]));
});
test("one profile linked to different accounts is a review conflict", () => {
  const result = audit([app("1", { candidateUser: "u", candidateProfile: "p" }), app("2", { candidateUser: "v", candidateProfile: "p" })]);
  assert.equal(result.groups.length, 2);
  assert.equal(result.review[0].reason, "profile_has_distinct_identity_links");
});
