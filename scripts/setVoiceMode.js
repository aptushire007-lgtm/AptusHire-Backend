// Switch a company's voice-interview pipeline from the CLI — the per-tenant rollout lever.
//
//   node scripts/setVoiceMode.js <company-email-or-id> <turn_based|livekit|unset>
//
//   node scripts/setVoiceMode.js admin@demo.test livekit      # demo tenant → LiveKit realtime
//   node scripts/setVoiceMode.js admin@demo.test turn_based   # back to turn-based (rollback)
//   node scripts/setVoiceMode.js admin@demo.test unset        # defer to the VOICE_MODE env default
//
// The two modes are mutually exclusive by construction (an explicit choice pins the tenant to
// exactly one pipeline — livekitService.isEnabled), and the switch takes effect on the NEXT
// interview session; a live interview is never yanked mid-conversation. Same change is available
// to recruiters via PUT /api/company-settings {ai:{voiceMode}}.

require("dotenv").config();
require("../config/dnsOverride").applyDnsOverride();
const mongoose = require("mongoose");

const User = require("../models/User");
const CompanySettings = require("../models/CompanySettings");

const MODES = ["turn_based", "livekit", "unset"];

async function main() {
  const [target, modeArg] = process.argv.slice(2);
  const mode = String(modeArg || "").toLowerCase();
  if (!target || !MODES.includes(mode)) {
    console.error(`Usage: node scripts/setVoiceMode.js <admin-email-or-companyId> <${MODES.join("|")}>`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  let companyId = null;
  if (/^[a-f0-9]{24}$/i.test(target)) {
    companyId = target;
  } else {
    const admin = await User.findOne({ email: target.toLowerCase(), role: "admin" });
    if (!admin?.company) throw new Error(`No company admin found for "${target}"`);
    companyId = admin.company;
  }

  const update = mode === "unset" ? { $unset: { "ai.voiceMode": "" } } : { $set: { "ai.voiceMode": mode } };
  await CompanySettings.updateOne({ company: companyId }, update, { upsert: true });

  const effective =
    mode === "unset" ? `env default (VOICE_MODE=${process.env.VOICE_MODE || "turn_based"})` : mode;
  console.log(`company ${companyId}: voiceMode → ${effective}`);
  console.log("Takes effect on the next interview session. Rollback is this same command — no deploy.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
