const mongoose = require("mongoose");
const logger = require("../utils/logger");
const { applyDnsOverride } = require("./dnsOverride");

async function connectDB() {
  // Must run before mongoose.connect fires the mongodb+srv:// SRV lookup — see
  // dnsOverride.js for why this is sometimes necessary even when DNS looks fine otherwise.
  applyDnsOverride();

  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/recruitment";
  const isProd = process.env.NODE_ENV === "production";

  // Connection-pool + timeout tuning (Wave 6). Defaults are sized for a pilot on a single
  // VPS (<50 tenants); override via env when the replica set / instance count grows.
  //  - maxPoolSize caps concurrent sockets per instance — with N API instances the cluster
  //    sees up to N × maxPoolSize, so keep it modest to stay under the mongod connection cap.
  //  - minPoolSize keeps warm sockets so the first request after idle isn't slow.
  //  - serverSelectionTimeoutMS fails fast (instead of the 30s default) when Mongo is down.
  //  - autoIndex is OFF in production: building indexes on boot can block a large collection;
  //    run `npm run sync:indexes` on deploy instead. It stays ON in dev for convenience.
  const options = {
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 50,
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 5,
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 8000,
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS) || 45000,
    maxIdleTimeMS: Number(process.env.MONGO_MAX_IDLE_TIME_MS) || 60000,
    autoIndex: process.env.MONGO_AUTO_INDEX ? process.env.MONGO_AUTO_INDEX === "true" : !isProd,
  };

  // Surface pool/topology problems as structured logs instead of silent stalls.
  const conn = mongoose.connection;
  conn.on("disconnected", () => logger.warn("mongo disconnected"));
  conn.on("reconnected", () => logger.info("mongo reconnected"));
  conn.on("error", (err) => logger.error("mongo connection error", { err: { message: err.message } }));

  await mongoose.connect(uri, options);
  logger.info("mongo connected", { maxPoolSize: options.maxPoolSize, autoIndex: options.autoIndex });
}

module.exports = connectDB;
