const { Queue } = require("bullmq");
const { getRedisConnection } = require("../config/redis");

let queue = null;
let attempted = false;

function getEmailQueue() {
  if (attempted) return queue;
  attempted = true;

  const connection = getRedisConnection();
  if (!connection) return null;

  queue = new Queue("email", { connection });
  return queue;
}

module.exports = { getEmailQueue };
