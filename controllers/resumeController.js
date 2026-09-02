const crypto = require("crypto");
const Resume = require("../models/Resume");
const storageService = require("../services/storageService");
const extractResumeText = require("../utils/extractResumeText");
const { detectFileType } = require("../utils/verifyFileSignature");

async function uploadResume(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: "Resume file is required" });
  }

  const { buffer, originalname, size } = req.file;

  const mimetype = detectFileType(buffer);
  if (!mimetype) {
    return res.status(400).json({ error: "File content does not match a valid PDF or DOCX" });
  }

  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  // Identity comes from the authenticated account, never from the request body,
  // so a candidate can only ever write to their own resume library.
  const candidateEmail = req.user.email.trim().toLowerCase();

  const existing = await Resume.findOne({ candidateEmail, checksum });
  if (existing) {
    // Resumes uploaded before span-addressable ingest shipped have no textHash /
    // pageBreaks / artifacts, so autofill could not run the defense pass on them.
    // Backfill from the bytes we already have in hand rather than leaving a
    // silently second-class resume in the library.
    if (!existing.textHash && existing.extractedText) {
      const ingest = await extractResumeText(buffer, mimetype);
      applyIngest(existing, ingest);
      await existing.save();
    }
    // 200 (not 201) already signalled "this file was already here", but nothing downstream could
    // read that off the body — so the UI reported a successful upload and the candidate watched a
    // list that did not change. Say it explicitly.
    return res.status(200).json({ ...existing.toObject(), alreadyInLibrary: true });
  }

  const ingest = await extractResumeText(buffer, mimetype);

  const key = await storageService.putObject({
    buffer,
    key: storageService.buildKey("resume-library", { originalName: originalname }),
    contentType: mimetype,
  });

  const resume = new Resume({
    candidateEmail,
    originalName: originalname,
    storedFileName: key.split("/").pop(),
    filePath: key,
    mimeType: mimetype,
    sizeBytes: size,
    checksum,
  });
  applyIngest(resume, ingest);
  await resume.save();

  res.status(201).json(resume);
}

// Copy one extraction result onto a Resume doc. The canonical text and its
// derived coordinates (textHash, pageBreaks) always move together — a text
// change with stale pageBreaks would put every downstream span in the wrong place.
function applyIngest(resume, ingest) {
  resume.extractedText = ingest.text;
  resume.textHash = ingest.text ? crypto.createHash("sha256").update(ingest.text, "utf8").digest("hex") : "";
  resume.pageBreaks = ingest.pageBreaks || [];
  resume.artifacts = ingest.artifacts || {};
  resume.extractionStatus = ingest.status;
  // The cached suggestions describe the OLD text. Drop them rather than serve a
  // parse of a document this resume no longer holds.
  resume.autofill = undefined;
}

// Ownership is enforced by scoping the query to the caller's own email, and a
// mismatch returns 404 (not 403) so an attacker can't use this as an oracle to
// confirm which resume ids exist.
async function getResume(req, res) {
  const resume = await Resume.findOne({ _id: req.params.id, candidateEmail: req.user.email });
  if (!resume) return res.status(404).json({ error: "Resume not found" });
  res.json(resume);
}

async function downloadResume(req, res) {
  const resume = await Resume.findOne({ _id: req.params.id, candidateEmail: req.user.email });
  if (!resume) return res.status(404).json({ error: "Resume not found" });
  await storageService.sendDownload(res, resume.filePath, resume.originalName, resume.mimeType);
}

// DELETE /api/resumes/:id
//
// THE GAP THIS FILLS. There was no way to remove a résumé — not from the library, not from
// storage, not by the candidate and not by anyone else. Upload dedupes on the FILE checksum, so
// re-uploading an edited CV correctly creates a new entry, and the superseded one then sat in the
// list forever with no control beside it. The library is advertised as version history; a version
// history you cannot prune is a filing cabinet with the drawers welded shut.
//
// WHY A HARD DELETE IS SAFE HERE, which is the only question worth asking. An APPLICATION does not
// reference this file. candidateController copies the bytes into the tenant's own storage
// partition at submit time (deliberately — the library sits outside every tenant partition and a
// tenant must never read from a shared path), and Candidate.resumeText holds its own canonical
// copy of the extracted text that every span, claim and score is addressed against. So deleting a
// library résumé removes the candidate's working copy and touches no evidence, no audit trail and
// no assessment. If that ever stops being true — if an application is changed to reference this
// path — this must become a soft delete, because evidence a decision cited may not be erasable by
// the person the decision was about.
async function deleteResume(req, res) {
  const candidateEmail = req.user.email.trim().toLowerCase();
  // Scoped to the caller's own email, exactly as getResume/downloadResume are, and a miss is a 404
  // rather than a 403 so this cannot be used as an oracle for which resume ids exist.
  const resume = await Resume.findOne({ _id: req.params.id, candidateEmail });
  if (!resume) return res.status(404).json({ error: "Resume not found" });

  // Storage first, document second, and a storage failure does NOT abort the delete. A candidate
  // asked for this to be gone from their library; leaving the row behind because an object store
  // was briefly unreachable would tell them it failed when the thing they can actually see is the
  // row. An orphaned object is a housekeeping problem for us, not a broken promise to them.
  try {
    await storageService.deleteObject(resume.filePath);
  } catch (err) {
    console.error(`[resumes] storage delete failed for ${resume.filePath} (record removed anyway): ${err.message}`);
  }
  await resume.deleteOne();
  res.status(204).end();
}

async function listResumeHistory(req, res) {
  // The full text and the cached suggestion payload are both large and neither
  // is used by a list view — fetch them per-resume, not per-page.
  const resumes = await Resume.find({ candidateEmail: req.user.email })
    .select("-extractedText -autofill")
    .sort({ createdAt: -1 });
  res.json(resumes);
}

module.exports = { uploadResume, getResume, downloadResume, deleteResume, listResumeHistory };
