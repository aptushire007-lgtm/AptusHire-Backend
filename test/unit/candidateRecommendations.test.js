const test = require("node:test");
const assert = require("node:assert/strict");
const { rankRecommendedJobs } = require("../../utils/candidateRecommendations");

test("ranks profile and resume domain matches ahead of newer unrelated jobs", () => {
  const jobs = [
    { _id: "unrelated", title: "Marketing Manager", requiredSkills: ["marketing"], createdAt: "2026-09-03T00:00:00.000Z" },
    { _id: "matched", title: "Senior React Developer", requiredSkills: ["React", "JavaScript"], createdAt: "2026-08-01T00:00:00.000Z" },
  ];
  const ranked = rankRecommendedJobs(jobs, {
    profile: { skills: ["React", "JavaScript"] },
    resumes: [],
    now: new Date("2026-09-03T00:00:00.000Z").getTime(),
  });
  assert.equal(ranked[0]._id, "matched");
  assert.deepEqual(ranked[0].matchedSkills, ["react", "javascript"]);
});

test("uses the default resume signals when profile skills are empty", () => {
  const ranked = rankRecommendedJobs(
    [
      { _id: "backend", title: "Backend Engineer", requiredSkills: ["Node.js"], createdAt: "2026-09-03T00:00:00.000Z" },
      { _id: "design", title: "Product Designer", requiredSkills: ["Figma"], createdAt: "2026-09-03T00:00:00.000Z" },
    ],
    { profile: { skills: [] }, resumes: [{ isDefault: true, tags: ["Backend"], parsedSnapshot: { skills: ["Node.js"] } }] }
  );
  assert.equal(ranked[0]._id, "backend");
});