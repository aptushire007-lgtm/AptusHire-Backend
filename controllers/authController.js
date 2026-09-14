const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Company = require("../models/Company");
const RefreshToken = require("../models/RefreshToken");
const { hashPassword, comparePassword } = require("../utils/passwords");
const {
  hashToken,
  generateVerificationToken,
  generateResetToken,
  generateRefreshToken,
} = require("../utils/authTokens");
const { verificationEmailTemplate, passwordResetEmailTemplate } = require("../utils/emailTemplates");
const { isStrongPassword, isValidPhone, STRONG_PASSWORD_MESSAGE } = require("../utils/validators");
const { initializeDashboard } = require("./candidateDashboardController");
const { firstOrigin, candidateLinkBase } = require("../utils/corsOrigins");
const { notifyAdmin, notifyCandidate } = require("../services/notificationService");
const { dispatchEmail } = require("../services/emailDispatchService");
const { passwordChangedEmailTemplate } = require("../utils/emailTemplates");
const { writeAuditLog } = require("../middleware/auditLog");
const { billingEnforced } = require("../utils/billingMode");
const { activateIfBypassed } = require("../services/demoActivationService");
const { OAuth2Client } = require("google-auth-library");
const moduleRegistry = require("../module-registry");

// Short-lived access token — the frontends transparently refresh it via /auth/refresh.
// Configurable so ops can tune it without a code change. Refresh-token lifetime lives in
// authTokens.js (REFRESH_TOKEN_TTL_DAYS).
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || "2h";
const googleClient = new OAuth2Client();

function sanitizeUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    emailVerified: user.emailVerified,
    company: user.company || null,
  };
}

function signUser(user) {
  return jwt.sign({ userId: String(user._id), role: user.role }, process.env.AUTH_JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

// Issue a short-lived access token plus a persisted, rotating refresh token. Pass an
// existing `family` when rotating so the new token stays in the same lineage; omit it on
// a fresh login/verify to start a new family. Returns { token, refreshToken }.
async function issueTokens(user, req, family) {
  const gen = generateRefreshToken();
  await RefreshToken.create({
    user: user._id,
    tokenHash: gen.tokenHash,
    family: family || gen.family,
    expiresAt: gen.expiresAt,
    userAgent: req?.headers?.["user-agent"],
    ip: req?.ip,
  });
  return { token: signUser(user), refreshToken: gen.token };
}

function originForRole(role) {
  return role === "admin" || role === "superadmin"
    ? firstOrigin(process.env.CLIENT_ORIGIN_ADMIN, "http://localhost:5173")
    : candidateLinkBase();
}

async function sendVerificationForUser(user) {
  const { token, tokenHash, expiresAt } = generateVerificationToken();
  user.verificationTokenHash = tokenHash;
  user.verificationExpiresAt = expiresAt;
  await user.save();

  const verifyUrl = `${originForRole(user.role)}/verify-email/${token}`;
  // Audited dispatch path (EmailLog + queue retries + failure alerting) — an
  // account-verification email that silently dies is a user who can never log in.
  try {
    const tpl = verificationEmailTemplate(user, verifyUrl);
    await dispatchEmail({ to: user.email, ...tpl, category: "account_verification", relatedType: "User", relatedId: user._id });
  } catch (err) {
    console.error("Failed to dispatch verification email:", err.message);
  }
}

async function register(req, res) {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !phone || !password) {
    return res.status(400).json({ error: "name, email, phone, and password are required" });
  }
  if (!isValidPhone(phone)) {
    return res.status(400).json({ error: "Please provide a valid phone number" });
  }
  if (!isStrongPassword(password)) {
    return res.status(400).json({ error: STRONG_PASSWORD_MESSAGE });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  const passwordHash = await hashPassword(password);
  const user = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    phone: phone.trim(),
    passwordHash,
    role: "candidate",
    emailVerified: true,
  });

  await initializeDashboard(user._id, user.name, user.email);

  res.status(201).json({
    message: "Account created. You can log in now.",
    user: sanitizeUser(user),
  });
}

