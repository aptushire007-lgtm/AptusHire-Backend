// Break-glass account recovery for when mail delivery is down.
//
// The forgot-password endpoint is deliberately blind: it returns the same generic
// "if an account exists, a link has been sent" whether or not the send succeeded, because
// telling the caller otherwise would leak which addresses are registered. That is the right
// trade-off for the public endpoint and the wrong one for the operator, who is left with a
// locked-out user and no way to hand them a link. This script is that way.
//
//   npm run recover -- --stuck                              list accounts with a live reset token
//   npm run recover -- user@example.com                     mint a reset link and print it
//   npm run recover -- user@example.com --verify-email      mark the address verified
//   npm run recover -- user@example.com --set-password=Xy1@ set a password directly
//
// Nothing here sends email. Deliver the link out of band (Slack, phone, in person) and treat
// the printed URL as a live credential: anyone holding it can take the account until it
// expires. Prefer --reset-link over --set-password so the user picks their own secret and
// you never know it.
require("dotenv").config();
require("../config/dnsOverride").applyDnsOverride();

const mongoose = require("mongoose");
const User = require("../models/User");
const { generateResetToken } = require("../utils/authTokens");
const { hashPassword } = require("../utils/passwords");
const { firstOrigin, candidateLinkBase } = require("../utils/corsOrigins");
const { isStrongPassword, STRONG_PASSWORD_MESSAGE } = require("../utils/validators");

// Mirrors authController.originForRole — the reset page lives in a different SPA for
// recruiters than for candidates, and a link built against the wrong origin 404s.
function originForRole(role) {
  return role === "admin" || role === "superadmin"
    ? firstOrigin(process.env.CLIENT_ORIGIN_ADMIN, "http://localhost:5173")
    : candidateLinkBase();
}

function parseArgs(argv) {
  const opts = { email: null, verifyEmail: false, setPassword: null, stuck: false };
  for (const arg of argv) {
    if (arg === "--stuck") opts.stuck = true;
    else if (arg === "--verify-email") opts.verifyEmail = true;
    else if (arg.startsWith("--set-password=")) opts.setPassword = arg.slice("--set-password=".length);
    else if (!arg.startsWith("--")) opts.email = arg.trim().toLowerCase();
  }
  return opts;
}

async function listStuck() {
  const users = await User.find({ resetTokenHash: { $exists: true, $ne: null } })
    .select("email role resetExpiresAt emailVerified")
    .sort({ resetExpiresAt: -1 })
    .lean();

  if (!users.length) {
    console.log("No accounts are holding an unused password-reset token.");
    return;
  }

  console.log(`\n${users.length} account(s) requested a reset that was never completed:\n`);
  for (const u of users) {
    const expired = !u.resetExpiresAt || u.resetExpiresAt < new Date();
    console.log(
      `  ${u.email.padEnd(38)} ${u.role.padEnd(10)} token ${expired ? "EXPIRED" : "valid until " + u.resetExpiresAt.toISOString()}`
    );
  }
  console.log(
    "\nAn unused token usually means the email never arrived. Check delivery with `npm run check:mail`,\n" +
      "then mint a fresh link per user with `npm run recover -- <email>`.\n"
  );
}

async function recover(opts) {
  const user = await User.findOne({ email: opts.email });
  if (!user) throw new Error(`No user with email ${opts.email}`);

  console.log(`\nAccount : ${user.email}`);
  console.log(`Role    : ${user.role}`);
  console.log(`Verified: ${user.emailVerified}`);

  if (opts.verifyEmail && !user.emailVerified) {
    user.emailVerified = true;
    user.verificationTokenHash = undefined;
    user.verificationExpiresAt = undefined;
    console.log("\nACTION: email marked verified (login will no longer be refused).");
  } else if (opts.verifyEmail) {
    console.log("\nACTION: --verify-email skipped, address was already verified.");
  }

  if (opts.setPassword) {
    if (!isStrongPassword(opts.setPassword)) throw new Error(`--set-password rejected: ${STRONG_PASSWORD_MESSAGE}`);
    user.passwordHash = await hashPassword(opts.setPassword);
    user.resetTokenHash = undefined;
    user.resetExpiresAt = undefined;
    await user.save();
    console.log(`\nACTION: password set directly by operator at ${new Date().toISOString()}.`);
    console.log("        Tell the user to change it after logging in — you know this secret, they should own it.");
    return;
  }

  const { token, tokenHash, expiresAt } = generateResetToken();
  user.resetTokenHash = tokenHash;
  user.resetExpiresAt = expiresAt;
  await user.save();

  const url = `${originForRole(user.role)}/reset-password/${token}`;
  const minutes = Math.round((expiresAt - Date.now()) / 60000);

  console.log("\nRESET LINK (single use, expires in " + minutes + " minutes):\n");
  console.log("  " + url + "\n");
  console.log("Treat this as a live credential — deliver it directly to the account owner and");
  console.log("re-run this command if it expires before they use it.");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.stuck && !opts.email) {
    console.error("Usage:\n  npm run recover -- --stuck\n  npm run recover -- <email> [--verify-email] [--set-password=Secret1@]");
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not set. Run this from the backend/ directory so it picks up backend/.env");
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  try {
    if (opts.stuck) await listStuck();
    else await recover(opts);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("\nERROR: " + err.message);
  process.exit(1);
});
