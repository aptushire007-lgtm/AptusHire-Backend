// BullMQ consumer for the rescore queue (§1.1). Same shape as screeningWorker.js — a separate
// queue so screening and rescore are independently observable/scalable, but both jobs reload fresh
// docs and call the same unchanged runAtsForCandidate through atsService.runAtsJob.

const { Worker } = require("bullmq");
const { getRedisConnection } = require("../config/redis");
const tenantContext = require("../utils/tenantContext");
const atsService = require("../services/atsService");

function startRescoreWorker() {
  const connection = getRedisConnection();
  if (!connection) return null;

  const worker = new Worker(
    "rescore",
    async (job) => {
      const { candidateId, jobId } = job.data;
      await tenantContext.runAsSystem(() => atsService.runAtsJob(candidateId, jobId));
    },
    { connection }
  );

  worker.on("failed", (job, err) => {
    if (!job) return;
    console.error(`[rescoreWorker] job ${job.id} failed (attempt ${job.attemptsMade}):`, err.message);
    if (job.attemptsMade >= (job.opts.attempts || 1)) {
      const { candidateId, jobId } = job.data;
      atsService.notifyRescoreFailure(candidateId, jobId, err).catch(() => {});
    }
  });

  console.log("[rescoreWorker] BullMQ rescore worker started");
  return worker;
}

module.exports = { startRescoreWorker };
