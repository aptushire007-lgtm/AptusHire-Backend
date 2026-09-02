// One-off: flip Demo Company's CompanySettings.proctoring.evidenceClips to true so the new
// blurred attention_pattern trigger (and the existing identity/multi-face triggers) are actually
// reachable in a live dry run, without touching the fleet-wide EVIDENCE_CLIPS_ENABLED default.
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
    { $set: { "proctoring.evidenceClips": true } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log("Demo Company:", company._id.toString());
  console.log("proctoring.evidenceClips now:", settings.proctoring.evidenceClips);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
