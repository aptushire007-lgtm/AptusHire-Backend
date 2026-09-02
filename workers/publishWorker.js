// BullMQ consumer for the job-publish queue (Phase 15.4). Each job is one
// (publication, action) pair; processPublication owns idempotency, the circuit
// breaker, and masked error persistence. Retries/backoff come from the job
// options set at enqueue time; a job that exhausts its attempts is the
// dead-letter case — its PublishedJob row is already `failed` with the masked
// error, which is exactly what the publish UI surfaces.

const { Worker } = require("bullmq");
const { getRedisConnection } = require("../config/redis");
const tenantContext = require("../utils/tenantContext");
const { processPublication } = require("../services/jobPublishService");

function startPublishWorker() {
  const connection = getRedisConnection();
  if (!connection) return null;

  const worker = new Worker(
    "job-publish",
    async (job) => {
      const { publicationId, action } = job.data;
      const row = await tenantContext.runAsSystem(() => processPublication(publicationId, action));
      // A failed publish attempt must fail the BullMQ job so retry/backoff kicks in.
      if (action === "publish" && row && row.status === "failed") {
        throw new Error(row.error || "publish failed");
      }
    },
    { connection }
  );

  worker.on("failed", (job, err) => {
    if (!job) return;
    console.error(`[publishWorker] job ${job.id} failed (attempt ${job.attemptsMade}):`, err.message);
  });

  console.log("[publishWorker] BullMQ job-publish worker started");
  return worker;
}

module.exports = { startPublishWorker };
