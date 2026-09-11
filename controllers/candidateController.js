const crypto = require("crypto");
const mongoose = require("mongoose");
const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const User = require("../models/User");
const Resume = require("../models/Resume");
const ResumeVersion = require("../models/ResumeVersion");
const InterviewSession = require("../models/InterviewSession");
const AtsAssessment = require("../models/AtsAssessment");
const ClaimGraph = require("../models/ClaimGraph");
const { documentProfessionalism, redFlagAnalysis, keyAttributes } = require("../utils/resumeSignals");
const { analyzeTimeline } = require("../utils/claimConsistency");
const storageService = require("../services/storageService");
const extractResumeText = require("../utils/extractResumeText");
const atsService = require("../services/atsService");
const { notifyAdmin, notifyCandidate } = require("../services/notificationService");
const { applyTransition } = require("../services/pipelineService");
const { allowedNextStages, stageLabel } = require("../utils/pipeline");
const proctoring = require("../utils/proctoring");
const { runInBackground } = require("../utils/backgroundTasks");
const {
  computeAnswerSubstance,
  computeDurationFlag,
  buildCompetencyTable,
  computeVerdict,
  recommendedAction,
  competencyTripletOrNull,
  buildCoverageMatrix,
  computeSessionQuality,
  verdictFor,
  composeResumeNarrative,
  resumeFindingLists,
} = require("../utils/interviewReportEngine");
const { toApplyReceipt } = require("../utils/candidateSerializers");

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function truthy(v) {
  return v === true || v === "true" || v === "on" || v === "1" || v === 1;
}

// Phase 15.1 — sanitise the apply-link source tag. Free-form client input never
// lands raw in analytics: channel is slug-charset only, both fields capped.
function buildSource(body) {
  const channel = String(body?.src || body?.source || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 40);
  if (!channel) return undefined;
  const campaign = String(body?.campaign || "")
    .trim()
    .replace(/[^\w\s.-]/g, "")
    .slice(0, 80);
  return { channel, campaign: campaign || undefined, capturedAt: new Date() };
}

// Resolve which résumé this application carries. Two accepted shapes:
//
//   req.file            — a direct multipart upload (the original path).
//   body.resumeId       — a résumé already in the caller's own library, which is
//                         what the autofill flow produces: the file is uploaded
//                         and parsed BEFORE the form is filled, so there is
//                         nothing left to upload at submit time.
//
// Ownership is enforced by scoping the lookup to the authenticated account's
// email, and a miss returns null (the caller 400s) rather than distinguishing
// "not yours" from "does not exist".
async function resolveResumeRef(req, email) {
  if (req.file) {
    return { size: req.file.size, originalName: req.file.originalname, mimeType: req.file.mimetype, file: req.file };
  }
  const resumeVersionId = String(req.body?.resumeVersionId || "").trim();
  if (resumeVersionId && mongoose.isValidObjectId(resumeVersionId)) {
    const ResumeVersion = require("../models/ResumeVersion");
    const version = await ResumeVersion.findOne({ _id: resumeVersionId, candidateEmail: email });
    if (version) {
      return {
        size: version.sizeBytes,
        originalName: version.label,
        mimeType: version.mimeType,
        resume: { filePath: version.filePath, autofill: version.autofill },
        resumeVersionId: version._id,
        versionDoc: version,
      };
    }
  }

  const resumeId = String(req.body?.resumeId || "").trim();
  if (!resumeId || !mongoose.isValidObjectId(resumeId)) return null;

  const resume = await Resume.findOne({ _id: resumeId, candidateEmail: email });
  if (!resume) return null;
  return { size: resume.sizeBytes, originalName: resume.originalName, mimeType: resume.mimeType, resume };
}

// POST /api/jobs/:id/apply/autofill  { resumeId }
//
// Suggest form fields from a résumé the caller already uploaded to their own
// library. Job-scoped for two reasons: the job gives the LLM spend a tenant to
// meter against, and it lets a closed job be rejected before a model call is
// made — not because the job influences the output. It cannot: extraction is
// job-blind by construction (see autofillPrompts), which is exactly why the
// result is cached per-résumé and reused across employers.
//
// Suggestions are never written to anything. They are proposals the candidate
// accepts, edits, or discards; the application is created only by applyToJob.
async function autofillFromResume(req, res) {
  const email = String(req.user.email || "").toLowerCase().trim();

  const job = await Job.findByIdOrSlug(req.params.id);
  if (!job || job.status !== "published") {
    return res.status(404).json({ error: "Job not found or not accepting applications" });
  }

  const resumeId = String(req.body?.resumeId || "").trim();
  const resumeVersionId = String(req.body?.resumeVersionId || "").trim();
  if (!resumeId && !resumeVersionId) return res.status(400).json({ error: "resumeId or resumeVersionId is required" });

  // The apply form has two libraries in the wild: legacy Resume documents and
  // the newer ResumeVersion collection. Both are scoped to this account.
  let resume = resumeId && mongoose.isValidObjectId(resumeId)
    ? await Resume.findOne({ _id: resumeId, candidateEmail: email })
    : null;
  let version;
  if (!resume && resumeVersionId && mongoose.isValidObjectId(resumeVersionId)) {
    version = await ResumeVersion.findOne({ _id: resumeVersionId, candidateEmail: email, isArchived: false });
    if (version) {
      // Reuse a legacy record's richer cache when a migrated version points at
      // the same file; otherwise parse the canonical text already stored on the version.
      resume = await Resume.findOne({ candidateEmail: email, checksum: version.checksum });
      if (!resume) {
        resume = {
          _id: version._id,
          extractedText: version.parsedSnapshot?.rawText || "",
          textHash: version.parsedSnapshot?.textHash || "",
          pageBreaks: [],
          artifacts: {},
          autofill: version.autofill,
        };
      }
    }
  }
  if (!resume) return res.status(404).json({ error: "Resume not found" });

  // Older ResumeVersion rows may have metadata but no parsed snapshot. The
  // selected file is already in Cloudinary, so repair the snapshot from that
  // source before asking autofill to read it.
  if (version && !resume.extractedText?.trim() && version.filePath) {
    const buffer = await storageService.getObjectBuffer(version.filePath, { contentType: version.mimeType });
    const ingest = await extractResumeText(buffer, version.mimeType);
    if (ingest.text) {
      version.parsedSnapshot.rawText = ingest.text;
      version.parsedSnapshot.textHash = crypto.createHash("sha256").update(ingest.text, "utf8").digest("hex");
      await version.save();
      resume.extractedText = ingest.text;
      resume.textHash = version.parsedSnapshot.textHash;
      resume.pageBreaks = ingest.pageBreaks;
      resume.artifacts = ingest.artifacts;
    }
  }

  const autofillService = require("../services/autofillService");
  const payload = await autofillService.suggestForResume(resume, { company: job.company });
  if (version && !resume.save) {
    version.autofill = {
      textHash: version.parsedSnapshot?.textHash || resume.textHash,
      version: payload.version,
      promptVersion: payload.promptVersion,
      engine: payload.engine,
      payload,
      at: new Date(),
    };
    await version.save();
  }
  res.json(payload);
}

