const crypto = require("crypto");
const mongoose = require("mongoose");
const CandidateProfile = require("../models/CandidateProfile");
const GovDocument = require("../models/GovDocument");
const ResumeVersion = require("../models/ResumeVersion");
const Candidate = require("../models/Candidate");
const InterviewSession = require("../models/InterviewSession");
const OTPVerification = require("../models/OTPVerification");
const storageService = require("../services/storageService");
const { detectFileType } = require("../utils/verifyFileSignature");
const { generateOtp, hashOtp, computeExpiry, canResend, MAX_VERIFY_ATTEMPTS } = require("../utils/otp");
const { otpEmailTemplate } = require("../utils/emailTemplates");
const { dispatchEmail } = require("../services/emailDispatchService");

const OTP_CHANNELS = new Set(["email"]);
const GOVERNMENT_DOCUMENT_TYPES = new Set(["aadhaar", "passport", "driving_license", "pan", "national_id"]);

function computeProfileStrength(profile, hasDefaultResume) {
  let score = 0;
  // 1. Core fields (Name, Location, Headline, Bio) -> 15 pts
  if (profile.personal?.firstName && profile.personal?.lastName && profile.headline) {
    score += 15;
  } else if (profile.headline && profile.location) {
    score += 10;
  }
  // 2. Email verification -> 10 pts
  if (profile.verification?.emailVerified) score += 10;
  // 3. Phone verification -> 10 pts
  if (profile.verification?.phoneVerified) score += 10;
  // 4. Gov Document verification -> 20 pts
  if (profile.verification?.govDocVerified) score += 20;
  // 5. LinkedIn connected -> 10 pts
  if (profile.verification?.linkedinLinked) score += 10;
  // 6. Education entry -> 10 pts
  if (profile.education && profile.education.length > 0) score += 10;
  // 7. Experience entry -> 10 pts
  if (profile.experience && profile.experience.length > 0) score += 10;
  // 8. Default Resume active -> 15 pts
  if (hasDefaultResume) score += 15;

  return Math.min(100, Math.max(0, score));
}

async function getFullProfile(req, res) {
  const user = req.user;
  let profile = await CandidateProfile.findOne({ user: user._id });
  if (!profile) {
    profile = await CandidateProfile.create({
      user: user._id,
      headline: "Software Engineer",
      personal: {
        firstName: user.name?.split(" ")[0] || "",
        lastName: user.name?.split(" ").slice(1).join(" ") || "",
        phone: user.phone || "",
      },
    });
  }

  // Prepopulate personal from user if missing
  if (!profile.personal?.firstName && user.name) {
    const parts = user.name.split(" ");
    profile.personal = profile.personal || {};
    profile.personal.firstName = parts[0];
    profile.personal.lastName = parts.slice(1).join(" ");
  }

  // Prepopulate email verification if user.emailVerified is true
  if (user.emailVerified && !profile.verification?.emailVerified) {
    profile.verification = profile.verification || {};
    profile.verification.emailVerified = true;
    profile.verification.emailVerifiedAt = new Date();
  }

  const documents = await GovDocument.find({ user: user._id }).sort({ createdAt: -1 });
  const hasDefaultResume = (await ResumeVersion.countDocuments({ user: user._id, isDefault: true, isArchived: false })) > 0;

  const strength = computeProfileStrength(profile, hasDefaultResume);
  profile.strengthScore = strength;
  profile.profileCompletionPercent = strength;
  await profile.save();

  res.json({
    profile: {
      ...profile.toObject(),
      user: {
        name: user.name,
        email: user.email,
        phone: user.phone || "",
      },
    },
    documents,
    hasDefaultResume,
    strengthScore: strength,
  });
}

async function updatePersonalInfo(req, res) {
  const user = req.user;
  const { firstName, lastName, dob, phone, locationCity, photoUrl, headline, bio } = req.body;

  for (const [field, value] of Object.entries({ firstName, lastName, dob, phone, locationCity, photoUrl, headline, bio })) {
    if (value !== undefined && typeof value !== "string") {
      return res.status(400).json({ error: `${field} must be a string` });
    }
  }

  let profile = await CandidateProfile.findOne({ user: user._id });
  if (!profile) profile = new CandidateProfile({ user: user._id });

  profile.personal = profile.personal || {};
  if (firstName !== undefined) profile.personal.firstName = firstName.trim();
  if (lastName !== undefined) profile.personal.lastName = lastName.trim();
  if (dob !== undefined) profile.personal.dob = dob ? new Date(dob) : null;
  if (phone !== undefined) profile.personal.phone = phone.trim();
  if (locationCity !== undefined) {
    profile.personal.locationCity = locationCity.trim();
    profile.location = locationCity.trim();
  }
  if (photoUrl !== undefined) profile.personal.photoUrl = photoUrl;
  if (headline !== undefined) {
    profile.personal.headline = headline.trim();
    profile.headline = headline.trim();
  }
  if (bio !== undefined) {
    profile.personal.bio = bio.trim();
    profile.bio = bio.trim();
  }

  const hasDefaultResume = (await ResumeVersion.countDocuments({ user: user._id, isDefault: true, isArchived: false })) > 0;
  profile.strengthScore = computeProfileStrength(profile, hasDefaultResume);
  await profile.save();

  res.json({ ok: true, profile });
}

