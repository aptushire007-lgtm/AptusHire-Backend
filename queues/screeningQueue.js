const { Queue } = require("bullmq");
const { getRedisConnection } = require("../config/redis");

let queue = null;
let attempted = false;

function getScreeningQueue() {
  if (attempted) return queue;
  attempted = true;

  const connection = getRedisConnection();
  if (!connection) return null;

  queue = new Queue("screening", { connection });
  return queue;
}

module.exports = { getScreeningQueue };