async function applyToJob(req, res) {
  const { id: jobIdOrSlug } = req.params;
  const { name, phone, location, linkedinUrl, portfolioUrl, experience, education, skills, projects, certificates } =
    req.body;
  const consentAi = truthy(req.body.consentAiProcessing);
  const consentData = truthy(req.body.consentDataProcessing);

  // The application is bound to the signed-in account, never a form value — a
  // free-form email would let anyone apply as any address and route another
  // person's notifications and interview link. `candidateUser` is the stable
  // relational identity (Phase 17); email stays as the human-readable key and
  // the legacy/no-account fallback.
  const email = String(req.user.email || "").toLowerCase().trim();
  const candidateUser = req.user._id;

  const job = await Job.findByIdOrSlug(jobIdOrSlug);
  if (!job || job.status !== "published") {
    return res.status(404).json({ error: "Job not found or not accepting applications" });
  }
  const resumeRef = await resolveResumeRef(req, email);
  if (!resumeRef) {
    return res.status(400).json({ error: "Resume file is required" });
  }
  if (!name || !email) {
    return res.status(400).json({ error: "Name and email are required" });
  }

  // One application per job per person. The unique (job, email) and
  // (job, candidateUser) indexes are the race-proof guards; this pre-check
  // exists for the friendly message and matches on EITHER identity so a legacy
  // application (email only, no candidateUser yet) is still detected.
  const existing = await Candidate.findOne({
    company: job.company,
    job: job._id,
    $or: [{ candidateUser }, { "basicDetails.email": email }],
  }).select("_id");
  if (existing) {
    return res.status(409).json({ error: "You have already applied to this job. You can track it from your dashboard." });
  }

  // Expired tenant ⇒ jobs stop accepting applications (Phase 11.2). The
  // candidate sees a closed listing, not a billing error.
  const Subscription = require("../models/Subscription");
  const { assess } = require("../services/subscriptionLifecycleService");
  const subState = assess(await Subscription.findOne({ company: job.company }).select("status currentPeriodEnd"));
  if (subState === "expired") {
    return res.status(404).json({ error: "Job not found or not accepting applications" });
  }

  // Plan quotas (Phase 11.1): parsing count + storage, both blocked BEFORE the
  // upload so a capped tenant never accrues unpaid work. 429 carries a
  // machine-readable reason and writes an AuditLog row.
  const quotaService = require("../services/quotaService");
  await quotaService.enforce(job.company, "resumeParsing");
  await quotaService.enforce(job.company, "storageMb", { incoming: resumeRef.size / (1024 * 1024) });

  // Persist the resume through the storage abstraction with a tenant-partitioned key,
  // so it is reachable from every instance and never leaks across tenants.
  // A library résumé is COPIED here rather than referenced: the library lives
  // outside any tenant's partition, and a tenant must never read from a path
  // shared with other tenants' candidates.
  let resumeBuffer;
  try {
    resumeBuffer = resumeRef.file
      ? resumeRef.file.buffer
      : await storageService.getObjectBuffer(resumeRef.resume.filePath, { contentType: resumeRef.mimeType });
  } catch (err) {
    // The stored resume file could not be fetched (stale reference, deleted
    // from Cloudinary, or a pre-Cloudinary local path). Ask the candidate to
    // re-upload rather than surfacing a raw storage error.
    return res.status(400).json({
      error: "We could not retrieve your saved resume. Please upload your resume file directly to continue.",
    });
  }
  const resumeKey = await storageService.putObject({
    buffer: resumeBuffer,
    key: storageService.buildKey("resumes", { company: job.company, originalName: resumeRef.originalName }),
    contentType: resumeRef.mimeType,
  });

  // Attribute every submitted field against the suggestions this résumé was
  // offered. Computed here, from OUR cached payload — the client sends form
  // values only and has no say in what counts as machine-written. A candidate
  // who never used autofill (no cached payload) attributes cleanly to
  // "candidate" for everything, which is the truth.
  const autofillService = require("../services/autofillService");
  const cachedSuggestions = resumeRef.resume?.autofill?.payload || null;
  const attributed = autofillService.attributeProvenance(
    {
      experience: parseJsonArray(experience),
      education: parseJsonArray(education),
      skills: parseJsonArray(skills),
      projects: parseJsonArray(projects),
      certificates: parseJsonArray(certificates),
    },
    cachedSuggestions
  );
  const usedAutofill = attributed.counts.accepted > 0 || attributed.counts.edited > 0;

  // The 1:1 profile is created lazily elsewhere (dashboard first load); link it
  // if it exists, but never block an application on it.
  const CandidateProfile = require("../models/CandidateProfile");
  const candidateProfileDoc = await CandidateProfile.findOne({ user: candidateUser }).select("_id");

  let candidate;
  try {
    candidate = await Candidate.create({
      job: job._id,
      company: job.company,
      candidateUser,
      candidateProfile: candidateProfileDoc?._id,
      basicDetails: { name, email, phone, location, linkedinUrl, portfolioUrl },
      experience: attributed.experience,
      education: attributed.education,
      skills: parseJsonArray(skills),
      skillProvenance: attributed.skillProvenance,
      projects: attributed.projects,
      certificates: attributed.certificates,
      autofill: {
        used: usedAutofill,
        version: cachedSuggestions?.version,
        promptVersion: cachedSuggestions?.promptVersion,
        engine: cachedSuggestions?.engine,
        ...attributed.counts,
        // Only meaningful when the machine actually contributed something; an
        // attestation recorded for a hand-typed form would be noise in the audit.
        attestedAt: usedAutofill ? new Date() : undefined,
        ipAddress: usedAutofill ? req.ip : undefined,
      },
      resumePath: resumeKey,
      resumeOriginalName: resumeRef.originalName,
      resumeSizeBytes: resumeRef.size,
      resumeVersion: resumeRef.resumeVersionId || undefined,
      stageHistory: [{ stage: "applied", by: "system" }],
      // Phase 15.1 — source attribution from the apply link's ?src= / ?campaign=.
      // Sanitised, analytics-only; never a scoring input.
      source: buildSource(req.body),
      consent: {
        aiProcessing: consentAi,
        dataProcessing: consentData,
        at: consentAi || consentData ? new Date() : undefined,
        ipAddress: req.ip,
      },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: "You have already applied to this job. You can track it from your dashboard." });
    }
    throw err;
  }

  if (resumeRef.versionDoc) {
    try {
      const Company = require("../models/Company");
      const company = await Company.findById(job.company).select("name");
      resumeRef.versionDoc.applyCount = (resumeRef.versionDoc.applyCount || 0) + 1;
      resumeRef.versionDoc.lastUsedAt = new Date();
      resumeRef.versionDoc.shareLog.push({
        companyId: job.company,
        companyName: company?.name || "Company",
        jobId: job._id,
        jobTitle: job.title,
        sharedAt: new Date(),
      });
      await resumeRef.versionDoc.save();
    } catch (e) {
      console.error(`[resumeVersion] failed to update shareLog: ${e.message}`);
    }
  }

  // Respond the moment the application is durably stored. Screening (which in
  // live mode is several LLM calls) and all notifications run in the background
  // — the candidate gets a receipt now and outcome notifications when ready,
  // instead of a spinner held hostage by pdf-parse + LLM + SMTP latency.
  res.status(201).json(toApplyReceipt(candidate, job));

  runInBackground(`screen candidate ${candidate._id}`, () => runPostApplyPipeline(candidate, job));
}

