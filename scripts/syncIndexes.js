// Reconcile MongoDB indexes with the current schemas (Wave 6). Run on deploy — especially
// with MONGO_AUTO_INDEX=false / NODE_ENV=production, where the app no longer builds indexes
// on boot. Model.syncIndexes() creates any missing index AND drops indexes present in the
// collection but no longer declared (e.g. the single-field {company} indexes replaced by
// compound ones). Safe to run repeatedly; a no-op once the DB matches the schema.
//
//   npm run sync:indexes

require("dotenv").config();
require("../config/dnsOverride").applyDnsOverride();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const logger = require("../utils/logger");

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/recruitment";
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, autoIndex: false });

  // Require every model file so mongoose.models is fully populated before we sync.
  const modelsDir = path.join(__dirname, "..", "models");
  for (const file of fs.readdirSync(modelsDir)) {
    if (file.endsWith(".js")) require(path.join(modelsDir, file));
  }

  const names = Object.keys(mongoose.models).sort();
  logger.info("index sync starting", { models: names.length });
  for (const name of names) {
    try {
      const dropped = await mongoose.models[name].syncIndexes();
      logger.info("index synced", { model: name, dropped: dropped && dropped.length ? dropped : [] });
    } catch (err) {
      logger.error("index sync failed for model", { model: name, err: { message: err.message } });
    }
  }

  await mongoose.disconnect();
  logger.info("index sync complete");
}

main().catch((err) => {
  logger.error("index sync error", err);
  process.exit(1);
});
