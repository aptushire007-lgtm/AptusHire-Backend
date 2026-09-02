const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  register,
  adminRegister,
  login,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  refresh,
  logout,
  me,
} = require("../controllers/authController");
const { requireAuth } = require("../middleware/auth");
const { createLimiter } = require("../middleware/rateLimit");

const router = express.Router();

// Every credential-accepting endpoint here was previously unthrottled, while /api/companies
// (OTP) and /api/interview-portal both were — so this closes an inconsistency, not a gap in
// capability. Redis-backed (shared across instances) when REDIS_URL is set.

// Key by email+IP, not IP alone: a shared office NAT or a corporate proxy puts hundreds of
// legitimate users behind one address, and IP-only keying locks all of them out when one
// person fatfingers a password. Falls back to IP when no email is supplied.
const credentialKey = (req) => {
  const email = String(req.body?.email || "").toLowerCase().trim();
  return email ? `${email}|${req.ip}` : String(req.ip);
};

// Tight: online password guessing / credential stuffing.
const loginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  prefix: "rl:auth:login:",
  keyGenerator: credentialKey,
  message: "Too many sign-in attempts. Please wait a few minutes and try again.",
});

// Tight AND email-keyed: these send mail, so an attacker could otherwise use them to
// mail-bomb a victim's inbox or burn the SMTP quota.
const emailActionLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  prefix: "rl:auth:email:",
  keyGenerator: credentialKey,
  message: "Too many requests for this email address. Please try again later.",
});

// Looser, IP-keyed: signup abuse and refresh-token guessing. Refresh needs enough headroom
// for a legitimate user with several tabs open, each rotating on its own schedule.
const signupLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  prefix: "rl:auth:signup:",
  message: "Too many accounts created from this address. Please try again later.",
});
const refreshLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  prefix: "rl:auth:refresh:",
  message: "Too many token refreshes. Please sign in again.",
});

router.post("/register", signupLimiter, register);
router.post("/admin/register", signupLimiter, adminRegister);
router.post("/login", loginLimiter, login);
router.post("/verify-email", emailActionLimiter, verifyEmail);
router.post("/resend-verification", emailActionLimiter, resendVerification);
router.post("/forgot-password", emailActionLimiter, forgotPassword);
router.post("/reset-password", emailActionLimiter, resetPassword);
router.post("/refresh", refreshLimiter, refresh);
router.post("/logout", logout);
router.get("/me", requireAuth, me);

module.exports = wrapRouter(router);
