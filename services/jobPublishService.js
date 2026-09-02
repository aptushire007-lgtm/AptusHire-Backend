// Publish orchestration (BUILD-PLAN Phase 15.4 / 15.8). One action publishes a
// job to N boards; each (job, board) pair is an idempotent PublishedJob row —
// re-publish updates the board's existing listing via its externalRef, never a
// duplicate. Per-board failure lands on that board's row (masked), never
// silently, and never blocks the other boards.
//
// Delivery: BullMQ queue with retry/backoff when REDIS_URL is configured
// (mirroring email dispatch), inline otherwise. A per-board circuit breaker
// stops one board's outage from backing up the rest: after N consecutive
// failures the board is skipped (rows fail fast with a clear error) until the
// cool-off elapses.

const PublishedJob = require("../models/PublishedJob");
const Job = require("../models/Job");
const Company = require("../models/Company");
const CompanySettings = require("../models/CompanySettings");
const { getDriver } = require("./connectors");
const boardCredentialService = require("./boardCredentialService");
const { writeAuditLog } = require("../middleware/auditLog");

const MAX_ATTEMPTS = 3;
const BREAKER_THRESHOLD = 5;
const BREAKER_COOL_OFF_MS = 5 * 60 * 1000;

// board → { failures, openedAt }
const breaker = new Map();

function breakerOpen(board) {
  const b = breaker.get(board);
  if (!b || b.failures < BREAKER_THRESHOLD) return false;
  if (Date.now() - b.openedAt > BREAKER_COOL_OFF_MS) {
    breaker.delete(board); // half-open: let the next attempt probe
    return false;
  }
  return true;
}
function breakerRecord(board, ok) {
  if (ok) {
    breaker.delete(board);
    return;
  }
  const b = breaker.get(board) || { failures: 0, openedAt: 0 };
  b.failures += 1;
  if (b.failures >= BREAKER_THRESHOLD && !b.openedAt) b.openedAt = Date.now();
  breaker.set(board, b);
}
function breakerReset() {
  breaker.clear();
}

function publishingEnabled(settings) {
  const override = settings?.publishing?.enabled;
  if (typeof override === "boolean") return override;
  return process.env.JOB_PUBLISHING_ENABLED !== "false";
}

let queue = null;
let queueAttempted = false;
function getPublishQueue() {
  if (queueAttempted) return queue;
  queueAttempted = true;
  const { getRedisConnection } = require("../config/redis");
  const connection = getRedisConnection();
  if (!connection) return null;
  const { Queue } = require("bullmq");
  queue = new Queue("job-publish", { connection });
  return queue;
}

// Execute one action ("publish" | "withdraw" | "sync") for one PublishedJob row.
async function processPublication(publicationId, action = "publish") {
  const row = await PublishedJob.findById(publicationId);
  if (!row) return null;
  const driver = getDriver(row.board);
  if (!driver) return null;

  const job = await Job.findOne({ _id: row.job, company: row.company });
  const company = await Company.findById(row.company);
  const credential = driver.needsCredential ? await boardCredentialService.loadSecrets(row.company, row.board) : null;

  if (breakerOpen(row.board)) {
    row.status = action === "publish" ? "failed" : row.status;
    row.error = `${driver.name} is temporarily unavailable (circuit open) — will retry automatically`;
    await row.save();
    return row;
  }

  try {
    if (action === "publish") {
      if (driver.needsCredential && !credential) throw new Error(`${driver.name} credentials are not configured`);
      const out = await driver.publish({ job, company, credential, existing: row.externalRef || null });
      row.status = "published";
      row.externalRef = out.externalRef || row.externalRef;
      row.externalUrl = out.externalUrl || row.externalUrl;
      row.error = undefined;
      row.publishedAt = row.publishedAt || new Date();
    } else if (action === "withdraw") {
      await driver.withdraw({ job, company, credential, externalRef: row.externalRef });
      row.status = "withdrawn";
      row.withdrawnAt = new Date();
      row.error = undefined;
    } else if (action === "sync") {
      if (!row.externalRef) return row;
      const out = await driver.checkStatus({ job, company, credential, externalRef: row.externalRef });
      if (out.status && out.status !== row.status && row.status !== "withdrawn") {
        // Never auto-republish a withdrawn listing; expiry-driven changes are audited.
        row.status = out.status;
        if (out.status === "expired") {
          writeAuditLog({
            company: row.company,
            action: "publish.expired",
            resourceType: "PublishedJob",
            resourceId: String(row._id),
            meta: { board: row.board, externalRef: row.externalRef },
          });
        }
      }
      if (out.externalUrl) row.externalUrl = out.externalUrl;
    }
    row.lastSyncedAt = new Date();
    breakerRecord(row.board, true);
  } catch (err) {
    breakerRecord(row.board, false);
    row.attempts = (row.attempts || 0) + 1;
    row.error = boardCredentialService.maskError(err.message, credential);
    if (action === "publish") row.status = "failed";
  }
  await row.save();
  return row;
}

