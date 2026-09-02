const IORedis = require("ioredis");

let connection = null;
let attempted = false;

// Redis/BullMQ are optional infrastructure: if REDIS_URL isn't configured
// (e.g. local dev on this machine), emailDispatchService falls back to
// sending inline instead of queueing, the same graceful-degrade pattern the
// codebase already uses for Razorpay (razorpayService.isConfigured()).
function getRedisConnection() {
  if (attempted) return connection;
  attempted = true;

  if (!process.env.REDIS_URL) {
    console.log("[redis] REDIS_URL not set — emails will be sent inline instead of via the BullMQ queue");
    return null;
  }

  connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on("error", (err) => console.error("[redis] connection error:", err.message));
  return connection;
}

// Dedicated pub/sub client pair for the Socket.io Redis adapter. A subscriber
// connection can't issue normal commands, so these must be separate from the shared
// BullMQ connection above. Returns null when Redis isn't configured (single-instance dev).
function getRedisPubSub() {
  if (!process.env.REDIS_URL) return null;
  const pub = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const sub = pub.duplicate();
  pub.on("error", (err) => console.error("[redis] pub error:", err.message));
  sub.on("error", (err) => console.error("[redis] sub error:", err.message));
  return { pub, sub };
}

module.exports = { getRedisConnection, getRedisPubSub };
