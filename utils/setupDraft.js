const crypto = require("crypto");

const STEPS = ["role", "evaluation", "journey", "review"];
const EMPTY = Object.freeze({ title: "", department: "", location: "", description: "", requirements: "", numberOfOpenings: "1", requiredSkills: "", minExperienceYears: "0", requiredEducation: "", atsThreshold: "60", interviewMinQuestions: "", interviewMaxQuestions: "", interviewInstructions: "", assessmentPolicy: "off" });
const LIMITS = { title: 200, department: 200, location: 300, description: 50000, requirements: 30000, requiredSkills: 5000, requiredEducation: 500, interviewInstructions: 10000 };
function problem(status, message, code, extra) { return Object.assign(new Error(message), { status, code, ...extra }); }
function key(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(value)) throw problem(400, "A valid request key is required.", "INVALID_REQUEST_KEY");
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw problem(400, "A saved draft revision is required.", "INVALID_REVISION");
  return value;
}
function normalize(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw problem(400, "Draft values must be an object.", "INVALID_DRAFT");
  for (const name of Object.keys(input)) if (!Object.hasOwn(EMPTY, name)) throw problem(400, `Unknown draft field: ${name}`, "INVALID_DRAFT");
  const values = { ...EMPTY };
  for (const name of Object.keys(EMPTY)) {
    if (input[name] === undefined) continue;
    if (typeof input[name] !== "string" || input[name].length > (LIMITS[name] || 40)) throw problem(400, `The ${name} field exceeds its supported format or length.`, "INVALID_DRAFT");
    values[name] = input[name];
  }
  return values;
}
function roleErrors(values) {
  const errors = {};
  if (!values.title.trim()) errors.title = "Enter a public role title.";
  if (!values.description.trim()) errors.description = "Add a description before creating the evaluation plan. You can save a title-only draft.";
  for (const [name, min, max, optional] of [["numberOfOpenings",1,10000], ["minExperienceYears",0,50], ["atsThreshold",0,100], ["interviewMinQuestions",1,30,true], ["interviewMaxQuestions",1,30,true]]) {
    if (optional && values[name] === "") continue;
    const value = Number(values[name]);
    if (!values[name].trim() || !Number.isInteger(value) || value < min || value > max) errors[name] = `Enter a whole number from ${min} to ${max}.`;
  }
  if (values.interviewMinQuestions && values.interviewMaxQuestions && Number(values.interviewMinQuestions) > Number(values.interviewMaxQuestions)) errors.interviewMaxQuestions = "Maximum questions must be at least the minimum.";
  if (!["off", "manual", "auto"].includes(values.assessmentPolicy)) errors.assessmentPolicy = "Choose an assessment policy.";
  return errors;
}
function toJob(values) {
  const result = { ...values, title: values.title.trim(), requiredSkills: values.requiredSkills.split(",").map(x => x.trim()).filter(Boolean) };
  for (const name of ["numberOfOpenings", "minExperienceYears", "atsThreshold"]) result[name] = Number(values[name]);
  for (const name of ["interviewMinQuestions", "interviewMaxQuestions"]) {
    if (values[name] === "") delete result[name]; else result[name] = Number(values[name]);
  }
  return result;
}
function digest(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
module.exports = { STEPS, EMPTY, key, revision, normalize, roleErrors, toJob, digest, problem };
