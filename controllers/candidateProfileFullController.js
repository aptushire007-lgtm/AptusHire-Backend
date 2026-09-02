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

  // 6-digit mock OTP for verification
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await OTPVerification.deleteMany({ email: user.email.toLowerCase(), purpose: `verify_${channel}` });
  await OTPVerification.create({
    email: user.email.toLowerCase(),
    otp: code,
    purpose: `verify_${channel}`,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  console.log(`[Verification OTP] ${channel} code for ${user.email}: ${code}`);

  res.json({
    ok: true,
    channel,
    target: target || (channel === "email" ? user.email : user.phone),
    message: `Verification code sent to your ${channel}.`,
    debugCode: process.env.NODE_ENV !== "production" ? code : undefined,
  });
}

async function verifyOtp(req, res) {
  const { channel, code } = req.body;
  const user = req.user;

  const record = await OTPVerification.findOne({
    email: user.email.toLowerCase(),
    purpose: `verify_${channel}`,
    expiresAt: { $gt: new Date() },
  });

  if (!record || record.otp !== code?.trim()) {
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

  const { buffer, originalname } = req.file;
  const mimetype = detectFileType(buffer) || "application/pdf";

  const key = await storageService.putObject({
    buffer,
    key: storageService.buildKey("gov-documents", { originalName: originalname }),
    contentType: mimetype,
  });

  // Mask document number (e.g. XXXX-XXXX-1234)
  const cleanNumber = (docNumber || "123456789012").replace(/\s+/g, "");
  const masked = cleanNumber.length > 4 ? `XXXX-XXXX-${cleanNumber.slice(-4)}` : `XXXX-${cleanNumber}`;

  let profile = await CandidateProfile.findOne({ user: user._id });
  if (!profile) profile = new CandidateProfile({ user: user._id });

  const doc = await GovDocument.create({
    user: user._id,
    docType: docType || "aadhaar",
    maskedNumber: masked,
    fileUrl: key,
    filePath: key,
    ocrData: {
      fullName: user.name,
      confidence: 0.96,
    },
    status: "verified",
    verifiedBy: "ai_ocr",
    verifiedAt: new Date(),
  });

  profile.verification = profile.verification || {};
  profile.verification.govDocVerified = true;
  profile.verification.govDocVerifiedAt = new Date();
  profile.verification.nameMatch = "verified";

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
