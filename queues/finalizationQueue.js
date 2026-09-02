const { Queue } = require("bullmq");
const { getRedisConnection } = require("../config/redis");

let queue = null;
let attempted = false;

function getFinalizationQueue() {
  if (attempted) return queue;
  attempted = true;

  const connection = getRedisConnection();
  if (!connection) return null;

  queue = new Queue("finalization", { connection });
  return queue;
}

module.exports = { getFinalizationQueue };
