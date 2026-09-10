const Job = require("../models/Job");
const Candidate = require("../models/Candidate");
const { generateJobSlug } = require("../utils/slug");
const rubricService = require("../services/rubricService");
const { sourceHashOf } = require("../utils/rubricEngine");
const capacityService = require("../services/jobCapacityService");
const { getJson, setJson, invalidatePublicJobCache } = require("../services/redisCache");
const careersService = require("../services/careersService");

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
    filledOpenings,
    pendingOffers,
    autoClosedAt,
    closureReason,
    ...body
  } = req.body;
  body.numberOfOpenings = capacityService.validateNumberOfOpenings(body.numberOfOpenings ?? 1);
  const job = await Job.create({ ...body, company: req.user.company, slug: generateJobSlug(body.title) });
  if (job.status === "published") careersService.cacheClear();

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

  const jobs = await Job.find({ $and: and }).sort({ createdAt: -1 }).lean();
  // Every job the recruiter sees carries its rubric-approval state, so an
  // unapproved rubric (⇒ candidates silently fall back to the legacy keyword
  // engine, see evidenceAtsService.js) is visible on the jobs list itself
  // instead of only discoverable candidate-by-candidate.
  const statusByJob = await rubricService.latestStatusesForJobs(
    jobs.map((j) => j._id),
    req.user.company
  );
  let withRubricStatus = jobs.map((j) => ({
    ...j,
    rubricStatus: statusByJob.get(String(j._id)) || "none",
  }));
  if (rubricStatus) {
    withRubricStatus = withRubricStatus.filter((j) => j.rubricStatus === rubricStatus);
  }

  if (!wantsPagination) {
    return res.json(withRubricStatus);
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
  const total = withRubricStatus.length;
  const items = withRubricStatus.slice((pageNum - 1) * limitNum, pageNum * limitNum);
  res.json({ items, total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 });
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
};
