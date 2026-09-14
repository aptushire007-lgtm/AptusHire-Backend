const Job = require("../models/Job");
const Candidate = require("../models/Candidate");
const mongoose = require("mongoose");
const { generateJobSlug } = require("../utils/slug");
const rubricService = require("../services/rubricService");
const { sourceHashOf } = require("../utils/rubricEngine");
const capacityService = require("../services/jobCapacityService");
const readinessService = require("../services/jobReadinessService");
const { problem } = require("../utils/setupDraft");
const { getJson, setJson } = require("../services/redisCache");

const RECRUITER_ONLY_JOB_FIELDS = [
  "setupDraft",
  "numberOfOpenings",
  "filledOpenings",
  "pendingOffers",
  "autoClosedAt",
  "closureReason",
];

function toPublicJob(job) {
  const payload = job?.toObject ? job.toObject() : { ...job };
  const company = payload.company && typeof payload.company === "object"
    ? { _id: payload.company._id, name: payload.company.name, logoPath: payload.company.logoPath }
    : undefined;
  return {
    _id: payload._id,
    slug: payload.slug,
    title: payload.title,
    department: payload.department,
    location: payload.location,
    description: payload.description,
    requirements: payload.requirements,
    status: payload.status,
    requiredSkills: payload.requiredSkills,
    minExperienceYears: payload.minExperienceYears,
    requiredEducation: payload.requiredEducation,
    company,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function createJob(req, res) {
  // Plan quota (Phase 11.1): job postings block at the plan boundary with a
  // machine-readable 429 — never a silent failure.
  await require("../services/quotaService").enforce(req.user.company, "jobs", { actor: req.user });

  const {
    slug,
    status,
    setupDraft,
    _id,
    __v,
    filledOpenings,
    pendingOffers,
    autoClosedAt,
    closureReason,
    ...body
  } = req.body;
  body.numberOfOpenings = capacityService.validateNumberOfOpenings(body.numberOfOpenings ?? 1);
  const job = await Job.create({ ...body, company: req.user.company, slug: generateJobSlug(body.title), status: "draft" });

  // Compile a draft rubric the moment the JD exists — nothing else in the product
  // prompts a recruiter to visit the Scoring Rubric screen, so without this a job
  // can go live and collect candidates while permanently stuck at rubricStatus
  // "none" (candidates silently scored by the legacy keyword engine forever).
  // Fire-and-forget, same pattern as updateJob's supersede call: a draft still
  // requires a human to review and approve — this only ensures one exists to review.
  rubricService
    .compile(job)
    .then((draft) => console.log(`[rubric] auto-compiled draft v${draft.version} for new job ${job._id}`))
    .catch((err) => console.error(`[rubric] auto-compile failed for new job ${job._id}:`, err.code || err.message));

  res.status(201).json(job);
}

// §1.2 — search/filter/pagination. Ported from adminNotificationController.listMine's pattern
// (escapeRegex, $and array, $or over fields, { items, total, page, limit, totalPages } envelope),
// not reinvented. One real difference from that pattern: rubricStatus isn't a field on Job —
// it's computed per-job from the RoleRubric collection (rubricService.latestStatusesForJobs) — so
// filtering on it can't be pushed into the same Mongo query as title/department/location/status.
// Company-scale here is a tenant's own job list (low hundreds at most, not a job board), so this
// resolves status+search at the DB level, computes rubricStatus for that matched set, then applies
// the rubricStatus filter and pagination in memory. Legacy callers (no page/limit in the query)
// still get a bare array — nothing that already consumes this endpoint without pagination breaks.
async function listJobs(req, res) {
  const { page, limit, search, status, rubricStatus } = req.query;
  const wantsPagination = page !== undefined || limit !== undefined || search || status || rubricStatus;

  const and = [{ company: req.user.company }];
  if (status) and.push({ status });
  if (search) {
    const pattern = new RegExp(escapeRegex(String(search)), "i");
    and.push({ $or: [{ title: pattern }, { department: pattern }, { location: pattern }] });
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));

  // If pagination is requested and no rubricStatus filter is applied, bound the query at DB level.
  if (wantsPagination && !rubricStatus) {
    const total = await Job.countDocuments({ $and: and });
    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    const jobs = await Job.find({ $and: and })
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const statusByJob = await rubricService.latestStatusesForJobs(
      jobs.map((j) => j._id),
      req.user.company
    );
    let items = jobs.map((j) => ({
      ...j,
      rubricStatus: statusByJob.get(String(j._id)) || "none",
    }));

    if (req.query.includeCounts === "1" && items.length) {
      const counts = await Candidate.aggregate([
        { $match: { company: new mongoose.Types.ObjectId(String(req.user.company)), job: { $in: items.map((job) => job._id) } } },
        { $group: { _id: { job: "$job", stage: "$status" }, count: { $sum: 1 } } },
      ]);
      const byJob = new Map();
      for (const row of counts) {
        const key = String(row._id.job);
        if (!byJob.has(key)) byJob.set(key, { total: 0, stages: {} });
        const value = byJob.get(key);
        value.total += row.count;
        value.stages[row._id.stage] = row.count;
      }
      items = items.map((job) => ({ ...job, applicationCounts: byJob.get(String(job._id)) || { total: 0, stages: {} } }));
    }

    return res.json({ items, total, page: pageNum, limit: limitNum, totalPages });
  }

  // Fallback path when rubricStatus filter is used or legacy unpaged callers
  const jobs = await Job.find({ $and: and }).sort({ createdAt: -1 }).lean();
  const statusByJob = await rubricService.latestStatusesForJobs(
    jobs.map((j) => j._id),
    req.user.company
  );
  let withRubricStatus = jobs.map((j) => ({
    ...j,
    rubricStatus: statusByJob.get(String(j._id)) || "none",
  }));
  if (req.query.includeCounts === "1" && jobs.length) {
    const counts = await Candidate.aggregate([
      { $match: { company: new mongoose.Types.ObjectId(String(req.user.company)), job: { $in: jobs.map((job) => job._id) } } },
      { $group: { _id: { job: "$job", stage: "$status" }, count: { $sum: 1 } } },
    ]);
    const byJob = new Map();
    for (const row of counts) {
      const key = String(row._id.job);
      if (!byJob.has(key)) byJob.set(key, { total: 0, stages: {} });
      const value = byJob.get(key);
      value.total += row.count;
      value.stages[row._id.stage] = row.count;
    }
    withRubricStatus = withRubricStatus.map((job) => ({ ...job, applicationCounts: byJob.get(String(job._id)) || { total: 0, stages: {} } }));
  }

  if (rubricStatus) {
    withRubricStatus = withRubricStatus.filter((j) => j.rubricStatus === rubricStatus);
  }

  if (!wantsPagination) {
    return res.json(withRubricStatus);
  }

  const total = withRubricStatus.length;
  const items = withRubricStatus.slice((pageNum - 1) * limitNum, pageNum * limitNum);
  return res.json({ items, total, page: pageNum, limit: limitNum, totalPages: Math.max(1, Math.ceil(total / limitNum)) });
}

async function listPublishedJobs(req, res) {
  const cached = await getJson("public-jobs:list");
  if (cached) return res.json(cached);
  const jobs = await Job.find({ status: "published" }).populate("company", "name logoPath").sort({ createdAt: -1 }).limit(200).lean();
  const payload = jobs.map(toPublicJob);
  await setJson("public-jobs:list", payload, 60);
  res.json(payload);
}

async function getJob(req, res) {
  const job = await Job.findByIdOrSlug(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  // Public callers may only see PUBLISHED jobs. An authenticated admin of the owning
  // company may see it at any status (for editing drafts). Without this, draft/closed
  // postings — including atsThreshold and interview instructions — leak to anyone by
  // guessable slug (tenant-isolation defect F1).
  const isOwningAdmin =
    req.user &&
    req.user.role === "admin" &&
    req.user.company &&
    String(job.company) === String(req.user.company);
  if (job.status !== "published" && !isOwningAdmin) {
    return res.status(404).json({ error: "Job not found" });
  }
  const publicCacheKey = `public-jobs:detail:${String(job._id)}`;
  const cachedPublic = !isOwningAdmin && (await getJson(publicCacheKey));
  if (cachedPublic) {
    if (req.user?.role === "candidate") {
      const email = String(req.user.email || "").toLowerCase().trim();
      const mine = await Candidate.findOne({ company: job.company, job: job._id, $or: [{ candidateUser: req.user._id }, { "basicDetails.email": email }] }).select("_id status").lean();
      cachedPublic.alreadyApplied = Boolean(mine);
      if (mine) cachedPublic.myApplication = { _id: mine._id, status: mine.status };
    }
    return res.json(cachedPublic);
  }
  await job.populate("company", "name logoPath");
  const payload = isOwningAdmin ? job.toObject() : toPublicJob(job);
  // Rubric-approval state is only meaningful (and only ours to disclose) to the
  // owning admin — public candidate-portal callers never see it.
  if (isOwningAdmin) {
    payload.rubricStatus = await rubricService.latestStatusForJob(job._id, req.user.company);
    if (job.setupDraft) {
      const setup = await require("../models/SetupDraft").findOne({ _id: job.setupDraft, company: req.user.company, owner: req.user._id }).select("_id").lean();
      if (setup) payload.setupDraftId = String(setup._id);
    }
  } else {
    for (const field of RECRUITER_ONLY_JOB_FIELDS) delete payload[field];
  }

  // A signed-in candidate: has this person already applied to this job? One
  // application per job per person is enforced at POST /apply (409 + unique
  // index); this lets the portal show "Applied" instead of an Apply button
  // that would only fail. Matched on the stable account id OR the email so a
  // pre-Phase-17 application (email only) is still recognised.
  if (req.user && req.user.role === "candidate") {
    const email = String(req.user.email || "").toLowerCase().trim();
    const mine = await Candidate.findOne({
      company: job.company,
      job: job._id,
      $or: [{ candidateUser: req.user._id }, { "basicDetails.email": email }],
    })
      .select("_id status")
      .lean();
    payload.alreadyApplied = Boolean(mine);
    if (mine) payload.myApplication = { _id: mine._id, status: mine.status };
  }

  if (!isOwningAdmin) await setJson(publicCacheKey, payload, 60);

  res.json(payload);
}

async function updateJob(req, res) {
  const {
    company,
    setupDraft,
    _id,
    __v,
    revision,
    filledOpenings,
    pendingOffers,
    autoClosedAt,
    closureReason,
    ...updates
  } = req.body;
  if (updates.numberOfOpenings !== undefined) {
    updates.numberOfOpenings = capacityService.validateNumberOfOpenings(updates.numberOfOpenings);
  }
  const job = await Job.findOne({ _id: req.params.id, company: req.user.company });
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (revision !== undefined && revision !== (job.__v || 0)) throw problem(409, "This job changed in another tab. Reload the latest job before saving your changes.", "JOB_CONFLICT");
  if (updates.status === "published" && job.status !== "published") throw problem(409, "Use the publication review action to publish this role.", "PUBLICATION_REVIEW_REQUIRED");

  // If the edit changed the JD content, any existing rubric is now compiled from
  // stale text — supersede() drafts a new version (the old approved one stays
  // active, and historical scores keep pointing at it, until a human approves
  // the successor). Fire-and-forget: rubric compilation must not block the save.
  const hashBefore = sourceHashOf(job);
  const wasPublished = job.status === "published";
  Object.assign(job, updates);
  if (updates.status === "published") {
    job.autoClosedAt = undefined;
    job.closureReason = undefined;
  }
  await job.save();

  // Lifecycle sync (Phase 15.8): un-publishing a job withdraws it from every
  // board it went to. Fire-and-forget — board round-trips must not block the save.
  if (wasPublished && job.status !== "published") {
    require("../services/jobPublishService")
      .withdrawAllForJob(job._id, req.user.company, `status → ${job.status}`)
      .catch((err) => console.error(`[publish] withdraw-all failed for job ${job._id}:`, err.message));
  }

  const actorName = req.user.name || req.user.email || "admin";
  // Closing a role has no live seat to hire into — release its in-flight
  // candidates from the board (records kept, not rejected). Re-publishing puts
  // the close/fill-released ones back.
  if (wasPublished && job.status === "closed") {
    capacityService
      .releaseJobCandidates(job._id, req.user.company, "job_closed", { actorName })
      .catch((err) => console.error(`[lifecycle] release candidates failed for job ${job._id}:`, err.message));
  } else if (!wasPublished && job.status === "published") {
    capacityService
      .restoreJobCandidates(job._id, req.user.company, { actorName })
      .catch((err) => console.error(`[lifecycle] restore candidates failed for job ${job._id}:`, err.message));
  }
  if (sourceHashOf(job) !== hashBefore) {
    rubricService
      .supersede(job)
      .then((draft) => {
        if (draft) console.log(`[rubric] JD edit superseded rubric for job ${job._id} — draft v${draft.version} awaiting review`);
      })
      .catch((err) => console.error(`[rubric] supersede failed for job ${job._id}:`, err.message));
  }
  const capacity = updates.numberOfOpenings !== undefined || updates.status === "published"
    ? await capacityService.reconcileJobCapacity(job._id, req.user.company, { actorName: req.user.name || req.user.email || "admin" })
    : null;
  invalidatePublicJobCache(job._id).catch(() => {});
  if (wasPublished || job.status === "published") careersService.cacheClear();
  res.json(capacity?.job || job);
}

async function publishJob(req, res) {
  const job = await Job.findOne({ _id: req.params.id, company: req.user.company });
  if (!job) return res.status(404).json({ error: "Job not found" });
  await readinessService.assertPublishable(job, req.user.company);

  // §1.4: a job cannot go live without an approved rubric. Every candidate who applies to a job
  // with no approved rubric falls back to the legacy keyword engine (evidenceAtsService.js
  // requires an approved RoleRubric before the evidence engine can drive a decision), and
  // probeService.js refuses to generate résumé-derived interview probes at all in that state
  // (reason: "no_assessment") — this is the upstream root cause of "not asking questions from the
  // résumé." JobList.jsx already shows rubricStatus as a badge; this turns it from a warning a
  // recruiter can publish straight past into an actual gate.
  const rubricStatus = await rubricService.latestStatusForJob(job._id, req.user.company);
  if (rubricStatus !== "approved") {
    return res.status(409).json({
      error:
        rubricStatus === "none"
          ? "This job has no scoring rubric yet — compile and approve one before publishing."
          : "This job's scoring rubric is not approved yet — approve it before publishing.",
      code: "RUBRIC_NOT_APPROVED",
      rubricStatus,
    });
  }

  const snapshot = await capacityService.capacitySnapshot(job._id, req.user.company);
  const openings = capacityService.validateNumberOfOpenings(job.numberOfOpenings ?? 1);
  if (snapshot.filledOpenings >= openings) {
    return res.status(409).json({
      error: "This job already has all openings filled. Increase the number of openings before publishing it again.",
      code: "OPENINGS_FILLED",
      numberOfOpenings: openings,
      filledOpenings: snapshot.filledOpenings,
    });
  }

  job.status = "published";
  job.filledOpenings = snapshot.filledOpenings;
  job.pendingOffers = snapshot.pendingOffers;
  job.autoClosedAt = undefined;
  job.closureReason = undefined;
  await job.save();
  invalidatePublicJobCache(job._id).catch(() => {});
  careersService.cacheClear();

  // Re-opening the role puts back the candidates that a previous close/fill
  // released from the board (delete- and hire-elsewhere exits stay put).
  capacityService
    .restoreJobCandidates(job._id, req.user.company, { actorName: req.user.name || req.user.email || "admin" })
    .catch((err) => console.error(`[lifecycle] restore candidates failed for job ${job._id}:`, err.message));

  res.json(job);
}

async function deleteJob(req, res) {
  const job = await Job.findOneAndDelete({ _id: req.params.id, company: req.user.company });
  if (!job) return res.status(404).json({ error: "Job not found" });
  invalidatePublicJobCache(job._id).catch(() => {});
  careersService.cacheClear();
  // Review items for this job can no longer be resolved — `resolveItem` needs
  // the job to advance anyone into its interview loop, and "advance to an
  // interview for a role that was deleted" is not a decision. Left behind they
  // sit in the queue forever asking a recruiter to make it.
  await require("../models/ReviewItem").deleteMany({ company: req.user.company, job: job._id });
  // Candidates for a deleted role can never be actioned — take them off the
  // board (`pipelineExit`). The Candidate records themselves are KEPT: they are
  // application history and feed reporting/audit; only the pipeline view drops
  // them. Not marked `rejected` — no one decided that.
  await capacityService
    .releaseJobCandidates(job._id, req.user.company, "job_deleted", {
      actorName: req.user.name || req.user.email || "admin",
    })
    .catch((err) => console.error(`[lifecycle] release candidates failed for deleted job ${job._id}:`, err.message));
  // Lifecycle sync (Phase 15.8): a deleted job is withdrawn from every board.
  require("../services/jobPublishService")
    .withdrawAllForJob(job._id, req.user.company, "job deleted")
    .catch((err) => console.error(`[publish] withdraw-all failed for job ${job._id}:`, err.message));
  // Clean up any linked or reserved setup drafts for this job so no zombie setups persist
  await require("../models/SetupDraft")
    .deleteMany({ company: req.user.company, $or: [{ job: job._id }, { reservedJobId: job._id }] })
    .catch((err) => console.error(`[setupDraft] cleanup failed for deleted job ${job._id}:`, err.message));
  res.status(204).send();
}

// ---------------------------------------------------------------------------
// Phase 15 — multi-board publishing
// ---------------------------------------------------------------------------

// GET /api/jobs/:id/publications — per-board status for the publish UI: the
// driver list (with tier + availability) merged with this job's PublishedJob rows.
async function listPublications(req, res) {
  const job = await Job.findOne({ _id: req.params.id, company: req.user.company });
  if (!job) return res.status(404).json({ error: "Job not found" });

  const { listDrivers } = require("../services/connectors");
  const PublishedJob = require("../models/PublishedJob");
  const boardCredentialService = require("../services/boardCredentialService");

  const rows = await PublishedJob.find({ company: req.user.company, job: job._id }).lean();
  const byBoard = Object.fromEntries(rows.map((r) => [r.board, r]));

  const boards = [];
  for (const d of listDrivers()) {
    const credential = d.needsCredential ? await boardCredentialService.status(req.user.company, d.key) : null;
    const row = byBoard[d.key];
    boards.push({
      board: d.key,
      name: d.name,
      tier: d.tier,
      enabled: d.enabled,
      reason: d.reason,
      needsCredential: d.needsCredential,
      credentialConfigured: credential ? credential.configured : true,
      validationErrors: d.enabled ? require("../services/connectors").getDriver(d.key).validate(job) : [],
      status: row?.status || null,
      externalUrl: row?.externalUrl || null,
      error: row?.error || null,
      publishedAt: row?.publishedAt || null,
      lastSyncedAt: row?.lastSyncedAt || null,
    });
  }
  res.json({ boards });
}

// POST /api/jobs/:id/publish-boards  body: { boards: ["careers", "naukri", …] }
async function publishBoards(req, res) {
  const job = await Job.findOne({ _id: req.params.id, company: req.user.company });
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "published") throw problem(409, "Publish the reviewed job to your careers page before distributing it to job boards.", "CAREERS_PUBLICATION_REQUIRED");
  await readinessService.assertPublishable(job, req.user.company);
  if (job.status !== "published") {
    return res.status(400).json({ error: "Publish the job in the ATS first — boards only receive published jobs" });
  }
  const boards = Array.isArray(req.body?.boards) ? req.body.boards.slice(0, 20) : [];
  if (!boards.length) return res.status(400).json({ error: "boards is required" });

  const results = await require("../services/jobPublishService").publishToBoards(job, boards, req.user);
  res.json({ results });
}

// POST /api/jobs/:id/withdraw-board  body: { board }
async function withdrawBoard(req, res) {
  const job = await Job.findOne({ _id: req.params.id, company: req.user.company });
  if (!job) return res.status(404).json({ error: "Job not found" });
  const PublishedJob = require("../models/PublishedJob");
  const row = await PublishedJob.findOne({ company: req.user.company, job: job._id, board: String(req.body?.board || "").toLowerCase() });
  if (!row) return res.status(404).json({ error: "This job is not published on that board" });
  await require("../services/jobPublishService").processPublication(row._id, "withdraw");
  res.json({ ok: true });
}

// POST /api/jobs/generate-jd  body: { title, department, location }
async function generateJobDescription(req, res) {
  const title = String(req.body?.title || "").trim();
  if (!title) {
    return res.status(400).json({ error: "Job title is required to generate a job description" });
  }

  const requestedDepartment = String(req.body?.department || "").trim();
  const requestedLocation = String(req.body?.location || "").trim();

  // Deterministic fallback generator
  function fallbackJD(t) {
    const lower = t.toLowerCase();
    let dept = requestedDepartment;
    if (!dept) {
      if (/engineer|developer|frontend|backend|fullstack|devops|qa|architect|software|cloud/i.test(lower)) dept = "Engineering";
      else if (/design|ux|ui|graphic|product designer/i.test(lower)) dept = "Design";
      else if (/product manager|product owner|program manager/i.test(lower)) dept = "Product";
      else if (/marketing|growth|seo|content|social/i.test(lower)) dept = "Marketing";
      else if (/sales|account|business development|bdm/i.test(lower)) dept = "Sales";
      else if (/hr|recruiter|people|talent/i.test(lower)) dept = "Human Resources";
      else if (/finance|accountant|analyst|audit/i.test(lower)) dept = "Finance";
      else dept = "General";
    }

    let minExp = 3;
    if (/lead|principal|staff|director|head|vp/i.test(lower)) minExp = 7;
    else if (/senior|sr/i.test(lower)) minExp = 5;
    else if (/junior|jr|intern|associate|entry/i.test(lower)) minExp = 1;

    const skills = [];
    if (/frontend|react|vue|angular/i.test(lower)) skills.push("React", "JavaScript", "TypeScript", "HTML5 & CSS3", "Responsive UI");
    if (/backend|node|express|api/i.test(lower)) skills.push("Node.js", "Express", "RESTful APIs", "SQL", "System Architecture");
    if (/fullstack|full stack/i.test(lower)) skills.push("React", "Node.js", "TypeScript", "Database Design", "API Development");
    if (/python|data|ml|machine learning|ai/i.test(lower)) skills.push("Python", "Machine Learning", "Data Analysis", "SQL", "Model Evaluation");
    if (/devops|cloud|infrastructure/i.test(lower)) skills.push("AWS", "Docker", "Kubernetes", "CI/CD Pipelines", "Terraform");
    if (/design|ui|ux/i.test(lower)) skills.push("Figma", "Design Systems", "Prototyping", "User Research", "Wireframing");
    if (/product/i.test(lower)) skills.push("Product Strategy", "Roadmapping", "Agile / Scrum", "Data-Driven Prioritization", "Stakeholder Management");
    if (/marketing/i.test(lower)) skills.push("Growth Marketing", "Campaign Strategy", "SEO / SEM", "Content Strategy", "Analytics");
    if (skills.length === 0) skills.push("Communication", "Problem Solving", "Project Management", "Analytical Skills");

    const description = `About the Role:\nWe are seeking a talented, proactive ${t} to join our team. In this position, you will take ownership of key initiatives, collaborate closely with cross-functional team members, and contribute directly to high-impact products and customer solutions.\n\nKey Responsibilities:\n• Lead and contribute to core deliverables aligned with our strategic roadmap.\n• Collaborate with cross-functional stakeholders including engineering, design, and operations.\n• Establish best practices, maintain quality standards, and drive continuous optimization.\n• Identify operational and architectural opportunities to scale workflows efficiently.\n• Mentor teammates and champion a culture of continuous learning and delivery.`;

    const requirements = `Requirements & Qualifications:\n• Proven experience working as a ${t} or in a directly related professional capacity.\n• Demonstrated track record of delivering high-quality outcomes in a collaborative environment.\n• Strong problem-solving, diagnostic, and analytical capabilities.\n• Exceptional written and verbal communication skills across technical and business audiences.\n• Bachelor's degree in a relevant field or equivalent practical experience.`;

    return {
      title: t,
      department: dept,
      location: requestedLocation || "Remote / Hybrid",
      description,
      requirements,
      requiredSkills: skills,
      minExperienceYears: minExp,
      requiredEducation: "Bachelor's Degree",
      numberOfOpenings: 1,
      atsThreshold: 60,
      generatedBy: "fallback",
    };
  }

  const llm = require("../services/llmService");
  if (!llm.isEnabled()) {
    return res.json(fallbackJD(title));
  }

  try {
    const prompt = `Generate a comprehensive, modern job description for the role: "${title}".
Department preference: ${requestedDepartment || "Infer appropriate department"}
Location preference: ${requestedLocation || "Remote / Hybrid"}

Provide:
1. description: A clear 2-3 paragraph overview of the role, team context, and bulleted Key Responsibilities.
2. requirements: Clear bulleted Requirements & Qualifications (experience, mindset, soft skills, practical background).
3. requiredSkills: Array of 4 to 6 top required technical or role-specific skills (e.g. ["React", "TypeScript", "Node.js"]).
4. minExperienceYears: Suggested minimum years of experience as an integer (e.g. 1, 3, 5, 7).
5. department: Appropriate department name (e.g. "Engineering", "Design", "Product", "Marketing").
6. requiredEducation: Standard education requirement (e.g. "Bachelor's Degree in Computer Science or related field").`;

    const schema = {
      type: "object",
      properties: {
        description: { type: "string" },
        requirements: { type: "string" },
        requiredSkills: { type: "array", items: { type: "string" } },
        minExperienceYears: { type: "number" },
        department: { type: "string" },
        requiredEducation: { type: "string" },
        atsThreshold: { type: "number" },
      },
      required: ["description", "requirements", "requiredSkills"],
      additionalProperties: false,
    };

    const { data } = await llm.generateJSON({
      system: "You are an expert HR and recruitment director. Output precise, production-ready job descriptions with clear responsibilities and measurable qualifications in valid JSON format.",
      prompt,
      schema,
      temperature: 0.2,
      maxTokens: 1024,
      promptVersion: "jd_gen_v1",
    });

    res.json({
      title,
      department: data.department || requestedDepartment || "General",
      location: requestedLocation || "Remote / Hybrid",
      description: data.description || fallbackJD(title).description,
      requirements: data.requirements || fallbackJD(title).requirements,
      requiredSkills: Array.isArray(data.requiredSkills) && data.requiredSkills.length ? data.requiredSkills : fallbackJD(title).requiredSkills,
      minExperienceYears: typeof data.minExperienceYears === "number" ? data.minExperienceYears : fallbackJD(title).minExperienceYears,
      requiredEducation: data.requiredEducation || "Bachelor's Degree",
      numberOfOpenings: 1,
      atsThreshold: 60,
      generatedBy: "ai",
    });
  } catch (err) {
    console.warn(`[jobController] AI JD generation failed (${err.message}), falling back to deterministic template`);
    res.json(fallbackJD(title));
  }
}

module.exports = {
  createJob,
  listJobs,
  listPublishedJobs,
  getJob,
  updateJob,
  publishJob,
  deleteJob,
  listPublications,
  publishBoards,
  withdrawBoard,
  generateJobDescription,
};