// Post-201 work for a new application: notifications + ATS screening. Screening is now durable
// (§1.1) — it goes through atsService.enqueueScreening, which survives a deploy/crash mid-screen
// via BullMQ retries (or, without Redis configured, the same single-attempt background run this
// codebase already uses elsewhere). Notification failures here are logged and do NOT block
// screening from being enqueued — previously they shared one try/catch, so a notification error
// silently meant the candidate was never screened at all.
async function runPostApplyPipeline(candidate, job) {
  try {
    const applicantUser = await User.findOne({ email: candidate.basicDetails.email, role: "candidate" });

    await notifyAdmin({
      companyId: job.company,
      type: "new_candidate_applied",
      title: "New candidate applied",
      message: `${candidate.basicDetails.name} applied for ${job.title}.`,
      meta: { candidateId: candidate._id, jobId: job._id },
    });

    await notifyCandidate({
      candidateId: candidate._id,
      userId: applicantUser?._id,
      type: "application_submitted",
      title: "Application submitted",
      message: `Your application for ${job.title} has been received.`,
      meta: { jobId: job._id },
      email: { to: candidate.basicDetails.email, template: "applicationSubmittedEmailTemplate", args: [candidate, job] },
    });
  } catch (err) {
    console.error(`[apply] post-apply notifications failed for candidate ${candidate._id}:`, err);
  }

  await atsService.enqueueScreening(candidate._id, job._id);
}

// Shared pagination parsing (Phase 12.5). Legacy callers (no page/limit param)
// keep getting a bare array, capped, so existing screens don't break; paginated
// callers get { items, total, page, pages, limit }.
function parsePagination(req, { defaultLimit = 50, maxLimit = 200, legacyCap = 500 } = {}) {
  const wantsPagination = req.query.page !== undefined || req.query.limit !== undefined;
  const requestedPage = Number(req.query.page);
  const requestedLimit = Number(req.query.limit);
  const page = Number.isFinite(requestedPage) ? Math.min(1000000, Math.max(1, Math.floor(requestedPage))) : 1;
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(maxLimit, Math.max(1, Math.floor(requestedLimit))) : defaultLimit;
  return { wantsPagination, page, limit, legacyCap };
}

async function listCandidatesForJob(req, res) {
  // A stale/broken link (e.g. a candidate whose job was deleted) can send a caller here with
  // a non-ObjectId `id` — without this guard Mongoose throws a CastError whose raw message
  // ("Cast to ObjectId failed for value \"undefined\" ... path \"job\"") leaks straight to the
  // admin UI instead of the plain "job not found" the frontend already knows how to render.
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: "Job not found" });
  }
  const filter = { job: req.params.id, company: req.user.company };
  if (req.query.stage && req.query.stage !== "all") filter.status = String(req.query.stage);
  if (req.query.q) {
    const query = String(req.query.q).trim().slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{ "basicDetails.name": { $regex: query, $options: "i" } }, { "basicDetails.email": { $regex: query, $options: "i" } }];
  }
  const { wantsPagination, page, limit, legacyCap } = parsePagination(req);
  if (!wantsPagination) {
    return res.json(await Candidate.find(filter).sort({ createdAt: -1 }).limit(legacyCap));
  }
  const [items, total] = await Promise.all([
    Candidate.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Candidate.countDocuments(filter),
  ]);
  res.json({ items, total, page, pages: Math.ceil(total / limit), limit });
}

// GET /api/candidates — company-wide, paginated, job populated (Phase 12.5).
// One request replaces the admin app's one-request-per-job fan-out.
//
// `?groupBy=candidate` (Phase 17): collapse a person's multiple applications
// into ONE row — { candidateUser, name, email, applicationCount,
// latestApplication, applications[] } — so the recruiter list stops showing the
// same person once per role. All other filters (jobId, stage) still apply and
// narrow which applications a person is grouped from.
async function listCandidates(req, res) {
  const filter = { company: req.user.company };
  if (req.query.jobId && mongoose.Types.ObjectId.isValid(req.query.jobId)) filter.job = req.query.jobId;
  if (req.query.stage && req.query.stage !== "all") {
    const stage = String(req.query.stage);
    filter.status = stage === "shortlisted" ? { $in: [stage, "next_round"] } : stage === "interview_scheduled" ? { $in: [stage, "interview_queue"] } : stage;
  }
  if (req.query.q) {
    const query = String(req.query.q).trim().slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{ "basicDetails.name": { $regex: query, $options: "i" } }, { "basicDetails.email": { $regex: query, $options: "i" } }];
  }
  if (req.query.reached) {
    const reached = String(req.query.reached);
    const stages = reached === "shortlisted" ? [reached, "next_round"] : reached === "interview_scheduled" ? [reached, "interview_queue"] : [reached];
    filter["stageHistory.stage"] = { $in: stages };
  }
  for (const [key, operator] of [["from", "$gte"], ["to", "$lte"]]) {
    if (!req.query[key]) continue;
    const date = new Date(String(req.query[key]));
    if (!Number.isFinite(date.getTime())) return res.status(400).json({ error: "Invalid report date filter" });
    filter.createdAt = { ...filter.createdAt, [operator]: date };
  }
  const { page, limit } = parsePagination(req, { defaultLimit: 200, maxLimit: 500 });

  if (req.query.groupBy === "candidate") {
    return res.json(await listCandidatesGrouped(req, filter, page, limit));
  }

  const [items, total] = await Promise.all([
    Candidate.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).populate("job", "title department status"),
    Candidate.countDocuments(filter),
  ]);
  res.json({ items, total, page, pages: Math.ceil(total / limit), limit });
}