async function sendOtp(req, res) {
  const { channel, target } = req.body; // channel = 'email' | 'phone'
  const user = req.user;

  if (!OTP_CHANNELS.has(channel)) {
    return res.status(400).json({ error: "Only email verification is currently supported" });
  }

  const email = user.email.toLowerCase();
  const existing = await OTPVerification.findOne({ email, purpose: `verify_${channel}` }).sort({ createdAt: -1 });
  const resendCheck = canResend(existing && !existing.verified ? existing : null);
  if (!resendCheck.allowed) return res.status(429).json({ error: resendCheck.reason });

  const code = generateOtp();
  const otpHash = hashOtp(code);
  const expiresAt = computeExpiry();
  if (existing && !existing.verified) {
    existing.otpHash = otpHash;
    existing.expiresAt = expiresAt;
    existing.sendCount += 1;
    existing.lastSentAt = new Date();
    existing.attempts = 0;
    await existing.save();
  } else {
    await OTPVerification.create({ email, purpose: `verify_${channel}`, otpHash, expiresAt });
  }

  const template = otpEmailTemplate("AptusHire", code);
  await dispatchEmail({ to: email, ...template, category: "candidate_otp", relatedType: "OTPVerification" });

  res.json({
    ok: true,
    channel,
    target: user.email,
    message: `Verification code sent to your ${channel}.`,
  });
}

async function verifyOtp(req, res) {
  const { channel, code } = req.body;
  const user = req.user;

  if (!OTP_CHANNELS.has(channel) || typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
    return res.status(400).json({ error: "A valid email verification code is required" });
  }

  const record = await OTPVerification.findOne({
    email: user.email.toLowerCase(),
    purpose: `verify_${channel}`,
    expiresAt: { $gt: new Date() },
  });

  if (!record || record.verified) {
    return res.status(400).json({ error: "Invalid or expired verification code." });
  }

  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    return res.status(429).json({ error: "Too many incorrect attempts. Please request a new code." });
  }

  if (hashOtp(code.trim()) !== record.otpHash) {
    record.attempts += 1;
    await record.save();
    return res.status(400).json({ error: "Invalid or expired verification code." });
  }

  await OTPVerification.deleteOne({ _id: record._id });

  let profile = await CandidateProfile.findOne({ user: user._id });
  if (!profile) profile = new CandidateProfile({ user: user._id });

  profile.verification = profile.verification || {};
  if (channel === "email") {
    profile.verification.emailVerified = true;
    profile.verification.emailVerifiedAt = new Date();
  } else if (channel === "phone") {
    profile.verification.phoneVerified = true;
    profile.verification.phoneVerifiedAt = new Date();
  }

  const hasDefaultResume = (await ResumeVersion.countDocuments({ user: user._id, isDefault: true, isArchived: false })) > 0;
  profile.strengthScore = computeProfileStrength(profile, hasDefaultResume);
  await profile.save();

  res.json({ ok: true, channel, verified: true, strengthScore: profile.strengthScore });
}

async function updateEducation(req, res) {
  const { education } = req.body;
  const user = req.user;

  let profile = await CandidateProfile.findOne({ user: user._id });
  if (!profile) profile = new CandidateProfile({ user: user._id });

  profile.education = Array.isArray(education) ? education : [];
  const hasDefaultResume = (await ResumeVersion.countDocuments({ user: user._id, isDefault: true, isArchived: false })) > 0;
  profile.strengthScore = computeProfileStrength(profile, hasDefaultResume);
  await profile.save();

  res.json({ ok: true, education: profile.education, strengthScore: profile.strengthScore });
}

async function updateExperience(req, res) {
  const { experience } = req.body;
  const user = req.user;

  let profile = await CandidateProfile.findOne({ user: user._id });
  if (!profile) profile = new CandidateProfile({ user: user._id });

  profile.experience = Array.isArray(experience) ? experience : [];
  const hasDefaultResume = (await ResumeVersion.countDocuments({ user: user._id, isDefault: true, isArchived: false })) > 0;
  profile.strengthScore = computeProfileStrength(profile, hasDefaultResume);
  await profile.save();

  res.json({ ok: true, experience: profile.experience, strengthScore: profile.strengthScore });
}

