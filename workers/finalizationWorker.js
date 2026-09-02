// BullMQ consumer for the finalization queue (§3.8). Each job is one sessionId — runFinalization is
// already idempotent on aiInterview.evaluation.generatedAt (checked at the top of the function), so
// a BullMQ retry is safe and replaces the bespoke single-retry VersionError handling that used to
// live inline in scheduleFinalization.

const { Worker } = require("bullmq");
const { getRedisConnection } = require("../config/redis");
const tenantContext = require("../utils/tenantContext");
const aiInterviewService = require("../services/aiInterviewService");

function startFinalizationWorker() {
  const connection = getRedisConnection();
  if (!connection) return null;

  const worker = new Worker(
    "finalization",
    async (job) => {
      const { sessionId } = job.data;
      await tenantContext.runAsSystem(() => aiInterviewService.runFinalization(sessionId));
    },
    { connection }
  );

  worker.on("failed", (job, err) => {
    if (!job) return;
    console.error(`[finalizationWorker] job ${job.id} failed (attempt ${job.attemptsMade}):`, err.message);
  });

  console.log("[finalizationWorker] BullMQ finalization worker started");
  return worker;
}

module.exports = { startFinalizationWorker };