// Aggregation for `?groupBy=candidate`. The tenant-scope plugin injects
// `{ company }` into find()/countDocuments() but NOT aggregate(), so `company`
// is matched explicitly here. Group key is the stable `candidateUser` when set,
// falling back to the application ID. Shared or absent email addresses never
// merge unlinked applications automatically.
async function listCandidatesGrouped(req, filter, page, limit) {
  const match = { ...filter, company: new mongoose.Types.ObjectId(String(req.user.company)) };
  if (filter.job) match.job = new mongoose.Types.ObjectId(String(filter.job));
  if (filter.status) match.status = filter.status;

  // Email is a contact hint, not proof of identity. Unlinked applications stay separate.
  const groupKey = { $ifNull: ["$candidateUser", "$_id"] };
  const pipeline = [
    { $match: match },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $group: {
        _id: groupKey,
        candidateUser: { $first: "$candidateUser" },
        name: { $first: "$basicDetails.name" },
        email: { $first: "$basicDetails.email" },
        applicationCount: { $sum: 1 },
        latestApplicationAt: { $max: "$createdAt" },
        latestAts: { $first: "$ats" },
        applications: {
          $push: {
            _id: "$_id",
            job: "$job",
            status: "$status",
            appliedAt: "$createdAt",
            pipelineExit: "$pipelineExit",
          },
        },
      },
    },
    { $sort: { latestApplicationAt: -1, _id: -1 } },
    {
      $facet: {
        rows: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          { $lookup: { from: "jobs", let: { ids: "$applications.job" }, pipeline: [
            { $match: { company: match.company, $expr: { $in: ["$_id", "$$ids"] } } },
            { $project: { title: 1, department: 1, status: 1 } },
          ], as: "_jobs" } },
        ],
        meta: [{ $count: "total" }],
      },
    },
  ];

  const [res0] = await Candidate.aggregate(pipeline);
  const total = res0?.meta?.[0]?.total || 0;
  const rows = (res0?.rows || []).map((row) => {
    const jobById = new Map((row._jobs || []).map((j) => [String(j._id), j]));
    const applications = row.applications
      .map((a) => {
        const j = jobById.get(String(a.job));
        return {
          _id: a._id,
          job: j ? { _id: j._id, title: j.title, department: j.department, status: j.status } : a.job,
          status: a.status,
          appliedAt: a.appliedAt,
          pipelineExit: a.pipelineExit?.at ? a.pipelineExit : undefined,
        };
      })
      .sort((a, b) => new Date(b.appliedAt) - new Date(a.appliedAt));
    return {
      candidateUser: row.candidateUser || null,
      name: row.name,
      email: row.email,
      applicationCount: row.applicationCount,
      latestApplication: applications[0] || null,
      latestAts: row.latestAts || null,
      applications,
    };
  });

  return { items: rows, total, page, pages: Math.ceil(total / limit), limit, groupedBy: "candidate" };
}

// GET /api/candidates/:id/related — other applications by the SAME person to
// OTHER jobs at the recruiter's own company. Company-scoped, so Company Y never
// sees Company X's applications for the same person (data isolation).
async function relatedApplications(req, res) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: "Candidate not found" });
  }
  const anchor = await Candidate.findOne({ _id: req.params.id, company: req.user.company })
    .select("candidateUser basicDetails.email");
  if (!anchor) return res.status(404).json({ error: "Candidate not found" });
  if (!anchor.candidateUser && !anchor.basicDetails?.email?.trim()) {
    return res.json({ count: 0, identityBasis: "unavailable", applications: [] });
  }

  // Match on the stable id when we have one, otherwise the email — never both as
  // an $or that could pull in a different person who happens to share neither.
  const identity = anchor.candidateUser
    ? { candidateUser: anchor.candidateUser }
    : { "basicDetails.email": anchor.basicDetails?.email };

  const siblings = await Candidate.find({
    company: req.user.company,
    _id: { $ne: anchor._id },
    ...identity,
  })
    .select("job status createdAt pipelineExit basicDetails.name")
    .sort({ createdAt: -1 })
    .populate("job", "title department status");

  res.json({
    count: siblings.length,
    identityBasis: anchor.candidateUser ? "account" : "shared_email",
    applications: siblings.map((s) => ({
      _id: s._id,
      job: s.job,
      status: s.status,
      appliedAt: s.createdAt,
      pipelineExit: s.pipelineExit?.at ? s.pipelineExit : undefined,
    })),
  });
}

async function getCandidate(req, res) {
  const candidate = await Candidate.findOne({ _id: req.params.id, company: req.user.company }).populate("job", "title");
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  res.json(candidate);
}

// Move a candidate to another pipeline stage. Accepts either `stage` (new) or
// `status` (legacy body key) plus an optional `note` and `offerMessage`. All
// validation, history, notifications, and realtime updates run in the pipeline
// service; invalid transitions throw and surface as 400.
async function moveStage(req, res) {
  const toStage = req.body.stage || req.body.status;
  if (!toStage) return res.status(400).json({ error: "A target stage is required" });

  // "title company interviewInstructions": a manual move INTO interview_scheduled
  // mints the AI interview invite (see pipelineService.ensureInterviewInvite),
  // which needs the job's company (tenant scope on the new session) and
  // interviewInstructions — a bare "title" projection silently produced a
  // sessionless, instructions-less invite.
  const candidate = await Candidate.findOne({ _id: req.params.id, company: req.user.company }).populate(
    "job",
    "title company interviewInstructions"
  );
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });

  await applyTransition(candidate, toStage, {
    note: req.body.note,
    offerMessage: req.body.offerMessage,
    actorName: req.user.name || req.user.email || "admin",
  });

  res.json(candidate);
}

async function getTimeline(req, res) {
  const candidate = await Candidate.findOne({ _id: req.params.id, company: req.user.company })
    .select("status stageHistory offer basicDetails job createdAt")
    .populate("job", "title");
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });

  res.json({
    status: candidate.status,
    stageLabel: stageLabel(candidate.status),
    stageHistory: candidate.stageHistory,
    offer: candidate.offer,
    allowedNextStages: allowedNextStages(candidate.status).map((s) => ({ stage: s, label: stageLabel(s) })),
  });
}

// Export the full candidate record (profile, ATS, timeline) as a downloadable
// JSON file. PDF report generation is a later phase; this covers "Export
// Candidate Data" today.
async function exportCandidate(req, res) {
  const candidate = await Candidate.findOne({ _id: req.params.id, company: req.user.company }).populate("job", "title");
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });

  const payload = {
    exportedAt: new Date().toISOString(),
    candidate: {
      name: candidate.basicDetails.name,
      email: candidate.basicDetails.email,
      phone: candidate.basicDetails.phone,
      location: candidate.basicDetails.location,
      job: candidate.job?.title,
      currentStage: stageLabel(candidate.status),
      appliedAt: candidate.createdAt,
    },
    ats: candidate.ats,
    offer: candidate.offer,
    timeline: candidate.stageHistory.map((h) => ({ stage: stageLabel(h.stage), by: h.by, note: h.note, at: h.at })),
    skills: candidate.skills,
    experience: candidate.experience,
    education: candidate.education,
    projects: candidate.projects,
    certificates: candidate.certificates,
  };

  const safeName = String(candidate.basicDetails.name || "candidate").replace(/[^a-z0-9]+/gi, "_");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}_report.json"`);
  res.send(JSON.stringify(payload, null, 2));
}

async function downloadResume(req, res) {
  const candidate = await Candidate.findOne({ _id: req.params.id, company: req.user.company });
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  if (!candidate.resumePath) return res.status(404).json({ error: "No resume on file" });
  await storageService.sendDownload(res, candidate.resumePath, candidate.resumeOriginalName || "resume");
}

