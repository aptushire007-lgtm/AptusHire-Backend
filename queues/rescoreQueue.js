const { Queue } = require("bullmq");
const { getRedisConnection } = require("../config/redis");

let queue = null;
let attempted = false;

function getRescoreQueue() {
  if (attempted) return queue;
  attempted = true;

  const connection = getRedisConnection();
  if (!connection) return null;

  queue = new Queue("rescore", { connection });
  return queue;
}

module.exports = { getRescoreQueue };
