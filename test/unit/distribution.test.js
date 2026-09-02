// Phase 15 acceptance gates — distribution:
//   - the careers page carries a JSON-LD JobPosting with every Google-mandatory
//     field, renders ONLY published jobs, and escapes tenant input (XSS);
//   - the feed/careers render is cached — a crawl loop doesn't re-query Mongo;
//   - a Tier B publish round-trips against the recorded Naukri fixture:
//     publish → status → withdraw, and RE-publish updates the existing
//     listing (idempotent — never a duplicate);
//   - Tier C connectors are built but DISABLED ("awaiting partner approval");
//   - board credentials are AES-256-GCM encrypted at rest, never echoed, and
//     error masking strips secret values;
//   - per-board circuit breaker: one board's outage fails fast, not queued;
//   - source capture sanitises input; source-quality is computed from
//     downstream truth (pass/verify/advance/hire), never click counts.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");

const careersService = require("../../services/careersService");
const boardCredentialService = require("../../services/boardCredentialService");
const naukri = require("../../services/connectors/naukriDriver");
const linkedin = require("../../services/connectors/linkedinDriver");
const { listDrivers } = require("../../services/connectors");
const jobPublishService = require("../../services/jobPublishService");
const { sourceQuality } = require("../../utils/analyticsEngine");
const Job = require("../../models/Job");
const Company = require("../../models/Company");
const CompanySettings = require("../../models/CompanySettings");
const BoardCredential = require("../../models/BoardCredential");
const PublishedJob = require("../../models/PublishedJob");

// Recorded connector exchanges live under test/recorded/ — deliberately OUTSIDE
// test/fixtures/, whose PII guard enforces synthetic-résumé rules that would
// (correctly) reject board names and API URLs.
const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "recorded", "naukri-api.json"), "utf8"));

function fixtureHttp({ method, path: p }) {
  const rec = FIXTURES[`${method} ${p}`];
  if (!rec) {
    const err = new Error(`No recorded fixture for ${method} ${p}`);
    err.status = 404;
    throw err;
  }
  if (rec.status >= 400) {
    const err = new Error(rec.body?.message || `status ${rec.status}`);
    err.status = rec.status;
    throw err;
  }
  return rec.body;
}

const originals = {
  jobFind: Job.find,
  jobFindOne: Job.findOne,
  settingsFindOne: CompanySettings.findOne,
  companyFindById: Company.findById,
  naukriHttp: naukri._http,
  credFindOne: BoardCredential.findOne,
  pubFindById: PublishedJob.findById,
  pubFindOneAndUpdate: PublishedJob.findOneAndUpdate,
};
afterEach(() => {
  Job.find = originals.jobFind;
  Job.findOne = originals.jobFindOne;
  CompanySettings.findOne = originals.settingsFindOne;
  Company.findById = originals.companyFindById;
  naukri._http = originals.naukriHttp;
  BoardCredential.findOne = originals.credFindOne;
  PublishedJob.findById = originals.pubFindById;
  PublishedJob.findOneAndUpdate = originals.pubFindOneAndUpdate;
  careersService.cacheClear();
  jobPublishService.breakerReset();
  delete process.env.BOARD_CRED_ENC_KEY;
});

const COMPANY = {
  _id: new mongoose.Types.ObjectId(),
  name: "Acme <script>alert(1)</script> Ltd",
  slug: "acme-ltd",
  city: "Pune",
  state: "MH",
  country: "IN",
  website: "https://acme.example",
  status: "active",
};

function publishedJob(over = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    title: "Senior Backend Engineer",
    department: "Engineering",
    location: "Pune",
    description: "Build the evidence-bound hiring engine with Node.js and MongoDB. ".repeat(3),
    status: "published",
    slug: "senior-backend-1a2b3c",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-20T00:00:00Z"),
    company: COMPANY._id,
    ...over,
  };
}

function stubJobFind(jobs) {
  let calls = 0;
  Job.find = () => {
    calls += 1;
    return { sort: () => ({ limit: async () => jobs }) };
  };
  CompanySettings.findOne = () => ({ select: async () => ({ branding: { primaryColor: "#123abc" } }) });
  return () => calls;
}

