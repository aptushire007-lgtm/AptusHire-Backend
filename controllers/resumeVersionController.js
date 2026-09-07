const crypto = require("crypto");
const mongoose = require("mongoose");
const ResumeVersion = require("../models/ResumeVersion");
const Resume = require("../models/Resume");
const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const storageService = require("../services/storageService");
const extractResumeText = require("../utils/extractResumeText");
const { detectFileType } = require("../utils/verifyFileSignature");

const MAX_ACTIVE_VERSIONS = 5;

// Lazy migration: if candidate has legacy Resume records but no ResumeVersion records,
// migrate the latest Resume into a default ResumeVersion seamlessly.
async function ensureVersionsMigrated(user) {
  const count = await ResumeVersion.countDocuments({ user: user._id });
  if (count > 0) return;

  const legacyResumes = await Resume.find({ candidateEmail: user.email.toLowerCase() }).sort({ createdAt: -1 });
  if (legacyResumes.length === 0) return;

  // Migrate newest as default
  // Only migrate legacy resumes whose filePath is a valid encoded Cloudinary
  // reference — raw public IDs and local paths from before Cloudinary was
  // integrated produce a 404 when fetched and must not appear as selectable
  // options on the apply form.
  const validLegacy = legacyResumes.filter((r) => String(r.filePath || "").startsWith("cloudinary:"));

  for (let i = 0; i < Math.min(validLegacy.length, MAX_ACTIVE_VERSIONS); i++) {
    const legacy = validLegacy[i];
    const textHash = legacy.textHash || (legacy.extractedText ? crypto.createHash("sha256").update(legacy.extractedText, "utf8").digest("hex") : "legacy");

    const extractedSkills = [];
    if (legacy.autofill?.payload?.skills) {
      extractedSkills.push(...legacy.autofill.payload.skills);
    }

    await ResumeVersion.create({
      user: user._id,
      candidateEmail: user.email.toLowerCase(),
      label: legacy.originalName || `Resume_v${i + 1}.pdf`,
      tags: i === 0 ? ["Default"] : ["Version"],
      fileUrl: legacy.filePath,
      filePath: legacy.filePath,
      sizeBytes: legacy.sizeBytes || 1024,
      mimeType: legacy.mimeType || "application/pdf",
      checksum: legacy.checksum || crypto.randomBytes(16).toString("hex"),
      parsedSnapshot: {
        skills: extractedSkills,
        experienceYears: 0,
        certifications: [],
        rawText: legacy.extractedText || "",
        textHash,
      },
      parseConfidence: 90,
      isDefault: i === 0,
      isArchived: false,
      applyCount: 0,
    });
  }
}

async function listResumeVersions(req, res) {
  const user = req.user;
  await ensureVersionsMigrated(user);

  const includeArchived = req.query.archived === "true";
  const query = { user: user._id };
  if (!includeArchived) {
    query.isArchived = false;
  }

  const versions = await ResumeVersion.find(query).sort({ isDefault: -1, createdAt: -1 });
  res.json({
    versions,
    activeCount: versions.filter((v) => !v.isArchived).length,
    maxActive: MAX_ACTIVE_VERSIONS,
  });
}

async function uploadResumeVersion(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: "Resume file is required" });
  }

  const user = req.user;
  await ensureVersionsMigrated(user);

  const activeCount = await ResumeVersion.countDocuments({ user: user._id, isArchived: false });
  if (activeCount >= MAX_ACTIVE_VERSIONS) {
    return res.status(400).json({
      error: `Maximum limit of ${MAX_ACTIVE_VERSIONS} active resume versions reached. Please archive an older version to upload a new one.`,
    });
  }

  const { buffer, originalname, size } = req.file;
  const mimetype = detectFileType(buffer);
  if (!mimetype) {
    return res.status(400).json({ error: "File content does not match a valid PDF or DOCX" });
  }

  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  const ingest = await extractResumeText(buffer, mimetype);

  const key = await storageService.putObject({
    buffer,
    key: storageService.buildKey("resume-versions", { originalName: originalname }),
    contentType: mimetype,
  });

  const textHash = ingest.text ? crypto.createHash("sha256").update(ingest.text, "utf8").digest("hex") : "";

  // Infer basic skills from text or tags
  const skillsDetected = [];
  const commonTech = ["react", "node", "python", "javascript", "typescript", "sql", "aws", "docker", "java", "c++", "clinical", "research"];
  const lowerText = (ingest.text || "").toLowerCase();
  for (const skill of commonTech) {
    if (lowerText.includes(skill)) {
      skillsDetected.push(skill.charAt(0).toUpperCase() + skill.slice(1));
    }
  }

  const isFirst = activeCount === 0;

  const version = await ResumeVersion.create({
    user: user._id,
    candidateEmail: user.email.toLowerCase(),
    label: req.body.label?.trim() || originalname,
    tags: Array.isArray(req.body.tags) ? req.body.tags : req.body.tags ? [req.body.tags] : [],
    fileUrl: key,
    filePath: key,
    sizeBytes: size,
    mimeType: mimetype,
    checksum,
    parsedSnapshot: {
      skills: skillsDetected,
      experienceYears: 0,
      certifications: [],
      rawText: ingest.text || "",
      textHash,
    },
    parseConfidence: 94,
    isDefault: isFirst,
    isArchived: false,
    applyCount: 0,
  });

  res.status(201).json(version);
}