// Bootstraps a platform superadmin (not tied to any company). Company-scoped
// admin accounts are created automatically via the company registration +
// subscription flow (see companyAuthController), not through this endpoint.
// Constant-time compare so the signup key can't be recovered via response
// timing. timingSafeEqual requires equal-length buffers, so guard length first.
function signupKeyMatches(provided) {
  const expected = process.env.ADMIN_SIGNUP_KEY;
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided), "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function adminRegister(req, res) {
  const signupKey = req.headers["x-admin-signup-key"];
  if (!signupKeyMatches(signupKey)) {
    return res.status(403).json({ error: "Invalid admin signup key" });
  }

  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email, and password are required" });
  }
  if (!isStrongPassword(password)) {
    return res.status(400).json({ error: STRONG_PASSWORD_MESSAGE });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail });
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  const passwordHash = await hashPassword(password);
  const user = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    passwordHash,
    role: "superadmin",
    emailVerified: true,
  });

  res.status(201).json({
    message: "Superadmin account created. You can log in now.",
    user: sanitizeUser(user),
  });
}

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const user = await User.findOne({ email: email.trim().toLowerCase() });
  if (!user) {
    writeAuditLog({ req, action: "auth.login_failed", statusCode: 401, meta: { email: email.trim().toLowerCase() } });
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    writeAuditLog({
      req,
      action: "auth.login_failed",
      resourceType: "User",
      resourceId: user._id,
      company: user.company,
      statusCode: 401,
      meta: { email: user.email },
    });
    return res.status(401).json({ error: "Invalid email or password" });
  }

  if (user.role === "admin" && user.company) {
    const company = await Company.findById(user.company);

    // Demo / pilot bypass (BILLING_ENFORCEMENT=off, see utils/billingMode.js).
    // Rather than waving an unpaid tenant past the paywall into a workspace that
    // was never provisioned, promote it to a real one here — Subscription,
    // Workspace and CompanySettings included. Idempotent, and a no-op the moment
    // enforcement is restored. A MISSING company doc is not a billing state, so
    // that branch below still rejects regardless of the flag.
    const bypassBilling = !billingEnforced() && Boolean(company);
    if (bypassBilling) await activateIfBypassed(company);

    if (!bypassBilling && (!company || company.status === "pending_payment")) {
      // Authentication itself succeeded — only full product access is gated.
      // Issue tokens anyway so the frontend can carry the admin straight to
      // checkout instead of leaving them stuck if they closed the browser
      // mid-onboarding.
      const { token, refreshToken } = await issueTokens(user, req);
      return res.status(403).json({
        error: "Please complete your subscription payment to activate your workspace",
        code: "PAYMENT_REQUIRED",
        token,
        refreshToken,
        user: sanitizeUser(user),
      });
    }
    if (!bypassBilling && company.status === "suspended") {
      return res.status(403).json({
        error: "Your company workspace has been suspended. Please contact support.",
        code: "COMPANY_SUSPENDED",
      });
    }
  }

  const { token, refreshToken } = await issueTokens(user, req);
  writeAuditLog({
    req,
    action: "auth.login",
    resourceType: "User",
    resourceId: user._id,
    company: user.company,
    statusCode: 200,
  });
  res.json({ token, refreshToken, user: sanitizeUser(user) });
}

async function googleLogin(req, res) {
  const { credential } = req.body || {};
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(503).json({ error: "Google sign-in is not configured yet" });
  if (!credential) return res.status(400).json({ error: "Google credential is required" });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: clientId });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ error: "Google sign-in could not be verified" });
  }

  const email = String(payload?.email || "").trim().toLowerCase();
  if (!email || !payload?.email_verified || !payload?.sub) {
    return res.status(401).json({ error: "Google did not provide a verified email address" });
  }

  let user = await User.findOne({ email });
  if (!user) {
    // Google is the credential provider for this account; the random value keeps
    // the existing required passwordHash field unusable for password login.
    user = await User.create({
      name: String(payload.name || email.split("@")[0]).trim(),
      email,
      passwordHash: await hashPassword(crypto.randomBytes(32).toString("hex")),
      role: "candidate",
      emailVerified: true,
    });
    await initializeDashboard(user._id, user.name, user.email);
  } else if (user.role !== "candidate") {
    return res.status(403).json({ error: "This Google account cannot access the candidate portal" });
  } else if (!user.emailVerified) {
    user.emailVerified = true;
    await user.save();
  }

  const { token, refreshToken } = await issueTokens(user, req);
  writeAuditLog({ req, action: "auth.google_login", resourceType: "User", resourceId: user._id, statusCode: 200 });
  return res.json({ token, refreshToken, user: sanitizeUser(user) });
}

async function verifyEmail(req, res) {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token is required" });

  const user = await User.findOne({ verificationTokenHash: hashToken(token) });
  if (!user || !user.verificationExpiresAt || new Date() > user.verificationExpiresAt) {
    return res.status(400).json({ error: "This verification link is invalid or has expired" });
  }

  user.emailVerified = true;
  user.verificationTokenHash = undefined;
  user.verificationExpiresAt = undefined;
  await user.save();

  if (user.role === "candidate") {
    await initializeDashboard(user._id, user.name, user.email);
  }

  const issued = await issueTokens(user, req);
  res.json({
    message: "Email verified successfully",
    token: issued.token,
    refreshToken: issued.refreshToken,
    user: sanitizeUser(user),
  });
}