async function getAtsResult(req, res) {
  const candidate = await Candidate.findOne({ _id: req.params.id, company: req.user.company }).select(
    "ats status basicDetails job"
  );
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  res.json(candidate.ats);
}

async function getRejectionReport(req, res) {
  const report = await require("../services/candidateRejectionReportService").getCandidateRejectionReport(req.params.id, req.user.company);
  if (!report) return res.status(404).json({ error: "Rejection analysis is not available yet" });
  res.json(report);
}

// Explainability payload (Phase 6.6) — "why this score", first-class: every
// criterion, its status, its weight, its contribution in points, and the
// quoted evidence behind it. 404 until the evidence engine has scored the
// candidate at least once (shadow or live).
async function getAssessment(req, res) {
  const candidate = await Candidate.findOne({ _id: req.params.id, company: req.user.company }).select(
    "basicDetails job hostility ats status"
  );
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });

  // Optional ?stage=pre_interview|post_interview picks a specific leg of the
  // Phase 8 loop; default stays "latest of any stage".
  const stageFilter = ["pre_interview", "post_interview"].includes(req.query.stage) ? { stage: req.query.stage } : {};
  const assessment = await AtsAssessment.findOne({ candidate: candidate._id, company: req.user.company, ...stageFilter }).sort({
    createdAt: -1,
  });
  if (!assessment) return res.status(404).json({ error: "No evidence assessment exists for this candidate yet" });

  // Pre/post pair + delta (Phase 8.5) — the "score changed because the
  // interview proved something" feature.
  const [preDoc, postDoc] = await Promise.all([
    AtsAssessment.findOne({ candidate: candidate._id, company: req.user.company, stage: "pre_interview" })
      .sort({ createdAt: -1 })
      .select("overallScore band decision scoredAt"),
    AtsAssessment.findOne({ candidate: candidate._id, company: req.user.company, stage: "post_interview" })
      .sort({ createdAt: -1 })
      .select("overallScore band decision scoredAt"),
  ]);
  const stages = {
    pre: preDoc ? { overallScore: preDoc.overallScore, band: preDoc.band, decision: preDoc.decision, scoredAt: preDoc.scoredAt } : null,
    post: postDoc ? { overallScore: postDoc.overallScore, band: postDoc.band, decision: postDoc.decision, scoredAt: postDoc.scoredAt } : null,
    delta: preDoc && postDoc ? postDoc.overallScore - preDoc.overallScore : null,
  };

  const graph = await ClaimGraph.findOne({ _id: assessment.claimGraph, company: req.user.company });
  const claimsById = new Map((graph?.claims || []).map((c) => [c.id, c]));

  const criterionFindings = assessment.criterionFindings.map((f) => ({
    ...f.toObject(),
    evidence: f.supportingClaimIds
      .map((id) => {
        const c = claimsById.get(id);
        if (!c) return null;
        return {
          claimId: id,
          statement: `${c.subject} ${c.predicate} ${c.object}`.trim(),
          quote: c.spans?.[0]?.quote || "",
          specificity: c.specificity,
          verificationStatus: c.verificationStatus,
        };
      })
      .filter(Boolean),
  }));

  // Calibration display (Phase 10.3) — "candidates scored like this advanced
  // X% of the time here". Null (hidden) below the honest sample minimums.
  // Display-only: it never feeds the score.
  const calibration = await require("../services/calibrationService")
    .getCalibrationForScore(req.user.company, assessment.overallScore)
    .catch(() => null);

  res.json({
    ...assessment.toObject(),
    criterionFindings,
    stages,
    calibration,
    internalContradictions: graph?.internalContradictions || [],
    timelineGaps: graph?.timelineGaps || [],
    extraction: graph?.extraction || null,
    hostility: candidate.hostility || null,
    legacyAts: candidate.ats || null,
    candidateName: candidate.basicDetails?.name,
  });
}

async function rerunAts(req, res) {
  const candidate = await Candidate.findOne({ _id: req.params.id, company: req.user.company });
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  const job = await Job.findById(candidate.job);
  if (!job) return res.status(404).json({ error: "Job not found for this candidate" });

  // A rerun re-parses and re-scores — a tenant at their screening cap can't
  // route around it through reruns (Phase 11.1). Enforced BEFORE the ack, so a
  // capped tenant still gets a real error instead of a silent no-op.
  await require("../services/quotaService").enforce(req.user.company, "resumeParsing", { actor: req.user });

  // Ack now, score in the background — same shape as applyToJob. A live-mode
  // rescore is several LLM calls (claim extraction alone runs over a minute),
  // which comfortably exceeds httpServer.requestTimeout: awaiting it here meant
  // the socket was torn down mid-scoring and the recruiter was shown "Could not
  // rescore candidate" for work that then completed successfully.
  res.status(202).json({ status: "rescoring", candidateId: candidate._id, previousScoredAt: candidate.ats?.scoredAt || null });

  await atsService.enqueueRescore(candidate._id, job._id);
}