// ---------------------------------------------------------------------------
// Careers page + feed
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: JSON-LD carries every Google-mandatory JobPosting field", () => {
  const ld = careersService.jobPostingJsonLd(publishedJob(), COMPANY);
  assert.equal(ld["@type"], "JobPosting");
  for (const field of ["title", "datePosted", "validThrough", "hiringOrganization", "jobLocation", "description"]) {
    assert.ok(ld[field], `${field} is mandatory — a missing field silently drops the listing from Google`);
  }
  assert.equal(ld.hiringOrganization.name, COMPANY.name);
  assert.ok(ld.jobLocation.address.addressCountry, "country present");
  assert.ok(new Date(ld.validThrough) > new Date(ld.datePosted), "validThrough after datePosted");
});

test("ACCEPTANCE GATE: careers page escapes tenant input — no raw <script> from company/job text", async () => {
  stubJobFind([publishedJob({ title: 'Engineer "<img onerror=x>"' })]);
  const { body } = await careersService.renderCareersPage(COMPANY);
  assert.ok(!body.includes("<script>alert(1)</script>"), "company name script tag neutralised");
  assert.ok(!body.includes("<img onerror"), "job title html neutralised");
  assert.ok(body.includes("&lt;script&gt;"), "escaped, not dropped");
  // JSON-LD scripts are OURS (application/ld+json), with < escaped inside.
  assert.ok(body.includes('<script type="application/ld+json">'));
});

test("ACCEPTANCE GATE: renders query ONLY published jobs, and the cache absorbs a crawl loop", async () => {
  const calls = stubJobFind([publishedJob()]);
  await careersService.renderCareersPage(COMPANY);
  await careersService.renderCareersPage(COMPANY);
  await careersService.renderCareersPage(COMPANY);
  assert.equal(calls(), 1, "three renders → one Mongo query (60s cache)");

  // The status filter itself is pinned at the source level: publishedJobs()
  // must ask for status "published" explicitly.
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "services", "careersService.js"), "utf8");
  assert.match(src, /status:\s*"published"/, "the only job query filter is status: published");
});

test("feed: Indeed-style XML with CDATA-wrapped fields", async () => {
  stubJobFind([publishedJob()]);
  const { body, contentType } = await careersService.renderJobsFeed(COMPANY);
  assert.ok(contentType.includes("xml"));
  assert.ok(body.includes("<source>"));
  assert.ok(body.includes("<![CDATA[Senior Backend Engineer]]>"));
  assert.ok(body.includes("referencenumber"));
  assert.ok(body.includes("expirationdate"));
});

// ---------------------------------------------------------------------------
// Naukri driver — recorded-fixture round-trip
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: Tier B publish round-trips the recorded Naukri fixture — publish → status → withdraw", async () => {
  naukri._http = fixtureHttp;
  const credential = { clientId: "acme-rms", apiKey: "sk-fixture-key" };
  const job = publishedJob();

  const pub = await naukri.publish({ job, credential, existing: null });
  assert.equal(pub.externalRef, "NKR-88231");
  assert.ok(pub.externalUrl.includes("NKR-88231"));

  const status = await naukri.checkStatus({ credential, externalRef: pub.externalRef });
  assert.equal(status.status, "published");

  await naukri.withdraw({ credential, externalRef: pub.externalRef }); // must not throw
});

test("ACCEPTANCE GATE: re-publish is idempotent — updates the existing listing (PUT), never creates a duplicate", async () => {
  const seen = [];
  naukri._http = (req) => {
    seen.push(`${req.method} ${req.path}`);
    return fixtureHttp(req);
  };
  const credential = { clientId: "acme-rms", apiKey: "sk-fixture-key" };
  const out = await naukri.publish({ job: publishedJob(), credential, existing: "NKR-88231" });
  assert.equal(out.externalRef, "NKR-88231", "same externalRef survives");
  assert.deepEqual(seen, ["PUT /v1/jobs/NKR-88231"], "an existing ref means PUT, never POST");
});

test("naukri validation surfaces board-specific requirements before any API call", () => {
  const errors = naukri.validate(publishedJob({ department: "" }));
  assert.ok(errors.some((e) => /functional area/.test(e)), "the Naukri functional-area rule is named");
});

test("Tier C connectors exist behind the same interface but ship disabled", () => {
  assert.equal(linkedin.available().enabled, false);
  assert.match(linkedin.available().reason, /awaiting partner approval/);
  const drivers = listDrivers();
  for (const key of ["linkedin", "indeed", "ziprecruiter"]) {
    const d = drivers.find((x) => x.key === key);
    assert.ok(d, `${key} driver registered`);
    assert.equal(d.enabled, false);
  }
  // Enabling one is a config change, not a code change.
  process.env.LINKEDIN_PARTNER_ENABLED = "true";
  assert.equal(linkedin.available().enabled, true);
  delete process.env.LINKEDIN_PARTNER_ENABLED;
});