// Enqueue with retry/backoff when Redis is present, else run inline once
// (inline failures surface immediately on the row; the reconcile job retries).
async function dispatch(publicationId, action) {
  const q = getPublishQueue();
  if (q) {
    await q.add(
      "publish-action",
      { publicationId: String(publicationId), action },
      { attempts: MAX_ATTEMPTS, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100, removeOnFail: 500 }
    );
    return;
  }
  await processPublication(publicationId, action);
}

// One action → N boards. Upserts the per-board row (idempotency anchor), runs
// board-specific validation BEFORE any network call, and dispatches the rest.
async function publishToBoards(job, boards, actor) {
  const settings = await CompanySettings.findOne({ company: job.company }).select("publishing");
  if (!publishingEnabled(settings)) {
    const err = new Error("Job publishing is not enabled for this workspace");
    err.status = 403;
    throw err;
  }

  const results = [];
  for (const board of boards) {
    const driver = getDriver(board);
    if (!driver) {
      results.push({ board, status: "failed", error: "Unknown board" });
      continue;
    }
    const availability = driver.available();
    if (!availability.enabled) {
      results.push({ board, status: "failed", error: `Not available: ${availability.reason}` });
      continue;
    }
    const validationErrors = driver.validate(job);
    if (validationErrors.length) {
      results.push({ board, status: "failed", error: validationErrors.join(" · ") });
      continue;
    }

    const row = await PublishedJob.findOneAndUpdate(
      { company: job.company, job: job._id, board: driver.key },
      { $setOnInsert: { tier: driver.tier }, $set: { status: "pending", error: null } },
      { upsert: true, new: true }
    );
    await dispatch(row._id, "publish");
    results.push({ board: driver.key, status: "dispatched", publicationId: row._id });
  }

  writeAuditLog({
    company: job.company,
    action: "publish.requested",
    resourceType: "Job",
    resourceId: String(job._id),
    // No req here (service layer) — carry the actor in meta explicitly.
    meta: { boards: results.map((r) => r.board), actorEmail: actor?.email, actorUserId: actor?._id },
  });

  return results;
}

// Lifecycle sync (15.8): closing/unpublishing/deleting a job withdraws it from
// every board it went to. Fire-and-forget from the job controller.
async function withdrawAllForJob(jobId, companyId, reason) {
  const rows = await PublishedJob.find({ company: companyId, job: jobId, status: { $in: ["pending", "published", "failed"] } });
  for (const row of rows) {
    await dispatch(row._id, "withdraw");
  }
  if (rows.length) {
    writeAuditLog({
      company: companyId,
      action: "publish.withdraw_all",
      resourceType: "Job",
      resourceId: String(jobId),
      meta: { boards: rows.map((r) => r.board), reason },
    });
  }
  return rows.length;
}

// Nightly reconcile (15.8): re-check every live listing so the UI never shows
// "published" for a listing the board dropped; local validThrough expiry is
// respected even when a board has no status API.
async function reconcileAll() {
  const careersService = require("./careersService");
  const rows = await PublishedJob.find({ status: "published" }).limit(2000);
  let synced = 0;
  for (const row of rows) {
    const job = await Job.findOne({ _id: row.job, company: row.company }).select("status updatedAt createdAt");
    if (!job || job.status !== "published") {
      await dispatch(row._id, "withdraw");
      continue;
    }
    if (careersService.validThrough(job) < new Date()) {
      row.status = "expired";
      row.lastSyncedAt = new Date();
      await row.save();
      writeAuditLog({
        company: row.company,
        action: "publish.expired",
        resourceType: "PublishedJob",
        resourceId: String(row._id),
        meta: { board: row.board, reason: "validThrough elapsed" },
      });
      continue;
    }
    await dispatch(row._id, "sync");
    synced += 1;
  }
  return { checked: rows.length, synced };
}

module.exports = {
  publishToBoards,
  withdrawAllForJob,
  processPublication,
  reconcileAll,
  publishingEnabled,
  getPublishQueue,
  breakerReset,
  BREAKER_THRESHOLD,
};