// Curated AI-interview report for the admin review screen. Returns only what the
// recruiter needs (transcript + evaluation + provenance + stage actions) — never the
// session's magic-link tokenHash or other internals. Tenant-scoped by company.
// Assembles the AI interview report for a candidate (scoped to the company). Returns null when
// the candidate isn't found so callers can 404. Shared by the JSON endpoint (admin review screen)
// and the PDF export so both render identical data.
async function buildInterviewReport(candidateId, companyId, { attempt } = {}) {
  const candidate = await Candidate.findOne({ _id: candidateId, company: companyId })
    .select("basicDetails status job stageHistory assessmentDecision")
    .populate("job", "title department");
  if (!candidate) return null;

  const history = candidate.stageHistory || [];
  const lastDecision = history.length ? history[history.length - 1] : null;

  const base = {
    candidate: {
      id: candidate._id,
      name: candidate.basicDetails?.name,
      email: candidate.basicDetails?.email,
    },
    job: candidate.job ? { title: candidate.job.title, department: candidate.job.department } : null,
    stage: candidate.status,
    stageLabel: stageLabel(candidate.status),
    allowedNextStages: allowedNextStages(candidate.status).map((s) => ({ stage: s, label: stageLabel(s) })),
    // §7: who set the current outcome and when — reuses the existing append-only
    // stageHistory (pipelineService.applyTransition already records the actor: a real
    // admin's name/email for a manual move, "AI Interviewer" / "system" for automated ones).
    decisionTrail: lastDecision
      ? { stage: lastDecision.stage, stageLabel: stageLabel(lastDecision.stage), by: lastDecision.by, at: lastDecision.at, note: lastDecision.note }
      : null,
    // A3.5 — the skills-assessment leg of the pipeline, in the same report as the
    // interview it fed. Null when the assessment engine never touched this
    // candidate, so pre-existing reports render unchanged.
    assessment: await buildAssessmentSummary(candidate, companyId),
  };

  // §3.1: a candidate can have more than one interview attempt. Load every session so the report
  // can offer an attempt selector, then resolve the one actually being viewed — an explicit
  // `attempt` if the caller asked for one, otherwise the latest.
  const sessions = await InterviewSession.find({ candidate: candidate._id, company: companyId }).sort({ attempt: 1 });
  const attempts = sessions
    .filter((s) => s.aiInterview && s.aiInterview.status !== "not_started")
    .map((s) => ({
      attempt: s.attempt,
      status: s.aiInterview.status,
      completedAt: s.aiInterview.completedAt || null,
      recommendation: s.aiInterview.evaluation?.recommendation || null,
    }));
  const session = attempt != null ? sessions.find((s) => s.attempt === Number(attempt)) : sessions[sessions.length - 1];
  const ai = session && session.aiInterview;

  // Coverage spans all three evidence legs, so it is built whether or not the
  // interview ran — a report with no interview still has to show what the role
  // required, what the résumé claimed, and what the assessment actually tested.
  const coverage = await buildCoverage(candidate._id, companyId, ai, base.assessment);

  if (!ai || ai.status === "not_started") {
    return { ...base, coverage, hasInterview: false, attempts };
  }

  const substance = computeAnswerSubstance(ai.turns);
  const durationFlag = computeDurationFlag({ startedAt: ai.startedAt, completedAt: ai.completedAt, questionCount: ai.questionCount });
  const engineRan = ai.evaluation?.generatedBy === "ai";
  // §3 rule 5/6: when the audio path was broken we cannot distinguish "could not answer" from
  // "could not hear", so the report states that and withholds the recommendation instead of
  // printing a confident call over a broken signal.
  //
  // Computed BEFORE the verdict, and fed into it. It used to be computed after, which meant the
  // verdict itself was decided blind to whether we had heard the candidate at all: the
  // recommendedAction below was suppressed, but `verdict` was passed through raw and
  // interviewReportPdf prints it full-bleed at the top of page one. A session whose microphone
  // died therefore produced a PDF headed "CLEAR REJECT … Confidence: High".
  const sessionQuality = computeSessionQuality(ai.turns);
  const verdict = computeVerdict({
    responsiveCount: substance.responsiveCount,
    totalAnswers: substance.totalAnswers,
    declinedCount: substance.declinedCount,
    // An interview the candidate ended themselves never produces an automated adverse verdict —
    // the transcript is short by their choice, not by their performance (rule 6).
    endedEarly: ai.status === "ended_early",
    // Same guard, different fault: a halted interview is one WE stopped, so it can never produce
    // an automated verdict about the candidate either.
    halted: ai.status === "halted",
    // And the third: a link that expired mid-interview. Gave-up and got-failed-by-the-pipeline are
    // indistinguishable in this record, so neither is concluded (see computeVerdict).
    abandoned: ai.status === "abandoned",
    // The fourth, and the odd one out: unlike the three above, this IS about the candidate's own
    // signals — camera/identity/device flags crossed a hard threshold. Still no automated adverse
    // verdict (see computeVerdict's comment on why), just a different reason for withholding one.
    integrityTerminated: ai.status === "integrity_terminated",
    // And the fourth: we could not hear them. Narrower than sessionQuality.degraded on purpose —
    // that one also rises on "asked to repeat", which is a conduct signal and must not move a
    // verdict in either direction. See audioUnreliableFrom.
    audioUnreliable: sessionQuality.audioUnreliable,
    engineRan,
    overallScore: ai.evaluation?.overallScore,
  });

  return {
    ...base,
    coverage,
    hasInterview: true,
    attempts,
    interview: {
      sessionId: String(session._id),
      attempt: session.attempt,
      recruiterReview: require("../utils/interviewReview").reviewState(session),
      status: ai.status,
      engine: ai.engine,
      modality: ai.modality || "text",
      questionCount: ai.questionCount,
      maxQuestions: ai.maxQuestions,
      startedAt: ai.startedAt,
      completedAt: ai.completedAt,
      plan: ai.plan,
      transcript: buildTranscript(ai.turns, substance.answers),
      evaluation: ai.evaluation || null,
      competencyTriplet: competencyTripletOrNull(ai.evaluation),
      competencyTable: buildCompetencyTable(ai.turns),
      // The two rated panels — Cognitive Insights and Communication Skills.
      //
      // Curated explicitly rather than passed through with the rest of `evaluation`, for the same
      // reason haltedBy and integrityTerminated are: this is the payload contract, and a field
      // that reaches the admin report only because a schema happened to widen is a field nobody
      // decided to show anyone.
      //
      // `communication` is already null here when the role never declared it assesses how someone
      // communicates — that gate runs at finalisation (aiInterviewService.scoreInsights), so it
      // cannot be re-opened by a display toggle on this screen.
      insights: ai.evaluation?.insights || null,
      substance: {
        responsiveCount: substance.responsiveCount,
        totalAnswers: substance.totalAnswers,
        declinedCount: substance.declinedCount,
      },
      // Surfaced so the report can say the interview was ended by the candidate rather than
      // leaving a reviewer to infer it from a short transcript.
      endedEarly: ai.status === "ended_early" ? ai.endedEarly || { by: "candidate" } : null,
      // The link expired with the interview unfinished (abandonment sweep). Surfaced for the same
      // reason: a short transcript with no explanation reads exactly like someone who gave up,
      // and this record cannot say that.
      abandoned: ai.status === "abandoned" ? ai.abandoned || { at: ai.completedAt || null } : null,
      // WE stopped it, because the AI interviewer went outside its approved script. A reviewer must
      // see this above the transcript rather than deduce it: the candidate did nothing wrong, and a
      // short transcript with no explanation reads exactly like someone who gave up.
      haltedBy: ai.status === "halted" ? ai.haltedBy || { reason: "guardrail" } : null,
      // Anti-cheating hard stop: the candidate's own camera/identity/device signals crossed a hard
      // threshold. Curated the same way haltedBy is — a report field, not a schema passthrough — so
      // this must be listed explicitly or it never reaches the admin report/PDF.
      integrityTerminated: ai.status === "integrity_terminated" ? ai.integrityTerminated || { at: ai.completedAt || null } : null,
      // Every off-script utterance, verbatim, with the rule it broke. Normally empty. This is what
      // answers "what did the AI actually say to me?" — the question an unconstrained
      // speech-to-speech competitor has no way to answer at all.
      guardrailHits: (ai.guardrailHits || []).map((h) => ({
        ruleId: h.ruleId,
        severity: h.severity,
        label: h.label,
        utterance: h.utterance,
        at: h.at,
      })),
      // The unedited conversation, both sides, in the order it happened — the audit record, NOT
      // the assessment. `transcript` above is the scored evidence: answers, matched to questions,
      // as the engine segmented them. This is everything else, and it exists so that an interview
      // that went wrong looks different from a candidate who did badly. A reviewer reading nine
      // words of answer needs to be able to see whether the other two minutes were the candidate
      // asking if their microphone was working.
      //
      // Nothing derived from it enters a score. It is rendered separately and labelled as such.
      conversationLog: [
        ...(ai.agentUtterances || []).map((u) => ({ role: "interviewer", text: u.text, at: u.at })),
        ...(ai.candidateUtterances || []).map((u) => ({ role: "candidate", text: u.text, at: u.at })),
      ].sort((a, b) => new Date(a.at) - new Date(b.at)),
      // Which interviewer instructions this session ran under. Two candidates compared across a
      // prompt change were not given the same interview, and this is how a reviewer can tell.
      agentPromptVersion: ai.agentPromptVersion || null,
      durationFlag,
      sessionQuality,
      verdict,
      // The one word that makes the score readable ("is 72 good?"), decided in
      // the engine so this screen and the PDF cannot answer it differently.
      // `measurable` mirrors the report's own notMeasurable predicate: a
      // placeholder or degraded reading gets "Withheld", never a confident word.
      verdictChip: verdictFor({
        instrument: "interview",
        verdict,
        measurable: !(ai.evaluation?.generatedBy === "fallback" || sessionQuality.degraded),
      }),
      recommendedAction: sessionQuality.suppressRecommendation
        ? {
            action: "Re-interview",
            justification:
              "The recommendation is withheld: " +
              sessionQuality.reasons.join("; ") +
              ". On a degraded audio signal a non-answer cannot be told apart from an unheard question.",
            suppressed: true,
          }
        : recommendedAction(verdict, durationFlag),
    },
    // B1: the collapse is decided by whether THIS session had a recording fault — camera noise
    // during a broken session describes the fault, not the candidate.
    proctoring: buildProctoringSummary(session.proctoring, {
      technicalFault: Boolean(sessionQuality.audioUnreliable || ai.status === "halted"),
    }),
    // Phase 14.5 — evidence clips captured for high-severity flags. Metadata
    // only; the bytes stream through the audited evidence endpoint.
    evidenceClips: await require("../models/ProctoringEvidence")
      .find({ company: companyId, session: session._id })
      .sort({ capturedAt: 1 })
      .select("-clipKey -__v")
      .lean(),
    claimVerification: await buildClaimVerification(session, candidate._id, companyId),
  };
}