// ---------------------------------------------------------------------------
// Board credentials — encrypted at rest, masked everywhere
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: credentials encrypt at rest and never appear in masked errors", () => {
  process.env.BOARD_CRED_ENC_KEY = "a".repeat(64);
  const secrets = { clientId: "acme-rms", apiKey: "super-secret-token-9931" };

  const envelope = boardCredentialService.encrypt(secrets);
  assert.ok(!JSON.stringify(envelope).includes("super-secret-token-9931"), "ciphertext ≠ plaintext");
  assert.deepEqual(boardCredentialService.decrypt(envelope), secrets, "round-trips");

  const masked = boardCredentialService.maskError(
    'Naukri API says: invalid key "super-secret-token-9931" for client acme-rms',
    secrets
  );
  assert.ok(!masked.includes("super-secret-token-9931"), "secret stripped from error");
  assert.ok(!masked.includes("acme-rms"), "every credential value stripped");
});

test("credential saves without a platform key fail loud with 503, not silently plaintext", () => {
  delete process.env.BOARD_CRED_ENC_KEY;
  assert.throws(
    () => boardCredentialService.encrypt({ apiKey: "x".repeat(10) }),
    (err) => err.status === 503 && err.code === "BOARD_CREDS_UNCONFIGURED"
  );
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

test("circuit breaker: a failing board fails fast after the threshold instead of hammering", async () => {
  process.env.BOARD_CRED_ENC_KEY = "a".repeat(64);
  const rowState = { board: "naukri", status: "pending", attempts: 0, save: async function () {} };
  PublishedJob.findById = async () => ({ ...rowState, save: async function () { Object.assign(rowState, this); } });
  Job.findOne = () => ({ select: () => ({}) , then: undefined });
  Job.findOne = async () => publishedJob();
  Company.findById = async () => COMPANY;
  BoardCredential.findOne = async () => null; // no credential → every publish throws

  let driverCalls = 0;
  naukri._http = () => {
    driverCalls += 1;
    throw new Error("boom");
  };

  for (let i = 0; i < jobPublishService.BREAKER_THRESHOLD; i += 1) {
    await jobPublishService.processPublication("x", "publish");
  }
  const row = await jobPublishService.processPublication("x", "publish");
  assert.match(row.error, /circuit open/, "the breaker short-circuits after repeated failures");
});

// ---------------------------------------------------------------------------
// Source capture + source quality
// ---------------------------------------------------------------------------

test("sourceQuality: downstream truth per channel — pass, verify, advance, hire", () => {
  const c = (channel, { decision, stages = ["applied"], probes } = {}) => ({
    _id: new mongoose.Types.ObjectId(),
    source: channel ? { channel } : undefined,
    ats: { decision },
    stageHistory: stages.map((s) => ({ stage: s })),
    __probes: probes,
  });
  const cands = [
    c("naukri", { decision: "pass", stages: ["applied", "ats_passed"] }),
    c("naukri", { decision: "fail" }),
    c("referral", { decision: "pass", stages: ["applied", "shortlisted", "offer_accepted"] }),
    c(null, { decision: "fail" }),
  ];
  const probes = new Map([
    [String(cands[0]._id), [{ verdict: "contradicted" }]],
    [String(cands[2]._id), [{ verdict: "verified" }]],
  ]);
  const rows = sourceQuality(cands, probes);

  const naukriRow = rows.find((r) => r.channel === "naukri");
  assert.equal(naukriRow.applied, 2);
  assert.equal(naukriRow.atsPassRate, 0.5);
  assert.equal(naukriRow.contradicted, 1);
  assert.equal(naukriRow.advanced, 0);

  const referral = rows.find((r) => r.channel === "referral");
  assert.equal(referral.advanceRate, 1);
  assert.equal(referral.verificationRate, 1);
  assert.equal(referral.hires, 1);

  assert.ok(rows.some((r) => r.channel === "(untagged)"), "untagged applies stay visible, not dropped");
});

test("GUARDRAIL: Candidate.source is analytics-only — no scoring path reads it", () => {
  for (const file of ["utils/evidenceScorer.js", "utils/atsEngine.js", "services/atsService.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", file), "utf8");
    assert.ok(
      !/candidate\.source|\bsource\.channel\b/.test(src),
      `${file} must never read the candidate's application source`
    );
  }
});
