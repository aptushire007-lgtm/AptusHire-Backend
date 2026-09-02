// DPDP data-retention enforcement (plan §5.2). Each tenant sets
// CompanySettings.compliance.retentionDays; this job hard-deletes candidate PII whose
// last activity (updatedAt) is older than that window — the resume file, identity photo,
// interview session (transcript lives inside it), interview-queue entry, usage events,
// and finally the candidate document. Active candidates keep getting touched (stage
// changes), so their updatedAt stays fresh and they're never caught by the window.
//
// This is DESTRUCTIVE. It runs in the worker process (or the API when it hosts workers),
// always in a system tenant-context with EXPLICIT company scoping on every query, and can
// be disabled with RETENTION_JOB_ENABLED=false. A per-company summary is written to the
// audit log.

const { schedule, cronTimezone } = require("../utils/cronSchedule");
const CompanySettings = require("../models/CompanySettings");
const Candidate = require("../models/Candidate");
const tenantContext = require("../utils/tenantContext");
const { writeAuditLog } = require("../middleware/auditLog");
const { purgeCandidateArtifacts } = require("../services/candidatePurgeService");

// Cap how many candidates a single run purges per tenant, so one overdue tenant can't
// turn a nightly tick into an unbounded delete storm. Remainder is picked up next run.
const MAX_PER_COMPANY_PER_RUN = Number(process.env.RETENTION_MAX_PER_RUN) || 500;

async function purgeCompany(companyId, retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const stale = await Candidate.find({ company: companyId, updatedAt: { $lt: cutoff } })
    .select("_id company resumePath")
    .limit(MAX_PER_COMPANY_PER_RUN);

  if (!stale.length) return 0;

  let purged = 0;
  for (const candidate of stale) {
    try {
      await purgeCandidateArtifacts(candidate);
      purged += 1;
    } catch (err) {
      console.error(`[retentionJob] failed to purge candidate ${candidate._id}:`, err.message);
    }
  }

  writeAuditLog({
    company: companyId,
    action: "retention.purge",
    resourceType: "Candidate",
    meta: { purged, retentionDays, cutoff, capped: stale.length >= MAX_PER_COMPANY_PER_RUN },
  });
  console.log(`[retentionJob] company ${companyId}: purged ${purged} candidate(s) older than ${retentionDays}d`);
  return purged;
}

async function runRetention() {
  const settings = await CompanySettings.find({}).select("company compliance");
  let totalPurged = 0;
  for (const s of settings) {
    const retentionDays = s.compliance?.retentionDays;
    if (!retentionDays || retentionDays < 1) continue; // no policy → skip (never purge blindly)
    try {
      totalPurged += await purgeCompany(s.company, retentionDays);
    } catch (err) {
      console.error(`[retentionJob] company ${s.company} failed:`, err.message);
    }
  }
  if (totalPurged) console.log(`[retentionJob] run complete — ${totalPurged} candidate(s) purged`);
  return totalPurged;
}

function startRetentionJob() {
  if (process.env.RETENTION_JOB_ENABLED === "false") {
    console.log("[retentionJob] disabled (RETENTION_JOB_ENABLED=false)");
    return;
  }
  // Daily at 03:00 — off-peak. runAsSystem so tenant scoping is bypassed and every query
  // below carries its own explicit { company } filter.
  schedule("0 3 * * *", () => {
    tenantContext
      .runAsSystem(() => runRetention())
      .catch((err) => console.error("[retentionJob] run failed:", err.message));
  });
  console.log(`[retentionJob] scheduled daily at 03:00 ${cronTimezone()}`);
}

module.exports = { startRetentionJob, runRetention };
