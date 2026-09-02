const { Worker } = require("bullmq");
const { getRedisConnection } = require("../config/redis");
const EmailLog = require("../models/EmailLog");
const { sendMail } = require("../utils/mailer");

function startEmailWorker() {
  const connection = getRedisConnection();
  if (!connection) return null;

  const worker = new Worker(
    "email",
    async (job) => {
      const { logId, to, subject, text, html } = job.data;
      await sendMail({ to, subject, text, html });
      await EmailLog.findByIdAndUpdate(logId, { status: "sent", sentAt: new Date(), $inc: { attempts: 1 } });
    },
    { connection }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const isFinalAttempt = job.attemptsMade >= (job.opts.attempts || 1);
    const log = await EmailLog.findByIdAndUpdate(
      job.data.logId,
      {
        status: isFinalAttempt ? "failed" : "retrying",
        error: err.message,
        $inc: { attempts: 1 },
      },
      { new: true }
    );
    console.error(`[emailWorker] job ${job.id} failed (attempt ${job.attemptsMade}):`, err.message);
    // Out of retries ⇒ the recipient is not getting this email. Same alert path
    // as the inline sender — a dead send is an incident, not a log line.
    if (isFinalAttempt && log) {
      const { alertEmailFailure } = require("../services/emailDispatchService");
      await alertEmailFailure(log).catch(() => {});
    }
  });

  console.log("[emailWorker] BullMQ email worker started");
  return worker;
}

module.exports = { startEmailWorker };
