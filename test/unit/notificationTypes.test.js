// Every `type` passed to notifyCandidate/notifyAdmin must exist in the matching
// model enum. This is a static source scan, so it needs no DB.
//
// Why this test exists: the whole assessment stage shipped with five notification
// types that were never added to the enums. Mongoose rejected the document, and
// because `Notification.create()` runs BEFORE the email dispatch inside
// notifyCandidate, the throw killed the email too:
//
//   - sendAssessment persisted the session and moved the stage, then threw — the
//     candidate saw "check your invitation email" for an email that never sent.
//   - resendAssessment rotated the token (invalidating the old link), saved, then
//     threw — so "Email me a fresh link" bricked the link and sent nothing.
//   - the two admin alerts are dispatched with `.catch(() => {})`, so the §3
//     rule 4/6 human-routing signals failed silently and nobody was paged.
//
// A missing enum entry is therefore not a cosmetic gap; it is a silent
// notification outage. Fail loudly at build time instead.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Notification = require("../../models/Notification");
const AdminNotification = require("../../models/AdminNotification");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", "test", ".git", "uploads", "coverage"]);
// Defines the helpers; its destructured parameter list is not a call site.
const SKIP_FILES = new Set([path.join("services", "notificationService.js")]);

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith(".js")) {
      const full = path.join(dir, entry.name);
      if (!SKIP_FILES.has(path.relative(BACKEND_ROOT, full))) out.push(full);
    }
  }
  return out;
}

// Walks from the object literal's opening brace to its match, staying out of
// strings and comments so a `}` inside either cannot end the object early.
function objectLiteralAt(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return src.slice(openIndex, i + 1);
  }
  return null;
}

function callSites(fnName) {
  const found = [];
  // `\b` keeps `type:` from matching `relatedType:` / `contentType:`.
  const typeKey = /\btype:\s*(?:"([\w]+)"|'([\w]+)')/;
  for (const file of sourceFiles(BACKEND_ROOT)) {
    const src = fs.readFileSync(file, "utf8");
    const call = new RegExp(`\\b${fnName}\\s*\\(\\s*\\{`, "g");
    let m;
    while ((m = call.exec(src)) !== null) {
      const open = src.indexOf("{", m.index + fnName.length);
      const body = objectLiteralAt(src, open);
      const where = `${path.relative(BACKEND_ROOT, file)}:${src.slice(0, m.index).split("\n").length}`;
      const hit = body && typeKey.exec(body);
      found.push({ where, type: hit ? hit[1] || hit[2] : null });
    }
  }
  return found;
}

// Table-driven dispatch: the type comes from a declared table, asserted below.
const KNOWN_DYNAMIC = new Set(["services/pipelineService.js", "services/scorecardService.js"]);

const CASES = [
  { fn: "notifyCandidate", model: Notification, field: "type" },
  { fn: "notifyAdmin", model: AdminNotification, field: "type" },
];

for (const { fn, model, field } of CASES) {
  const enumValues = model.schema.path(field).enumValues;

  test(`${fn}: every dispatched type is declared in the ${model.modelName} enum`, () => {
    const sites = callSites(fn);
    assert.ok(sites.length > 0, `found no ${fn} call sites — the scanner is broken, not the code`);

    const missing = sites.filter((s) => s.type && !enumValues.includes(s.type));
    assert.deepEqual(
      missing,
      [],
      `${fn} dispatches type(s) absent from the ${model.modelName} enum — these throw at ` +
        `create() and take the email/alert down with them:\n` +
        missing.map((s) => `  - "${s.type}" at ${s.where}`).join("\n")
    );
  });

  // A non-literal type is invisible to the scan above, so each one needs its own
  // coverage. The table behind these two is checked directly further down; any
  // NEW dynamic site fails here until someone does the same for it.
  test(`${fn}: every non-literal call site has dedicated enum coverage`, () => {
    const dynamic = callSites(fn)
      .filter((s) => !s.type)
      .filter((s) => !KNOWN_DYNAMIC.has(s.where.replace(/\\/g, "/").replace(/:\d+$/, "")));
    assert.deepEqual(
      dynamic,
      [],
      `${fn} called with a non-literal type and no dedicated test at:\n` +
        dynamic.map((s) => `  - ${s.where}`).join("\n")
    );
  });

  test(`${model.modelName}: enum has no duplicate entries`, () => {
    assert.equal(new Set(enumValues).size, enumValues.length, `duplicate value in ${model.modelName}.${field}`);
  });
}

// dispatchStageNotifications reads its type from this table and its throw is NOT
// caught by applyTransition, so a gap here does not merely drop a notification —
// it aborts the stage transition that triggered it.
test("STAGE_NOTIFICATIONS: every stage's types are declared in the enums", () => {
  const { STAGE_NOTIFICATIONS, DEFAULT_NOTIFICATION } = require("../../services/pipelineService");
  const entries = [...Object.entries(STAGE_NOTIFICATIONS), ["<default>", DEFAULT_NOTIFICATION]];
  assert.ok(entries.length > 1, "stage notification table did not load");

  const missing = [];
  for (const [stage, config] of entries) {
    if (config?.candidate && !Notification.schema.path("type").enumValues.includes(config.candidate.type)) {
      missing.push(`  - stage "${stage}" candidate type "${config.candidate.type}" not in Notification enum`);
    }
    if (config?.admin && !AdminNotification.schema.path("type").enumValues.includes(config.admin.type)) {
      missing.push(`  - stage "${stage}" admin type "${config.admin.type}" not in AdminNotification enum`);
    }
  }
  assert.deepEqual(missing, [], `stage transitions would throw mid-move:\n${missing.join("\n")}`);
});

// scorecardService dispatches through a `send()` helper, so its types are
// invisible to the scan above. They are the rule 4 routing signals for human
// rounds — a swallowed enum miss here is a contradiction nobody gets told about.
test("SCORECARD ALERT_TYPES: every scorecard alert type is declared in the enum", () => {
  const { ALERT_TYPES } = require("../../services/scorecardService");
  const types = Object.values(ALERT_TYPES);
  assert.ok(types.length > 0, "scorecard alert table did not load");
  for (const type of types) {
    const err = new AdminNotification({ type, title: "t", message: "m" }).validateSync();
    assert.equal(err?.errors?.type, undefined, `AdminNotification rejected type "${type}"`);
  }
});

// The enum is the gate that actually runs in production — prove the documents
// the assessment stage builds now validate, rather than trusting the list scan.
test("assessment notifications validate against their models", () => {
  for (const type of ["assessment_invite", "assessment_reminder"]) {
    const err = new Notification({ type, title: "t", message: "m" }).validateSync();
    assert.equal(err?.errors?.type, undefined, `Notification rejected type "${type}"`);
  }
  for (const type of ["assessment_decision_needed", "assessment_contradiction", "assessment_softlock"]) {
    const err = new AdminNotification({ type, title: "t", message: "m" }).validateSync();
    assert.equal(err?.errors?.type, undefined, `AdminNotification rejected type "${type}"`);
  }
});