// A3.5 — the pre-interview skills assessment (or the recruiter's explicit skip)
// summarised for the report. A skip is a recorded human decision and renders as
// one — never as a missing assessment. Only scored results carry numbers; a
// live-but-unscored session surfaces as its status, not a placeholder.
async function buildAssessmentSummary(candidate, companyId) {
  const decision = candidate.assessmentDecision?.action ? candidate.assessmentDecision : null;
  const session = await require("../models/AssessmentSession")
    .findOne({ candidate: candidate._id, company: companyId })
    .sort({ createdAt: -1 })
    .select("status difficultyTier assignment startedAt completedAt result");
  if (!decision && !session) return null;

  return {
    decision: decision ? { action: decision.action, mode: decision.mode, byName: decision.byName, at: decision.at } : null,
    session: session
      ? {
          status: session.status,
          difficultyTier: session.difficultyTier?.value
            ? { value: session.difficultyTier.value, source: session.difficultyTier.source, basis: session.difficultyTier.basis }
            : null,
          assignedAt: session.assignment?.at || null,
          startedAt: session.startedAt || null,
          completedAt: session.completedAt || null,
          result: session.result?.scoredAt
            ? {
                scoredAt: session.result.scoredAt,
                scorerVersion: session.result.scorerVersion,
                reproducibilityHash: session.result.reproducibilityHash,
                totalItems: session.result.totalItems,
                totalCorrect: session.result.totalCorrect,
                perCriterion: session.result.perCriterion,
                claimVerdicts: session.result.claimVerdicts,
                completedBy: session.result.completedBy,
              }
            : null,
        }
      : null,
  };
}

// Phase 8.6 — the claim-verification loop, closed: each probed resume claim
// with its verdict, the resume quote and the transcript quote side by side,
// plus the pre→post score delta the verdicts produced. Null when the loop
// didn't run for this candidate (no probes and no post-interview assessment)
// so existing reports render unchanged.
async function buildClaimVerification(session, candidateId, companyId) {
  const probes = session?.aiInterview?.probes || [];
  const [pre, post] = await Promise.all([
    AtsAssessment.findOne({ candidate: candidateId, company: companyId, stage: "pre_interview" })
      .sort({ createdAt: -1 })
      .select("overallScore band decision scoredAt"),
    AtsAssessment.findOne({ candidate: candidateId, company: companyId, stage: "post_interview" })
      .sort({ createdAt: -1 })
      .select("overallScore band decision scoredAt"),
  ]);
  if (probes.length === 0 && !post) return null;

  return {
    probes: probes.map((p) => ({
      claimId: p.claimId,
      criterionId: p.criterionId,
      question: p.question,
      status: p.status,
      // "pending"/"asked" probes have no verdict yet — render as unresolved,
      // never as a placeholder measurement.
      verdict: p.status === "assessed" ? p.verdict : null,
      verdictReasoning: p.status === "assessed" ? p.verdictReasoning : null,
      resumeQuote: p.resumeQuote || "",
      answerQuote: p.answerQuote || "",
    })),
    scoreDelta:
      pre && post
        ? {
            pre: { overallScore: pre.overallScore, band: pre.band, scoredAt: pre.scoredAt },
            post: { overallScore: post.overallScore, band: post.band, scoredAt: post.scoredAt },
            delta: post.overallScore - pre.overallScore,
          }
        : null,
  };
}

