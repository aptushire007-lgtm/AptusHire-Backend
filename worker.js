// Dedicated background-worker process for multi-instance production. Run exactly ONE
// of these (while the API instances run with RUN_WORKERS_IN_API=false) so the email
// queue is consumed and cron jobs fire once — not once per API replica.
//
//   npm run worker
//
// In single-instance dev/pilot you don't need this — the API process runs the workers
// itself by default.

require("dotenv").config();
// Must run before mongoose is required — this process connects to Mongo directly, so
// an SRV lookup fired before the override is applied still fails. server.js has always
// done this; without it here, DNS_SERVERS silently had no effect in the worker and a
// mongodb+srv:// URI failed with "querySrv ECONNREFUSED" on the networks it exists for.
require("./config/dnsOverride").applyDnsOverride();

const { validateEnv } = require("./config/env");
try {
  validateEnv();
} catch (err) {
  console.error("[worker] " + err.message);
  process.exit(1);
}

const mongoose = require("mongoose");
const connectDB = require("./config/db");
const { startEmailWorker } = require("./workers/emailWorker");
const { startPublishWorker } = require("./workers/publishWorker");
const { startSubscriptionExpiryJob } = require("./jobs/subscriptionExpiryJob");
const { startRetentionJob } = require("./jobs/retentionJob");
const { startPublishReconcileJob } = require("./jobs/publishReconcileJob");
const registry = require("./module-registry");

let emailWorker = null;

connectDB()
  .then(() => {
    // Core workers & crons (always started)
    emailWorker = startEmailWorker();
    if (!emailWorker) {
      console.warn("[worker] no Redis connection — the email queue will not be consumed");
    }
    startPublishWorker();
    startSubscriptionExpiryJob();
    startRetentionJob();
    startPublishReconcileJob();

    // Module-specific workers & crons (only for enabled modules)
    registry.startWorkers();
    registry.startCrons();

    console.log(`[worker] background worker started (core + modules: ${registry.getEnabledModules().join(", ")})`);
  })
  .catch((err) => {
    console.error("[worker] failed to start:", err);
    process.exit(1);
  });

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received — shutting down`);
  try {
    if (emailWorker) await emailWorker.close();
    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("[worker] error during shutdown:", err.message);
    process.exit(1);
  }
}
["SIGTERM", "SIGINT"].forEach((sig) => process.on(sig, () => shutdown(sig)));
