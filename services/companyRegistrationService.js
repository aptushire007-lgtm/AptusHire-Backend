const crypto = require("crypto");
const Company = require("../models/Company");
const User = require("../models/User");
const OTPVerification = require("../models/OTPVerification");
const { hashPassword } = require("../utils/passwords");
const { isStrongPassword, isValidPhone } = require("../utils/validators");
const { generateOtp, hashOtp, computeExpiry, canResend, MAX_VERIFY_ATTEMPTS } = require("../utils/otp");
const { otpEmailTemplate } = require("../utils/emailTemplates");
const { dispatchEmail } = require("./emailDispatchService");
const { ServiceError } = require("../utils/errors");
const { notifyAdmin } = require("./notificationService");
const { activateIfBypassed } = require("./demoActivationService");

function generateCompanyCode() {
  return `CMP-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

async function sendCompanyOtp(email, companyName) {
  const existing = await OTPVerification.findOne({ email, purpose: "company_registration" }).sort({ createdAt: -1 });

  const resendCheck = canResend(existing && !existing.verified ? existing : null);
  if (!resendCheck.allowed) {
    throw new ServiceError(429, resendCheck.reason);
  }

  const otp = generateOtp();
  const otpHash = hashOtp(otp);
  const expiresAt = computeExpiry();

  if (existing && !existing.verified) {
    existing.otpHash = otpHash;
    existing.expiresAt = expiresAt;
    existing.sendCount += 1;
    existing.lastSentAt = new Date();
    existing.attempts = 0;
    await existing.save();
  } else {
    await OTPVerification.create({ email, purpose: "company_registration", otpHash, expiresAt });
  }

  // Audited dispatch path (EmailLog + retries + failure alerting) — the OTP is
  // the #1 "email never arrived" support case; every send must leave a trail.
  const tpl = otpEmailTemplate(companyName, otp);
  await dispatchEmail({ to: email, ...tpl, category: "company_otp", relatedType: "OTPVerification" });
}

async function registerCompany({ companyDetails, adminDetails }) {
  const { name, industry, companySize, website, gstNumber, country, state, city, address } = companyDetails;
  const { fullName, email, phone, password } = adminDetails;

  if (!name || !companySize || !country || !state || !city || !address) {
    throw new ServiceError(400, "Company name, size, country, state, city, and address are required");
  }
  if (!fullName || !email || !phone || !password) {
    throw new ServiceError(400, "Admin full name, email, phone, and password are required");
  }
  if (!isValidPhone(phone)) {
    throw new ServiceError(400, "Please provide a valid phone number");
  }
  if (!isStrongPassword(password)) {
    throw new ServiceError(
      400,
      "Password must be at least 8 characters and include an uppercase letter, a lowercase letter, a number, and a special character"
    );
  }

  const normalizedEmail = email.trim().toLowerCase();

  const existingUser = await User.findOne({ email: normalizedEmail });
  if (existingUser) {
    throw new ServiceError(409, "An account with this email already exists");
  }

  const existingCompany = await Company.findOne({ name: name.trim() });
  if (existingCompany) {
    throw new ServiceError(409, "A company with this name is already registered");
  }

  const company = await Company.create({
    companyCode: generateCompanyCode(),
    name: name.trim(),
    industry,
    companySize,
    website,
    gstNumber,
    country,
    state,
    city,
    address,
    status: "pending_payment",
  });

  const passwordHash = await hashPassword(password);
  // Recruiter-seat quota (Phase 11.1). At first registration no subscription
  // exists yet so this is a no-op — it binds the moment a plan is active, and
  // any future invite/add-recruiter flow MUST route through the same check.
  await require("./quotaService").enforce(company._id, "recruiters");
  const admin = await User.create({
    name: fullName.trim(),
    email: normalizedEmail,
    phone: phone.trim(),
    passwordHash,
    role: "admin",
    company: company._id,
    emailVerified: true,
  });

  return { company, admin };
}

async function resendCompanyOtp(email) {
  const normalizedEmail = email.trim().toLowerCase();
  const admin = await User.findOne({ email: normalizedEmail, role: "admin" });
  if (!admin || admin.emailVerified) {
    // Same response whether or not this is a real pending registration, to
    // avoid leaking which emails are registered.
    return;
  }
  const company = await Company.findById(admin.company);
  await sendCompanyOtp(normalizedEmail, company.name);
}

async function verifyCompanyOtp(email, otp) {
  const normalizedEmail = email.trim().toLowerCase();

  const record = await OTPVerification.findOne({ email: normalizedEmail, purpose: "company_registration" }).sort({
    createdAt: -1,
  });
  if (!record || record.verified) {
    throw new ServiceError(400, "No pending verification found for this email");
  }
  if (new Date() > record.expiresAt) {
    throw new ServiceError(400, "This code has expired. Please request a new one.");
  }
  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    throw new ServiceError(429, "Too many incorrect attempts. Please request a new code.");
  }
  if (hashOtp(otp) !== record.otpHash) {
    record.attempts += 1;
    await record.save();
    throw new ServiceError(400, "Incorrect code");
  }

  record.verified = true;
  await record.save();

  const admin = await User.findOne({ email: normalizedEmail, role: "admin" });
  if (!admin) throw new ServiceError(404, "Account not found");
  admin.emailVerified = true;
  await admin.save();

  const company = await Company.findById(admin.company);
  company.status = "pending_payment";
  await company.save();

  // Demo / pilot bypass: provision the workspace here instead of routing the
  // recruiter to plan selection. No-op when billing is enforced, which is the
  // default. See utils/billingMode.js.
  const activated = await activateIfBypassed(company);

  await notifyAdmin({
    companyId: company._id,
    type: "email_verified",
    title: "Email verified",
    message: activated
      ? `${admin.name}, your email is verified and your ${company.name} workspace is ready.`
      : `${admin.name}, your email is verified. Choose a subscription plan to activate your ${company.name} workspace.`,
  });

  return { company, admin };
}

module.exports = { registerCompany, resendCompanyOtp, verifyCompanyOtp };
