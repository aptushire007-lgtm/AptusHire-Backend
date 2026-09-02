// One place decides what clock scheduled work runs on.
//
// node-cron with no timezone option follows the CONTAINER clock, which is UTC on every
// managed host (Render, Fly, Heroku) and local time on a developer machine. So the same
// expression means different things in the two places it runs — "0 3 * * *" is 03:00 IST
// on a laptop in India and 08:30 IST in production. That matters most for retentionJob,
// which hard-deletes candidate PII: an operator reading "daily at 03:00" reasonably
// expects the quiet hours they work in, not the middle of a business morning.
//
// Default UTC, so behaviour is identical everywhere and the schedules stay legible next
// to INTERVIEW_SCHEDULE_HOUR_UTC, which is already UTC by name. Set CRON_TIMEZONE (an
// IANA name, e.g. Asia/Kolkata) to move them all together — never one job at a time,
// which is how two jobs meant to run in sequence end up five and a half hours apart.

const cron = require("node-cron");

function cronTimezone() {
  return process.env.CRON_TIMEZONE || "UTC";
}

function schedule(expression, handler) {
  return cron.schedule(expression, handler, { timezone: cronTimezone() });
}

module.exports = { schedule, cronTimezone };
