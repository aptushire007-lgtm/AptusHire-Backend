// BullMQ consumer for the screening queue (§1.1). Each job is one (candidateId, jobId) pair —
// runAtsJob reloads both fresh and calls the existing, unchanged runAtsForCandidate. Retries/backoff
// come from the job options set at enqueue time (atsService.enqueueScreening); only once every
// attempt is exhausted does the admin get the "did not complete" alert, via the failed handler below.

const { Worker } = require("bullmq");
const { getRedisConnection } = require("../config/redis");
const tenantContext = require("../utils/tenantContext");
const atsService = require("../services/atsService");

function startScreeningWorker() {
  const connection = getRedisConnection();
  if (!connection) return null;

  const worker = new Worker(
    "screening",
    async (job) => {
      const { candidateId, jobId } = job.data;
      await tenantContext.runAsSystem(() => atsService.runAtsJob(candidateId, jobId));
    },
    { connection }
  );

  worker.on("failed", (job, err) => {
    if (!job) return;
    console.error(`[screeningWorker] job ${job.id} failed (attempt ${job.attemptsMade}):`, err.message);
    if (job.attemptsMade >= (job.opts.attempts || 1)) {
      const { candidateId, jobId } = job.data;
      atsService.notifyScreeningFailure(candidateId, jobId, err).catch(() => {});
    }
  });

  console.log("[screeningWorker] BullMQ screening worker started");
  return worker;
}

module.exports = { startScreeningWorker };