async function updateResumeVersion(req, res) {
  const { id } = req.params;
  const { label, tags, skills } = req.body;

  const version = await ResumeVersion.findOne({ _id: id, user: req.user._id });
  if (!version) return res.status(404).json({ error: "Resume version not found" });

  if (label !== undefined) version.label = label.trim();
  if (Array.isArray(tags)) version.tags = tags.map((t) => t.trim()).filter(Boolean);
  if (Array.isArray(skills)) version.parsedSnapshot.skills = skills;

  await version.save();
  res.json(version);
}

async function setDefaultResumeVersion(req, res) {
  const { id } = req.params;
  const version = await ResumeVersion.findOne({ _id: id, user: req.user._id, isArchived: false });
  if (!version) return res.status(404).json({ error: "Active resume version not found" });

  // Unset default on all others
  await ResumeVersion.updateMany({ user: req.user._id }, { $set: { isDefault: false } });
  version.isDefault = true;
  await version.save();

  res.json({ ok: true, defaultVersionId: version._id });
}

async function archiveResumeVersion(req, res) {
  const { id } = req.params;
  const version = await ResumeVersion.findOne({ _id: id, user: req.user._id });
  if (!version) return res.status(404).json({ error: "Resume version not found" });

  const wasDefault = version.isDefault;
  version.isArchived = true;
  version.isDefault = false;
  await version.save();

  // If was default, promote newest remaining active version
  if (wasDefault) {
    const nextActive = await ResumeVersion.findOne({ user: req.user._id, isArchived: false }).sort({ createdAt: -1 });
    if (nextActive) {
      nextActive.isDefault = true;
      await nextActive.save();
    }
  }

  res.json({ ok: true, version });
}

async function deleteResumeVersion(req, res) {
  const { id } = req.params;
  const version = await ResumeVersion.findOne({ _id: id, user: req.user._id });
  if (!version) return res.status(404).json({ error: "Resume version not found" });

  // Integrity Check: Has this version been used in any applications?
  const applicationCount = await Candidate.countDocuments({
    $or: [{ resumeVersion: version._id }, { resumeHash: version.parsedSnapshot?.textHash }],
  });

  if (version.applyCount > 0 || applicationCount > 0) {
    return res.status(409).json({
      error: "Cannot delete a resume version that was used in an application. You can archive it instead to preserve application integrity.",
    });
  }

  try {
    await storageService.deleteObject(version.filePath);
  } catch (err) {
    console.error(`[resumeVersion] storage delete error: ${err.message}`);
  }

  const wasDefault = version.isDefault;
  await version.deleteOne();

  if (wasDefault) {
    const nextActive = await ResumeVersion.findOne({ user: req.user._id, isArchived: false }).sort({ createdAt: -1 });
    if (nextActive) {
      nextActive.isDefault = true;
      await nextActive.save();
    }
  }

  res.status(204).end();
}

async function getMatchScoresForJob(req, res) {
  const { jobId } = req.params;
  const user = req.user;
  await ensureVersionsMigrated(user);

  const job = await Job.findById(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const versions = await ResumeVersion.find({ user: user._id, isArchived: false }).sort({ isDefault: -1, createdAt: -1 });

  const jobSkills = (job.requiredSkills || []).map((s) => s.toLowerCase());

  const scoredVersions = versions.map((v) => {
    const versionSkills = (v.parsedSnapshot?.skills || []).map((s) => s.toLowerCase());
    let overlapCount = 0;
    if (jobSkills.length > 0) {
      overlapCount = jobSkills.filter((s) => versionSkills.some((vs) => vs.includes(s) || s.includes(vs))).length;
    }

    // Match score baseline + overlap
    let matchScore = jobSkills.length > 0 ? Math.round((overlapCount / jobSkills.length) * 40) + 55 : 85;
    matchScore = Math.min(98, Math.max(50, matchScore));

    return {
      _id: v._id,
      label: v.label,
      tags: v.tags,
      isDefault: v.isDefault,
      parsedSkills: v.parsedSnapshot?.skills || [],
      matchScore,
      createdAt: v.createdAt,
    };
  });

  // Determine best fit
  let highestScore = -1;
  let bestFitId = null;
  for (const sv of scoredVersions) {
    if (sv.matchScore > highestScore) {
      highestScore = sv.matchScore;
      bestFitId = String(sv._id);
    }
  }

  const result = scoredVersions.map((sv) => ({
    ...sv,
    isBestFit: String(sv._id) === bestFitId,
  }));

  res.json({
    jobId: job._id,
    jobTitle: job.title,
    versions: result,
  });
}

module.exports = {
  listResumeVersions,
  uploadResumeVersion,
  updateResumeVersion,
  setDefaultResumeVersion,
  archiveResumeVersion,
  deleteResumeVersion,
  getMatchScoresForJob,
};