async function updatePreferences(req, res) {
  const { jobAlerts, whatsappUpdates, smsUpdates, availabilityWindow, aiScreeningConsent, dataRetentionConsent } = req.body;
  const user = req.user;

  let profile = await CandidateProfile.findOne({ user: user._id });
  if (!profile) profile = new CandidateProfile({ user: user._id });

  profile.preferences = profile.preferences || {};
  if (jobAlerts !== undefined) profile.preferences.jobAlerts = Boolean(jobAlerts);
  if (whatsappUpdates !== undefined) profile.preferences.whatsappUpdates = Boolean(whatsappUpdates);
  if (smsUpdates !== undefined) profile.preferences.smsUpdates = Boolean(smsUpdates);
  if (availabilityWindow !== undefined) profile.preferences.availabilityWindow = availabilityWindow;
  if (aiScreeningConsent !== undefined) profile.preferences.aiScreeningConsent = Boolean(aiScreeningConsent);
  if (dataRetentionConsent !== undefined) profile.preferences.dataRetentionConsent = Boolean(dataRetentionConsent);
  profile.preferences.consentTimestamp = new Date();

  await profile.save();
  res.json({ ok: true, preferences: profile.preferences });
}

async function uploadGovDocument(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: "Document file is required" });
  }

  const { docType, docNumber } = req.body;
  const user = req.user;

  if (!GOVERNMENT_DOCUMENT_TYPES.has(docType)) {
    return res.status(400).json({ error: "A valid government document type is required" });
  }
  if (typeof docNumber !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 -]{3,31}$/.test(docNumber.trim())) {
    return res.status(400).json({ error: "A valid government document number is required" });
  }

  const { buffer, originalname } = req.file;
  const mimetype = detectFileType(buffer);
  if (!mimetype) {
    return res.status(400).json({ error: "Document content must be a valid PDF or DOCX file" });
  }

  const key = await storageService.putObject({
    buffer,
    key: storageService.buildKey("gov-documents", { originalName: originalname }),
    contentType: mimetype,
  });

  // Mask document number (e.g. XXXX-XXXX-1234)
  const cleanNumber = docNumber.replace(/\s+/g, "");
  const masked = cleanNumber.length > 4 ? `XXXX-XXXX-${cleanNumber.slice(-4)}` : `XXXX-${cleanNumber}`;

  let profile = await CandidateProfile.findOne({ user: user._id });
  if (!profile) profile = new CandidateProfile({ user: user._id });

  const doc = await GovDocument.create({
    user: user._id,
    docType,
    maskedNumber: masked,
    fileUrl: key,
    filePath: key,
    status: "pending",
  });

  const hasDefaultResume = (await ResumeVersion.countDocuments({ user: user._id, isDefault: true, isArchived: false })) > 0;
  profile.strengthScore = computeProfileStrength(profile, hasDefaultResume);
  await profile.save();

  res.status(201).json({ ok: true, document: doc, strengthScore: profile.strengthScore });
}

async function exportCandidateData(req, res) {
  const user = req.user;
  const profile = await CandidateProfile.findOne({ user: user._id });
  const documents = await GovDocument.find({ user: user._id }).select("-filePath");
  const resumes = await ResumeVersion.find({ user: user._id });
  const applications = await Candidate.find({ "basicDetails.email": user.email.toLowerCase() }).populate("job", "title department location");
  const interviews = await InterviewSession.find({ candidate: { $in: applications.map((a) => a._id) } }).select("status interviewAt sessionType");

  const exportBundle = {
    exportedAt: new Date().toISOString(),
    regulatoryStandard: "GDPR / DPDP Article 20 Data Portability Export",
    account: {
      id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      createdAt: user.createdAt,
    },
    profile,
    resumes: resumes.map((r) => ({
      label: r.label,
      tags: r.tags,
      skills: r.parsedSnapshot?.skills,
      applyCount: r.applyCount,
      uploadedAt: r.createdAt,
    })),
    documents: documents.map((d) => ({
      type: d.docType,
      maskedNumber: d.maskedNumber,
      status: d.status,
      verifiedAt: d.verifiedAt,
    })),
    applications: applications.map((a) => ({
      jobTitle: a.job?.title,
      department: a.job?.department,
      status: a.status,
      appliedAt: a.createdAt,
    })),
    interviews,
  };

  res.setHeader("Content-Disposition", `attachment; filename="AptusHire-Data-Export-${user._id}.json"`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(exportBundle, null, 2));
}

module.exports = {
  getFullProfile,
  updatePersonalInfo,
  sendOtp,
  verifyOtp,
  updateEducation,
  updateExperience,
  updatePreferences,
  uploadGovDocument,
  exportCandidateData,
};