// The evidence coverage matrix. The criterion labels and weights come from the
// pre-interview assessment's own criterionFindings, so the report shows the rubric
// exactly as it was scored against (frozen version), not as it reads today.
async function buildCoverage(candidateId, companyId, ai, assessmentSummary) {
  const pre = await AtsAssessment.findOne({ candidate: candidateId, company: companyId, stage: "pre_interview" })
    .sort({ createdAt: -1 })
    .select("criterionFindings rubricVersion scoredAt overallScore band decision scorerVersion reproducibilityHash promptVersions model claimGraph")
    .lean();
  if (!pre) return null;

  // The claim graph behind the three CV analysis cards. Already built, already
  // cited, already consistency-checked (utils/claimConsistency) — this route
  // simply was not reading it. `hostility` rides on the candidate because the
  // defence scan runs at upload, before any rubric exists.
  const graph = pre.claimGraph
    ? await ClaimGraph.findOne({ _id: pre.claimGraph, company: companyId })
        .select("claims internalContradictions timelineGaps extraction")
        .lean()
    : null;
  const candidateDoc = await Candidate.findOne({ _id: candidateId, company: companyId }).select("hostility").lean();

  const matrix = buildCoverageMatrix({
    criterionFindings: pre.criterionFindings,
    perCriterion: assessmentSummary?.session?.result?.perCriterion || [],
    probes: ai?.probes || [],
    // A1: covered résumé anchors upgrade their criterion's interview cell untested → partial.
    anchors: ai?.resumeAnchors || [],
    // C5: lets an asked-but-unresolved probe say WHY it resolved nothing ("the audio broke"
    // vs "the loop never closed"). Cells never move on this flag — only the cause label does.
    audioUnreliable: ai ? computeSessionQuality(ai.turns).audioUnreliable : false,
  });
  if (!matrix) return null;
  return {
    ...matrix,
    rubricVersion: pre.rubricVersion,
    screenedAt: pre.scoredAt,
    // The résumé leg as an instrument in its own right, so the report can render
    // it with the same card the interview uses: a score, a verdict word, a
    // sentence, and three lists. Everything here is composed in code from the
    // findings the screening run already produced — see the header comment on
    // composeResumeNarrative for why no model call was added.
    resumeEvaluation: {
      overallScore: pre.overallScore,
      band: pre.band,
      decision: pre.decision,
      verdict: verdictFor({ instrument: "resume", band: pre.band }),
      narrative: composeResumeNarrative(pre.criterionFindings),
      ...resumeFindingLists(pre.criterionFindings),
      provenance: {
        rubricVersion: pre.rubricVersion,
        scoredAt: pre.scoredAt,
        scorerVersion: pre.scorerVersion || null,
        reproducibilityHash: pre.reproducibilityHash || null,
        model: pre.model || null,
        promptVersion: (pre.promptVersions || [])[0] || null,
      },
    },
    // The three CV analysis cards. Pure joins over the claim graph and the
    // hostility report — no model runs, and every row that makes a claim carries
    // the span it came from. See utils/resumeSignals.js, including the two
    // things it deliberately refuses to do (score employment gaps, and rate
    // personality traits off a self-written document).
    cvAnalysis: graph
      ? {
          professionalism: documentProfessionalism(graph),
          redFlags: redFlagAnalysis({
            internalContradictions: graph.internalContradictions || [],
            timelineGaps: graph.timelineGaps || [],
            hostility: candidateDoc?.hostility || null,
            extraction: graph.extraction || null,
          }),
          attributes: keyAttributes(graph, {
            totalMonths: analyzeTimeline(graph.claims || []).totalMonths,
          }),
        }
      : null,
  };
}

// §2: merges each candidate turn with its precomputed substance stats (word count /
// duration / responsive tag). `answers` is indexed over candidate turns only (see
// interviewReportEngine.computeAnswerSubstance), so a running counter maps one to the other.
function buildTranscript(turns, answers) {
  let answerIndex = 0;
  return (turns || []).map((t) => {
    const row = {
      role: t.role,
      kind: t.kind,
      text: t.text,
      topic: t.topic,
      difficulty: t.difficulty,
      answerScore: t.answerScore,
      inputMode: t.inputMode,
      // A per-answer "delivery" score used to be sent here and rendered on every spoken answer as
      // "Delivery: 64/100". It is gone: it scored candidates on pace and hesitation, which is an
      // accent and disability proxy no rubric approved (utils/prosody.js). What remains is the
      // raw evidence a reviewer needs to see WHY a turn was flagged as unusable audio — a silent
      // turn and a rushed one look different, and neither is a statement about the person.
      pauseRatio: t.acoustic?.pauseRatio,
      wordsPerMinute: t.acoustic?.wordsPerMinute,
      at: t.at,
      // Never the storage key itself — just whether one exists. Playback goes through the
      // audit-logged stream route (interviewSessionController.streamTurnAudio), keyed by this
      // row's position in the array, which is 1:1 with the raw turn index (this map never filters).
      hasAudio: Boolean(t.audioKey),
    };
    if (t.role === "candidate") {
      const a = answers[answerIndex++];
      if (a) Object.assign(row, { wordCount: a.wordCount, durationSec: a.durationSec, responsive: a.responsive });
    }
    return row;
  });
}

// Recruiter-facing integrity summary for the report. Returns null when nothing was recorded (older
// interviews, or the candidate declined proctoring) so the UI can hide the section entirely.
function buildProctoringSummary(p, { technicalFault = false } = {}) {
  if (!p) return null;
  const hasSignal = (p.totalEvents || 0) > 0 || p.consent?.given || p.consent?.declined || p.identityMatch?.status !== "unknown";
  if (!hasSignal) return null;

  // Recomputed fresh from the raw per-type counts (not the persisted riskScore/riskBand,
  // which may have been written under an older, less-dampened formula) so the severity
  // fix in utils/proctoring.js applies to already-completed sessions too.
  const { riskScore, riskBand } = proctoring.computeRisk(p.counts);
  const identityUnknown = (p.identityMatch?.status || "unknown") === "unknown";
  // §8: gate the headline risk behind identity verification — if we don't know who was
  // sitting there, don't let a "High" risk badge read as proof of misconduct.
  const displayRiskScore = identityUnknown ? Math.min(riskScore, 49) : riskScore;
  const displayRiskBand = identityUnknown ? proctoring.bandFor(displayRiskScore) : riskBand;

  // B1: the display roll-up — distinct findings with the collapse labelled, and the band
  // withheld outright when the session had a recording fault on our side.
  const collapse = proctoring.collapseForDisplay(p.counts, { technicalFault });

  return {
    consent: p.consent || null,
    visionEnabled: !!p.visionEnabled,
    riskScore,
    riskBand,
    displayRiskScore,
    displayRiskBand,
    identityGated: identityUnknown,
    identityGateNote: identityUnknown ? "Identity unverified — integrity signals unreliable." : null,
    totalEvents: p.totalEvents || 0,
    identityMatch: p.identityMatch || null,
    breakdown: collapse.findings,
    distinctFindings: collapse.distinctFindings,
    collapsedNote: collapse.collapsedNote,
    bandWithheld: collapse.bandWithheld,
    bandWithheldReason: collapse.bandWithheldReason,
    recentEvents: (p.events || [])
      .slice(-25)
      .reverse()
      .map((e) => ({ type: e.type, label: proctoring.labelOf(e.type), severity: e.severity, meta: e.meta, at: e.at })),
  };
}

async function getInterviewReport(req, res) {
  const report = await buildInterviewReport(req.params.id, req.user.company, { attempt: req.query.attempt });
  if (!report) return res.status(404).json({ error: "Candidate not found" });
  res.json(require("../utils/reportPresentation").reviewReport(report));
}

// Streams the same report as a downloadable PDF.
async function getInterviewReportPdf(req, res) {
  const report = await buildInterviewReport(req.params.id, req.user.company, { attempt: req.query.attempt });
  if (!report) return res.status(404).json({ error: "Candidate not found" });

  const { buildReportPdf } = require("../services/interviewReportPdf");
  const pdf = buildReportPdf(require("../utils/reportPresentation").reviewReport(report));

  const safeName = String(report.candidate?.name || "candidate").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "candidate";
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="interview-report-${safeName}.pdf"`);
  res.setHeader("Content-Length", pdf.length);
  res.send(pdf);
}

module.exports = {
  applyToJob,
  autofillFromResume,
  listCandidates,
  listCandidatesForJob,
  relatedApplications,
  getCandidate,
  moveStage,
  getTimeline,
  exportCandidate,
  downloadResume,
  getAtsResult,
  getRejectionReport,
  getAssessment,
  rerunAts,
  getInterviewReport,
  getInterviewReportPdf,
};
