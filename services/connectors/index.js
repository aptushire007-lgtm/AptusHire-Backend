// Connector registry (BUILD-PLAN Phase 15.4) — every job board is a driver
// file behind ONE interface, tiered by what the board actually permits:
//
//   Tier A — open feed / internal (no contract): careers
//   Tier B — tenant-supplied credentials (BYO account): naukri, generic webhook
//   Tier C — platform partnership (built against recorded fixtures, shipped
//            DISABLED until partner approval lands): linkedin, indeed,
//            ziprecruiter
//
// Driver interface (all async unless noted):
//   key, name, tier, needsCredential (bool)
//   available() → { enabled, reason? }          — sync; Tier C returns disabled
//   validate(job) → [boardSpecificErrors]        — sync; empty = publishable
//   publish({ job, company, credential, existing }) → { externalRef, externalUrl }
//   update / withdraw / checkStatus ({ job?, credential, externalRef })
//
// Idempotency contract: publish() receives `existing` (the prior externalRef,
// if any) and MUST update-in-place rather than create a duplicate listing.

const careers = require("./careersDriver");
const webhook = require("./webhookDriver");
const naukri = require("./naukriDriver");
const linkedin = require("./linkedinDriver");
const indeed = require("./indeedDriver");
const ziprecruiter = require("./ziprecruiterDriver");

const DRIVERS = Object.fromEntries([careers, webhook, naukri, linkedin, indeed, ziprecruiter].map((d) => [d.key, d]));

function getDriver(board) {
  return DRIVERS[String(board || "").toLowerCase()] || null;
}

function listDrivers() {
  return Object.values(DRIVERS).map((d) => ({
    key: d.key,
    name: d.name,
    tier: d.tier,
    needsCredential: !!d.needsCredential,
    ...d.available(),
  }));
}

module.exports = { getDriver, listDrivers, DRIVERS };