// Exchange a valid refresh token for a fresh access token + a rotated refresh token.
// Rotation + reuse-detection: presenting an already-rotated (revoked) token revokes the
// whole family (treat as theft). Public route — the refresh token IS the credential.
async function refresh(req, res) {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: "refreshToken is required" });

  const existing = await RefreshToken.findOne({ tokenHash: hashToken(refreshToken) });
  if (!existing) return res.status(401).json({ error: "Invalid session, please log in again" });

  if (existing.revokedAt) {
    await RefreshToken.updateMany(
      { family: existing.family, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    writeAuditLog({
      req,
      action: "auth.refresh_reuse",
      resourceType: "User",
      resourceId: existing.user,
      statusCode: 401,
      meta: { family: existing.family },
    });
    return res.status(401).json({ error: "Session invalidated, please log in again" });
  }
  if (existing.expiresAt < new Date()) {
    return res.status(401).json({ error: "Session expired, please log in again" });
  }

  const user = await User.findById(existing.user);
  if (!user) return res.status(401).json({ error: "Account not found" });

  // Claim the token atomically before minting its replacement. A concurrent request
  // presenting the same token must observe the revoked state and invalidate the family.
  const rotated = generateRefreshToken();
  const claimed = await RefreshToken.findOneAndUpdate(
    { _id: existing._id, revokedAt: null },
    { $set: { revokedAt: new Date(), replacedByHash: rotated.tokenHash } },
    { new: true }
  );
  if (!claimed) {
    await RefreshToken.updateMany(
      { family: existing.family, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    return res.status(401).json({ error: "Session invalidated, please log in again" });
  }

  await RefreshToken.create({
    user: user._id,
    tokenHash: rotated.tokenHash,
    family: existing.family,
    expiresAt: rotated.expiresAt,
    userAgent: req?.headers?.["user-agent"],
    ip: req?.ip,
  });
  res.json({ token: signUser(user), refreshToken: rotated.token, user: sanitizeUser(user) });
}

// Revoke the presented refresh token's entire family, ending that session lineage.
// Idempotent — always 200 so a stale/absent token doesn't leave the client stuck.
async function logout(req, res) {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    const existing = await RefreshToken.findOne({ tokenHash: hashToken(refreshToken) });
    if (existing && !existing.revokedAt) {
      await RefreshToken.updateMany(
        { family: existing.family, revokedAt: null },
        { $set: { revokedAt: new Date() } }
      );
    }
  }
  res.json({ message: "Logged out" });
}

async function resendVerification(req, res) {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });

  const user = await User.findOne({ email: email.trim().toLowerCase() });
  if (user && !user.emailVerified) {
    await sendVerificationForUser(user);
  }

  // Same response whether or not the account exists / is already verified,
  // so this endpoint can't be used to enumerate registered emails.
  res.json({ message: "If an unverified account exists for that email, a new verification link has been sent." });
}

async function forgotPassword(req, res) {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });

  const user = await User.findOne({ email: email.trim().toLowerCase() });
  if (user) {
    const { token, tokenHash, expiresAt } = generateResetToken();
    user.resetTokenHash = tokenHash;
    user.resetExpiresAt = expiresAt;
    await user.save();

    const resetUrl = `${originForRole(user.role)}/reset-password/${token}`;
    // Audited dispatch path — a swallowed reset email is a locked-out user
    // staring at a fake "email sent" success message.
    try {
      const tpl = passwordResetEmailTemplate(user, resetUrl);
      await dispatchEmail({ to: user.email, ...tpl, category: "password_reset", relatedType: "User", relatedId: user._id });
    } catch (err) {
      console.error("Failed to dispatch password reset email:", err.message);
    }
  }

  res.json({ message: "If an account exists for that email, a password reset link has been sent." });
}

async function resetPassword(req, res) {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "token and password are required" });
  if (!isStrongPassword(password)) return res.status(400).json({ error: STRONG_PASSWORD_MESSAGE });

  const user = await User.findOne({ resetTokenHash: hashToken(token) });
  if (!user || !user.resetExpiresAt || new Date() > user.resetExpiresAt) {
    return res.status(400).json({ error: "This reset link is invalid or has expired" });
  }

  user.passwordHash = await hashPassword(password);
  user.resetTokenHash = undefined;
  user.resetExpiresAt = undefined;
  await user.save();

  if (user.role === "admin" && user.company) {
    await notifyAdmin({
      companyId: user.company,
      type: "password_changed",
      title: "Password changed",
      message: `${user.name}'s account password was changed successfully.`,
    });
  } else {
    await notifyCandidate({
      userId: user._id,
      type: "password_changed",
      title: "Password changed",
      message: "Your account password was changed successfully.",
    });
  }

  const built = passwordChangedEmailTemplate(user);
  try {
    await dispatchEmail({
      to: user.email,
      subject: built.subject,
      text: built.text,
      html: built.html,
      category: "password_changed",
      relatedType: "User",
      relatedId: user._id,
    });
  } catch (err) {
    console.error("Failed to send password-changed email:", err.message);
  }

  res.json({ message: "Password reset successfully. You can now log in with your new password." });
}

async function me(req, res) {
  const sanitized = sanitizeUser(req.user);
  if (req.user.company) {
    const company = await Company.findById(req.user.company);
    if (company) {
      sanitized.company = {
        id: company._id,
        name: company.name,
        companyCode: company.companyCode,
        status: company.status,
      };
    }
  }
  // Lets the admin UI know up front whether /api/scorecards/* is even mounted (server.js),
  // instead of every candidate page probing it and eating a guaranteed 404 when the flag is off.
  sanitized.scorecardEngineEnabled =
    moduleRegistry.isModuleEnabled("interview") && process.env.SCORECARD_ENGINE_ENABLED === "true";
  res.json(sanitized);
}

module.exports = {
  register,
  adminRegister,
  login,
  googleLogin,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  refresh,
  logout,
  me,
};
