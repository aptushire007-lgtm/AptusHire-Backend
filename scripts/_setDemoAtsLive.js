// One-off: flip the seeded Demo Company onto the live evidence engine (Claim -> Probe -> Verdict)
// so the guided dry-run actually exercises the differentiated scorer, not the legacy keyword ATS.
require("dotenv").config();
require("../config/dnsOverride").applyDnsOverride();
const mongoose = require("mongoose");
const Company = require("../models/Company");
const CompanySettings = require("../models/CompanySettings");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const company = await Company.findOne({ name: "Demo Company" });
  if (!company) throw new Error("Demo Company not found — run npm run seed:demo first");

  const settings = await CompanySettings.findOneAndUpdate(
    { company: company._id },
    { $set: { "ai.atsEngine": "live" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log("Demo Company:", company._id.toString());
  console.log("ai.atsEngine now:", settings.ai.atsEngine);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
