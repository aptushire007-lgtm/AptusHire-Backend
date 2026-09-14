const test = require("node:test");
const assert = require("node:assert/strict");

const { generateJobDescription } = require("../../controllers/jobController");

test("generateJobDescription validates required title", async () => {
  let statusCode = 200;
  let jsonResult = null;
  const req = { body: { title: "   " } };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      jsonResult = data;
      return this;
    },
  };

  await generateJobDescription(req, res);
  assert.equal(statusCode, 400);
  assert.match(jsonResult.error, /Job title is required/i);
});

test("generateJobDescription generates structured JD with deterministic fallback", async () => {
  let statusCode = 200;
  let jsonResult = null;
  const req = {
    body: {
      title: "Senior React Developer",
      location: "Remote",
    },
  };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      jsonResult = data;
      return this;
    },
  };

  await generateJobDescription(req, res);
  assert.equal(statusCode, 200);
  assert.equal(jsonResult.title, "Senior React Developer");
  assert.equal(jsonResult.department, "Engineering");
  assert.equal(jsonResult.location, "Remote");
  assert.ok(jsonResult.description.length > 50);
  assert.ok(jsonResult.requirements.length > 30);
  assert.ok(Array.isArray(jsonResult.requiredSkills));
  assert.ok(jsonResult.requiredSkills.includes("React"));
  assert.equal(jsonResult.minExperienceYears, 5);
});

