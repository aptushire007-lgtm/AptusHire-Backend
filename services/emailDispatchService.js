const EmailLog = require("../models/EmailLog");
const { sendMail } = require("../utils/mailer");
const { getEmailQueue } = require("../queues/emailQueue");

// A failed send must never be silent — an EmailLog row nobody looks at is how
// "the OTP never arrived" stays undiagnosed for weeks. When the email belongs
// to a tenant, its admins get an in-app alert (no email attached — an email
// about a failing email must not itself loop through the failing pipeline);
// platform-level failures (auth emails have no company) are logged loudly.
async function alertEmailFailure(log) {
  console.error(
    `[emailDispatchService] EMAIL DELIVERY FAILED to ${log.to} (category=${log.category || "unknown"}): ${log.error}`
  );
  if (!log.company) return;
  try {
    // Lazy require: notificationService depends on this module.
    const { notifyAdmin } = require("./notificationService");
    await notifyAdmin({
      companyId: log.company,
      type: "system_alert",
      title: "An email to a candidate could not be delivered",
      message: `"${log.subject}" to ${log.to} failed to send (${log.error || "unknown error"}). The recipient has NOT received it — you may need to contact them another way.`,
      meta: { emailLogId: log._id, category: log.category },
    });
  } catch (err) {
    console.error("[emailDispatchService] could not raise email-failure alert:", err.message);
  }
}

async function sendInline(log, attempt = 1) {
  try {
    await sendMail({ to: log.to, subject: log.subject, text: log.text, html: log.html });
    log.status = "sent";
    log.attempts = attempt;
    log.sentAt = new Date();
    await log.save();
  } catch (err) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return sendInline(log, attempt + 1);
    }
    log.status = "failed";
    log.attempts = attempt;
    log.error = err.message;
    await log.save();
    await alertEmailFailure(log);
  }
}

// Every notification email (new or pre-existing) funnels through here so it
// gets an EmailLog audit trail and, when REDIS_URL is configured, real
// queue-based delivery with BullMQ's built-in retry/backoff. Without Redis
// configured (this project's default local setup) it sends inline with one
// manual retry, mirroring the try/catch-and-log pattern already used
// throughout the codebase for email sends.
async function dispatchEmail({ to, subject, text, html, category, relatedType, relatedId, company }) {
  if (!to) return null;

  const log = await EmailLog.create({ to, subject, text, html, category, relatedType, relatedId, company, status: "queued" });

  const queue = getEmailQueue();
  if (queue) {
    await queue.add(
      "send-email",
      { logId: String(log._id), to, subject, text, html },
      { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true, removeOnFail: false }
    );
    return log;
  }

  await sendInline(log);
  return log;
}

module.exports = { dispatchEmail, alertEmailFailure };
