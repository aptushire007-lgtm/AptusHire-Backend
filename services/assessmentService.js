// Assessment sessions + the recruiter gate + deterministic scoring orchestration
// (ASSESSMENT-ENGINE-PLAN A2/A3).
//
// The trigger model (A2.3): assessments NEVER start themselves. A session exists
// only because a recruiter assigned it ("Send assessment"), or because a job
// explicitly runs `assessmentPolicy: auto` (drives — creating the drive IS the
// bulk assignment decision). "Skip to AI interview" is today's exact
// ats_passed → interview_scheduled transition — zero new code path.
//
// Everything per-candidate here is CODE: seeded assembly, claim-derived
// tiering, key-match scoring, deterministic verdicts, pure rescore. The only
// LLM spend in this whole file is zero.

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const AssessmentSession = require("../models/AssessmentSession");
const AssessmentPaper = require("../models/AssessmentPaper");
const AtsAssessment = require("../models/AtsAssessment");
const ClaimGraph = require("../models/ClaimGraph");
const RoleRubric = require("../models/RoleRubric");
const User = require("../models/User");
const paperService = require("./assessmentPaperService");
const quotaService = require("./quotaService");
const { notifyCandidate, notifyAdmin } = require("./notificationService");
const { emitToCompany } = require("../config/socket");
const { candidateLinkBase } = require("../utils/corsOrigins");
const { applyTransition } = require("./pipelineService");
const scorer = require("../utils/assessmentScorer");
const assembly = require("../utils/assessmentAssembly");
const { computeAssessment, reproducibilityHash, claimsStateHash, SCORER_VERSION } = require("../utils/evidenceScorer");
const { checkInvariants } = require("../utils/assessmentInvariants");
const proctoring = require("../utils/proctoring");

const VALIDITY_HOURS = () => Number(process.env.ASSESSMENT_LINK_VALIDITY_HOURS) || 72;
const SOFTLOCK_AUTORESUME_MS = () => (Number(process.env.ASSESSMENT_SOFTLOCK_AUTORESUME_MIN) || 3) * 60 * 1000;

// A3 rollback seam: false ⇒ pure A2 behaviour (uniform assembly, no write-back,
// no rescore, no probe dedup).
function claimLoopEnabled() {
  const v = process.env.ASSESSMENT_CLAIM_LOOP_ENABLED;
  return v !== "false" && v !== "0";
}

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function buildAssessmentUrl(token) {
  return `${candidateLinkBase()}/assessment/${token}`;
}

function emitTrackerUpdate(session) {
  emitToCompany(session.company, "assessment:update", {
    sessionId: String(session._id),
    candidateId: String(session.candidate?._id || session.candidate),
    jobId: String(session.job?._id || session.job),
    status: session.status,
  });
}

// ---------------------------------------------------------------------------
// The recruiter gate (A2.3)
// ---------------------------------------------------------------------------

async function liveSessionFor(candidateId, jobId) {
  return AssessmentSession.findOne({
    candidate: candidateId,
    job: jobId,
    status: { $in: ["scheduled", "in_progress", "paused"] },
  });
}

/**
 * "Send assessment" — the ONLY path that creates a session. Idempotent per
 * live session. `user` is the assigning recruiter (null only for auto mode).
 * `difficultyOverride` (easy|medium|hard) is the recruiter's per-candidate
 * override; it beats claim derivation and the paper's fixed tier.
 */
async function sendAssessment(candidate, job, { user, mode = "manual", difficultyOverride, actorName } = {}) {
  await paperService.assertEnabled(job.company);
  if (mode === "manual" && !user && !actorName) throw httpError(400, "Manual assignment requires the assigning recruiter");
  if (difficultyOverride && !["easy", "medium", "hard"].includes(difficultyOverride)) {
    throw httpError(400, "difficultyOverride must be easy, medium, or hard");
  }

  const existing = await liveSessionFor(candidate._id, job._id);
  if (existing) return { session: existing, created: false };

  const paper = await paperService.getActivePaper(job._id, job.company);
  if (!paper) {
    throw httpError(409, "This job has no approved assessment paper yet — generate and approve one in the job's Assessment tab", "NO_APPROVED_PAPER");
  }

  // A3.0 — claim-derived tier (code over the candidate's own claims), unless the
  // recruiter overrode it in the send dialog.
  let claims = null;
  if (claimLoopEnabled()) {
    const graph = await ClaimGraph.findOne({ candidate: candidate._id, company: job.company }).sort({ createdAt: -1 });
    if (graph) claims = graph.claims.map((c) => (c.toObject ? c.toObject() : c));
  }
  const difficultyTier = assembly.resolveTier({ paper, claims, recruiterOverride: difficultyOverride });

  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const validityMs = (job.assessmentValidityHours || VALIDITY_HOURS()) * 60 * 60 * 1000;
  const startDeadlineMs = (job.assessmentStartDeadlineHours || job.assessmentValidityHours || VALIDITY_HOURS()) * 60 * 60 * 1000;

  const session = await AssessmentSession.create({
    candidate: candidate._id,
    job: job._id,
    company: job.company,
    paper: paper._id,
    paperVersion: paper.version,
    assignment: {
      assignedBy: user?._id,
      assignedByName: user?.name || actorName || (mode === "auto" ? "auto (job assessment policy)" : "recruiter"),
      at: now,
      mode,
    },
    difficultyTier,
    tokenHash: hashToken(token),
    validFrom: now,
    startDeadline: new Date(now.getTime() + Math.min(startDeadlineMs, validityMs)),
    expiresAt: new Date(now.getTime() + validityMs),
    softLock: {
      enabled: Boolean(paper.integrityDefaults?.softLock?.enabled),
      flagThreshold: paper.integrityDefaults?.softLock?.flagThreshold || 3,
      action: paper.integrityDefaults?.softLock?.action === "auto_submit" ? "auto_submit" : "pause",
    },
  });

  // The gate decision is a recorded fact on the candidate (renders everywhere).
  candidate.assessmentDecision = {
    action: "sent",
    mode,
    by: user?._id,
    byName: session.assignment.assignedByName,
    at: now,
  };
  // Stage move (opt-in stage; the skip path never enters it). Guarded: a
  // candidate already past ats_passed (e.g. re-send) keeps their stage.
  if (["applied", "ats_passed"].includes(candidate.status)) {
    await applyTransition(candidate, "assessment_scheduled", {
      note: difficultyOverride
        ? `Assessment sent (difficulty override: ${difficultyOverride})`
        : `Assessment sent (${difficultyTier.value} tier — ${difficultyTier.basis})`,
      actorName: session.assignment.assignedByName,
    });
  } else {
    await candidate.save();
  }

  const assessmentUrl = buildAssessmentUrl(token);
  const applicantUser = await User.findOne({ email: candidate.basicDetails.email, role: "candidate" });
  await notifyCandidate({
    candidateId: candidate._id,
    userId: applicantUser?._id,
    type: "assessment_invite",
    title: `Skills assessment for ${job.title}`,
    message: `You've been invited to a skills assessment — take it any time before ${session.expiresAt.toLocaleString("en-US", { timeZone: process.env.MAIL_TIMEZONE || "Asia/Kolkata", timeZoneName: "short" })}. Check your email for the link.`,
    meta: { assessmentSessionId: session._id, jobId: job._id },
    email: {
      to: candidate.basicDetails.email,
      template: "assessmentInvitationEmailTemplate",
      args: [candidate, job, { ...session.toObject(), assessmentUrl, instructions: paper.instructions }],
    },
  });

  emitTrackerUpdate(session);
  return { session, created: true, assessmentUrl };
}

/**
 * "Skip to AI interview" — records the decision, then runs TODAY'S transition
 * unchanged. The skip renders everywhere as a recruiter decision, never as
 * missing data (§3 rule 8).
 */
async function skipAssessment(candidate, { user }) {
  if (!user) throw httpError(400, "Skipping requires the deciding recruiter");
  candidate.assessmentDecision = {
    action: "skipped",
    mode: "manual",
    by: user._id,
    byName: user.name || user.email,
    at: new Date(),
  };
  // The existing pipeline transition mints the InterviewQueue entry + interview
  // magic link + invite email (pipelineService.ensureInterviewInvite).
  return applyTransition(candidate, "interview_scheduled", {
    note: "Assessment skipped by recruiter decision — straight to AI interview",
    actorName: user.name || user.email,
  });
}

/**
 * Auto mode (A4.4 drives): called from the ATS pass path when
 * job.assessmentPolicy === "auto". Failure falls back to parking the candidate —
 * an auto-assign error must never lose a candidate.
 */
async function autoAssignAfterAtsPass(candidate, job) {
  const { session } = await sendAssessment(candidate, job, { mode: "auto" });
  return session;
}

/** Rotate the link (recruiter resend). Fresh token, fresh windows, re-email. */
async function resendAssessment(session, candidate, job) {
  if (session.status === "completed") throw httpError(409, "This assessment is already completed");
  if (session.status === "in_progress" && new Date() <= session.expiresAt) {
    throw httpError(409, "This assessment is in progress on a valid link — resending now would cut the candidate off");
  }

  const paper = await AssessmentPaper.findById(session.paper);
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const validityMs = (job.assessmentValidityHours || VALIDITY_HOURS()) * 60 * 60 * 1000;
  session.tokenHash = hashToken(token);
  session.validFrom = now;
  session.startDeadline = new Date(now.getTime() + validityMs);
  session.expiresAt = new Date(now.getTime() + validityMs);
  if (session.status === "expired" || session.status === "cancelled") session.status = session.startedAt ? "in_progress" : "scheduled";
  session.reminder24hSent = false;
  session.reminder1hSent = false;
  await session.save();

  const assessmentUrl = buildAssessmentUrl(token);
  const applicantUser = await User.findOne({ email: candidate.basicDetails.email, role: "candidate" });
  await notifyCandidate({
    candidateId: candidate._id,
    userId: applicantUser?._id,
    type: "assessment_invite",
    title: `Your assessment link for ${job.title}`,
    message: `Here is your refreshed assessment link for ${job.title}.`,
    meta: { assessmentSessionId: session._id, jobId: job._id },
    email: {
      to: candidate.basicDetails.email,
      template: "assessmentInvitationEmailTemplate",
      args: [candidate, job, { ...session.toObject(), assessmentUrl, instructions: paper?.instructions }],
    },
  });
  emitTrackerUpdate(session);
  return { session, assessmentUrl };
}

// ---------------------------------------------------------------------------
// Candidate portal (A2.4/A2.5) — allow-listed payloads, server-authoritative time
// ---------------------------------------------------------------------------

function signPortalToken(session) {
  const expiresInSeconds = Math.max(60, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
  return jwt.sign(
    { candidateId: String(session.candidate._id || session.candidate), sessionId: String(session._id) },
    process.env.JWT_SECRET,
    { expiresIn: expiresInSeconds, audience: "assessment" }
  );
}

// The gate between "this is the right person" and a live portal token, split
// out from the magic-link lookup because ownership can now be proved two ways:
// possession of the mailbox (the emailed token) or possession of the account
// whose email owns the application (the candidate dashboard). Both clear the
// same cancelled/expired rules here, so the two entry points can never disagree
// about whether an assessment is still open.
async function openSession(session) {
  if (session.status === "cancelled") throw httpError(410, "This assessment has been cancelled");
  if (new Date() > session.expiresAt) {
    await expireSession(session);
    throw httpError(410, "This assessment link has expired");
  }
  if (!session.accessedAt) {
    session.accessedAt = new Date();
    await session.save();
  }
  return { token: signPortalToken(session), session };
}

async function loginWithToken(token) {
  const session = await AssessmentSession.findOne({ tokenHash: hashToken(token) })
    .populate("candidate")
    .populate("job");
  if (!session) throw httpError(404, "Invalid assessment link");
  return openSession(session);
}

// The candidate-facing session payload. ALLOW-LIST ONLY — and structurally no
// item keys: candidate item payloads are built by itemsPayload below, which
// never reads `key`. A serializer test greps every portal payload for "key".
function dashboardPayload(session, candidate, job, paper) {
  // Per-section answered counts, computed with the SCORER's own isAnswered — so
  // the number a candidate reads before the final submit is literally the number
  // that gets scored, not a second opinion rendered by the client. Keys are never
  // touched here; this counts presence of an answer, never its correctness.
  const typeById = new Map((paper?.items || []).map((i) => [i.id, i.type]));
  const responseById = new Map((session.responses || []).map((r) => [r.itemId, r.response]));
  const answeredBySection = new Map();
  for (const assembled of session.assembledItems || []) {
    const prev = answeredBySection.get(assembled.sectionId) || 0;
    const answered = scorer.isAnswered(typeById.get(assembled.itemId), responseById.get(assembled.itemId));
    answeredBySection.set(assembled.sectionId, prev + (answered ? 1 : 0));
  }

  return {
    candidateName: candidate.basicDetails.name,
    jobTitle: job.title,
    department: job.department,
    status: session.status,
    startDeadline: session.startDeadline,
    expiresAt: session.expiresAt,
    startedAt: session.startedAt,
    instructions: paper?.instructions || "",
    timing: { mode: paper?.timing?.mode || "per_section" },
    sections: (paper?.sections || []).map((s) => ({
      id: s.id,
      title: s.title,
      itemCount: Math.min(
        s.servedItemCount,
        session.assembledItems.length
          ? session.assembledItems.filter((a) => a.sectionId === s.id).length || s.servedItemCount
          : s.servedItemCount
      ),
      timeLimitSec: s.timeLimitSec,
      answeredCount: answeredBySection.get(s.id) || 0,
    })),
    sectionState: session.sectionState,
    deviceCheck: session.deviceCheck,
    proctoringRequired: Boolean(paper?.integrityDefaults?.proctoring),
    paused: session.status === "paused",
    terminatedForIntegrity: session.result?.completedBy === "integrity_violation",
  };
}

/** Candidate item payloads for ONE section — allow-listed, keys never read. */
function itemsPayload(session, paper, sectionId) {
  const itemsById = new Map(paper.items.map((i) => [i.id, i]));
  const responsesByItem = new Map(session.responses.map((r) => [r.itemId, r]));
  return session.assembledItems
    .filter((a) => a.sectionId === sectionId)
    .sort((a, b) => a.order - b.order)
    .map((assembled) => {
      const item = itemsById.get(assembled.itemId);
      const optionsById = new Map((item.options || []).map((o) => [o.id, o]));
      const saved = responsesByItem.get(assembled.itemId);
      return {
        itemId: assembled.itemId,
        sectionId: assembled.sectionId,
        order: assembled.order,
        type: item.type,
        stem: item.stem,
        options: (assembled.optionOrder || []).map((id) => ({ id, text: optionsById.get(id)?.text || "" })),
        response: saved?.response ?? null,
        markedForReview: Boolean(saved?.markedForReview),
      };
    });
}

async function expireSession(session) {
  if (["completed", "cancelled"].includes(session.status)) return session;
  if (session.startedAt && session.status !== "expired") {
    // Partial work is scored and labelled — never discarded (§A2 guardrail).
    return finalizeSession(session, { completedBy: "expiry" });
  }
  if (session.status !== "expired") {
    session.status = "expired";
    await session.save();
    emitTrackerUpdate(session);
  }
  return session;
}

/**
 * Start the assessment: quota is enforced HERE (started sessions consume the
 * plan dimension; invitations that die untouched consume nothing), the item set
 * is assembled (seeded, tier-filtered, claim-targeted), and the clock begins.
 */
async function startAssessment(session) {
  if (session.status === "completed") throw httpError(409, "This assessment is already completed");
  const now = new Date();
  if (now > session.expiresAt) {
    await expireSession(session);
    throw httpError(410, "This assessment link has expired");
  }
  if (session.startedAt) return session; // resume — never re-assemble, never re-charge quota

  if (now > session.startDeadline) {
    session.status = "expired";
    await session.save();
    emitTrackerUpdate(session);
    throw httpError(410, "The window to start this assessment has passed");
  }

  await quotaService.enforce(session.company, "assessments");

  const paper = await AssessmentPaper.findById(session.paper);
  if (!paper) throw httpError(500, "Assessment paper missing");

  // A3.1 targeting: this candidate's unverified high-weight claims become
  // priority items. Legacy candidates (no evidence assessment) degrade silently
  // to uniform assembly — labelled by targetsClaimId simply being absent.
  let targetClaims = [];
  if (claimLoopEnabled()) {
    const pre = await AtsAssessment.findOne({
      candidate: session.candidate,
      company: session.company,
      stage: "pre_interview",
      engine: "evidence",
    }).sort({ createdAt: -1 });
    if (pre) {
      const graph = await ClaimGraph.findById(pre.claimGraph);
      const claimsById = new Map((graph?.claims || []).map((c) => [c.id, c]));
      targetClaims = (pre.unverifiedHighWeightClaims || [])
        .filter((u) => {
          const claim = claimsById.get(u.claimId);
          // Already proven elsewhere ⇒ no need to probe it here.
          return claim && !["verified_in_interview", "verified_in_assessment"].includes(claim.verificationStatus);
        })
        .map((u) => ({ claimId: u.claimId, criterionId: u.criterionId }));
    }
  }

  session.assembledItems = assembly.assemble({
    paper,
    sessionId: String(session._id),
    tier: session.difficultyTier?.value || paper.difficultyPolicy?.fixedTier || "medium",
    targetClaims,
  });
  session.sectionState = paper.sections.map((s) => ({ sectionId: s.id, status: "not_started" }));
  session.startedAt = now;
  session.status = "in_progress";
  await session.save();
  emitTrackerUpdate(session);
  return session;
}

function sectionOf(paper, sectionId) {
  const section = (paper.sections || []).find((s) => s.id === sectionId);
  if (!section) throw httpError(404, "Unknown section");
  return section;
}

function sectionStateOf(session, sectionId) {
  const state = (session.sectionState || []).find((s) => s.sectionId === sectionId);
  if (!state) throw httpError(409, "Assessment not started");
  return state;
}

/** Server-authoritative remaining seconds for an in-progress section. */
function remainingSecFor(section, state) {
  if (state.status !== "in_progress" || !state.startedAt) return section.timeLimitSec;
  const elapsed = Math.floor((Date.now() - state.startedAt.getTime()) / 1000);
  return Math.max(0, section.timeLimitSec - elapsed);
}

async function startSection(session, sectionId) {
  await guardLive(session);
  const paper = await AssessmentPaper.findById(session.paper);
  const section = sectionOf(paper, sectionId);
  const state = sectionStateOf(session, sectionId);
  if (state.status === "completed") throw httpError(409, "This section is already submitted");

  // One section at a time — auto-close any other in-progress section first.
  for (const other of session.sectionState) {
    if (other.sectionId !== sectionId && other.status === "in_progress") {
      await closeSection(session, paper, other, "expiry");
    }
  }
  if (state.status === "not_started") {
    state.status = "in_progress";
    state.startedAt = new Date();
  } else if (state.status === "in_progress" && remainingSecFor(section, state) <= 0) {
    await closeSection(session, paper, state, "expiry");
    await session.save();
    throw httpError(410, "This section's time is over");
  }
  await session.save();
  return { section, state, remainingSec: remainingSecFor(section, state), items: itemsPayload(session, paper, sectionId) };
}

async function closeSection(session, paper, state, how) {
  const section = sectionOf(paper, state.sectionId);
  state.status = "completed";
  state.completedAt = new Date();
  if (state.startedAt) {
    state.timeSpentMs = Math.min(section.timeLimitSec * 1000, Date.now() - state.startedAt.getTime());
  }
  session.markModified("sectionState");
}

async function guardLive(session) {
  if (session.status === "completed") throw httpError(409, "This assessment is already completed");
  if (session.status === "cancelled") throw httpError(410, "This assessment has been cancelled");
  if (new Date() > session.expiresAt) {
    await expireSession(session);
    throw httpError(410, "This assessment has expired — your saved answers were submitted");
  }
  // A4.2 soft-lock fail-open: no human response within the window ⇒ auto-RESUME.
  if (session.status === "paused") {
    const pausedFor = Date.now() - (session.pause?.pausedAt?.getTime() || 0);
    if (pausedFor >= SOFTLOCK_AUTORESUME_MS()) {
      await resumeFromPause(session, { by: "system (auto-resume — no reviewer response)", auto: true });
    } else {
      throw httpError(423, "Your assessment is briefly paused — a reviewer has been notified. It will resume shortly.", "ASSESSMENT_PAUSED");
    }
  }
  if (!session.startedAt) throw httpError(409, "Assessment not started");
}

/**
 * Autosave one answer (A2.5). Every answer PATCHes immediately; timing is
 * checked server-side on EVERY write — a hacked client cannot buy time.
 */
async function saveResponse(session, { itemId, response, markedForReview, timeSpentMs }) {
  await guardLive(session);
  const assembled = session.assembledItems.find((a) => a.itemId === itemId);
  if (!assembled) throw httpError(404, "Unknown item");

  const paper = await AssessmentPaper.findById(session.paper);
  const section = sectionOf(paper, assembled.sectionId);
  const state = sectionStateOf(session, assembled.sectionId);
  if (state.status === "completed") throw httpError(409, "This section is already submitted");
  if (state.status !== "in_progress") throw httpError(409, "Start the section before answering");
  if (remainingSecFor(section, state) <= 0) {
    await closeSection(session, paper, state, "expiry");
    await session.save();
    throw httpError(410, "This section's time is over — it has been submitted with your saved answers");
  }

  // Sanitise: responses are ids/numbers only, never free text (§3.6 — nothing a
  // candidate types is ever fed to a model in v1).
  let clean = null;
  const item = paper.items.find((i) => i.id === itemId);
  if (item.type === "numeric") {
    const n = Number(response);
    clean = Number.isFinite(n) ? n : null;
  } else if (Array.isArray(response)) {
    const validIds = new Set((item.options || []).map((o) => o.id));
    clean = response.map((v) => String(v || "").trim().toLowerCase()).filter((v) => validIds.has(v)).slice(0, 8);
  }

  const existing = session.responses.find((r) => r.itemId === itemId);
  if (existing) {
    existing.response = clean;
    existing.markedForReview = Boolean(markedForReview);
    existing.timeSpentMs = Math.max(0, Number(timeSpentMs) || existing.timeSpentMs || 0);
    existing.savedAt = new Date();
  } else {
    session.responses.push({
      itemId,
      response: clean,
      markedForReview: Boolean(markedForReview),
      timeSpentMs: Math.max(0, Number(timeSpentMs) || 0),
      savedAt: new Date(),
    });
  }
  session.markModified("responses");
  await session.save();
  return { remainingSec: remainingSecFor(section, state) };
}

async function submitSection(session, sectionId) {
  await guardLive(session);
  const paper = await AssessmentPaper.findById(session.paper);
  const state = sectionStateOf(session, sectionId);
  if (state.status === "completed") return session;
  await closeSection(session, paper, state, "submit");
  await session.save();
  return session;
}

/** Final submit: closes any open section, then scores. */
async function submitAssessment(session) {
  await guardLive(session);
  const paper = await AssessmentPaper.findById(session.paper);
  for (const state of session.sectionState) {
    if (state.status === "in_progress") await closeSection(session, paper, state, "submit");
  }
  return finalizeSession(session, { completedBy: "submit" });
}

// ---------------------------------------------------------------------------
// Finalisation: pure scoring → verdict write-back → post_assessment rescore →
// pipeline advance (A3.2/A3.3/A3.4 wiring)
// ---------------------------------------------------------------------------

async function finalizeSession(session, { completedBy }) {
  if (session.status === "completed") return session;
  const paper = await AssessmentPaper.findById(session.paper);
  if (!paper) throw httpError(500, "Assessment paper missing");

  const scored = scorer.scoreSession({
    paper,
    assembledItems: session.assembledItems,
    responses: session.responses,
  });
  const verdicts = claimLoopEnabled()
    ? scorer.claimVerdicts({ paper, assembledItems: session.assembledItems, perItem: scored.perItem })
    : [];

  session.result = {
    scoredAt: new Date(),
    scorerVersion: scored.scorerVersion,
    reproducibilityHash: scored.reproducibilityHash,
    totalItems: scored.totalItems,
    totalCorrect: scored.totalCorrect,
    perItem: scored.perItem,
    perCriterion: scored.perCriterion,
    claimVerdicts: verdicts,
    completedBy,
  };
  session.status = "completed";
  session.completedAt = new Date();
  for (const state of session.sectionState) {
    if (state.status === "in_progress") state.status = "completed";
  }
  session.markModified("sectionState");
  await session.save();
  emitTrackerUpdate(session);

  // A5.1 exposure telemetry — the one permitted write to a frozen paper.
  try {
    const correctByItem = new Map(scored.perItem.map((p) => [p.itemId, p.correct]));
    for (const assembled of session.assembledItems) {
      const item = paper.items.find((i) => i.id === assembled.itemId);
      if (!item) continue;
      item.exposure.serves += 1;
      if (correctByItem.get(item.id)) item.exposure.corrects += 1;
    }
    paper.markModified("items");
    await paper.save();
  } catch (err) {
    console.warn("[assessment] exposure telemetry write failed:", err.message);
  }

  // The claim loop — every step guarded: a failure here must never strand the
  // candidate mid-pipeline.
  const Candidate = require("../models/Candidate");
  const candidate = await Candidate.findById(session.candidate).populate("job");
  try {
    if (claimLoopEnabled() && verdicts.length) {
      await writeVerdictsToClaimGraph(session, verdicts);
    }
    if (claimLoopEnabled() && candidate) {
      await rescoreAfterAssessment(candidate);
    }
  } catch (err) {
    console.error("[assessment] claim write-back/rescore failed (scores unaffected):", err.message);
  }

  // Contradictions surface to a HUMAN — never an auto-reject (§3 rule 4/6).
  const contradicted = verdicts.filter((v) => v.verdict === "contradicted");
  if (contradicted.length && candidate) {
    await notifyAdmin({
      companyId: session.company,
      type: "assessment_contradiction",
      title: "Assessment contradicted résumé claim(s)",
      message: `${candidate.basicDetails.name} answered the items probing ${contradicted.length} résumé claim(s) mostly incorrectly for ${candidate.job?.title || "the role"}. Review the evidence — no automatic action was taken.`,
      meta: { candidateId: candidate._id, assessmentSessionId: session._id, claimIds: contradicted.map((v) => v.claimId) },
    }).catch(() => {});
  }

  // Pipeline: assessment_completed, then today's interview mint (A2.3 seam).
  if (candidate && candidate.job && !["rejected", "joined"].includes(candidate.status)) {
    try {
      if (candidate.status === "assessment_scheduled") {
        await applyTransition(candidate, "assessment_completed", { actorName: "system" });
      }
      if (candidate.status === "assessment_completed") {
        await applyTransition(candidate, "interview_scheduled", {
          note: "Assessment completed — AI interview invitation sent",
          actorName: "system",
        });
      }
    } catch (err) {
      console.error("[assessment] pipeline advance after completion failed:", err.message);
    }
  }

  return session;
}

/**
 * A3.2 verdict write-back. Precedence is the evidence hierarchy: an interview
 * verdict is stronger and is NEVER overwritten by an assessment verdict.
 */
async function writeVerdictsToClaimGraph(session, verdicts) {
  const graph = await ClaimGraph.findOne({ candidate: session.candidate, company: session.company }).sort({ createdAt: -1 });
  if (!graph) return 0;
  const byId = new Map(graph.claims.map((c) => [c.id, c]));
  let changed = 0;
  for (const v of verdicts) {
    const claim = byId.get(v.claimId);
    if (!claim) continue;
    if (["verified_in_interview", "contradicted_in_interview"].includes(claim.verificationStatus)) continue;
    if (v.verdict === "verified" && claim.verificationStatus !== "verified_in_assessment") {
      claim.verificationStatus = "verified_in_assessment";
      claim.selfReportedOnly = false;
      changed += 1;
    } else if (v.verdict === "contradicted" && claim.verificationStatus !== "contradicted_in_assessment") {
      claim.verificationStatus = "contradicted_in_assessment";
      changed += 1;
    }
  }
  if (changed > 0) {
    graph.markModified("claims");
    await graph.save();
  }
  return changed;
}

/**
 * A3.3 — post-assessment rescore: the existing pure scorer re-run over the
 * (now verdict-updated) ClaimGraph, persisted as stage "post_assessment".
 * Mirrors probeService.rescoreAfterInterview; zero LLM spend; idempotent per
 * claim-state; the pre document stays bit-untouched.
 */
async function rescoreAfterAssessment(candidate) {
  const pre = await AtsAssessment.findOne({
    candidate: candidate._id,
    company: candidate.company,
    stage: "pre_interview",
    engine: "evidence",
  }).sort({ createdAt: -1 });
  if (!pre) return null;

  const graph = await ClaimGraph.findById(pre.claimGraph);
  const rubric = await RoleRubric.findById(pre.rubric);
  if (!graph || !rubric) return null;

  const claims = graph.claims.map((c) => (c.toObject ? c.toObject() : c));
  const stateHash = claimsStateHash(claims);

  const existingPost = await AtsAssessment.findOne({
    candidate: candidate._id,
    company: candidate.company,
    stage: "post_assessment",
  }).sort({ createdAt: -1 });

  const findings = pre.criterionFindings.map((f) => ({
    criterionId: f.criterionId,
    status: f.status,
    supportingClaimIds: f.supportingClaimIds,
    reasoning: f.reasoning,
    confidence: f.confidence,
  }));
  const computed = computeAssessment({ rubric, claims, findings });

  const violations = checkInvariants({ assessment: computed, rubric, claims, canonicalText: candidate.resumeText || "" });
  if (violations.length > 0) {
    console.error(`[assessment] post-assessment rescore FAILED invariants for candidate ${candidate._id}: ${violations.join(" · ")}`);
    return null;
  }

  const hash = reproducibilityHash({
    rubricId: String(rubric._id),
    rubricVersion: rubric.version,
    resumeHash: pre.resumeHash,
    promptVersions: pre.promptVersions,
    modelId: pre.model,
    claimsStateHash: stateHash,
  });
  if (existingPost && existingPost.reproducibilityHash === hash) return { pre, post: existingPost };

  const post = await AtsAssessment.create({
    candidate: candidate._id,
    job: pre.job,
    company: candidate.company,
    rubric: rubric._id,
    rubricVersion: rubric.version,
    claimGraph: graph._id,
    resumeHash: pre.resumeHash,
    stage: "post_assessment",
    mode: pre.mode,
    thresholds: pre.thresholds,
    overallScore: computed.overallScore,
    band: computed.band,
    decision: computed.decision,
    reviewReason: computed.reviewReason,
    criterionFindings: computed.criterionFindings,
    topEvidence: computed.topEvidence,
    unverifiedHighWeightClaims: computed.unverifiedHighWeightClaims,
    qa: { mode: "off", outcome: "passed", reasons: [], counterfactual: { ran: false } },
    engine: "evidence",
    model: pre.model,
    promptVersions: pre.promptVersions,
    scorerVersion: SCORER_VERSION,
    reproducibilityHash: hash,
    scoredAt: new Date(),
  });
  console.log(`[assessment] post-assessment rescore for candidate ${candidate._id}: ${pre.overallScore} → ${post.overallScore}`);
  return { pre, post };
}

// ---------------------------------------------------------------------------
// A4.2 soft-lock: pause + human ping; only ever pause, fail open
// ---------------------------------------------------------------------------

/** Called after a proctoring flush recomputes counts. Pause-only, opt-in. */
async function maybeSoftLock(session, highSeverityCount) {
  if (!session.softLock?.enabled) return { paused: false, terminated: false };
  if (session.status !== "in_progress") return { paused: false, terminated: false };

  if (session.softLock.action === "auto_submit") {
    // Auto-submit counts only the narrower AUTO_SUBMIT_TRIGGER_TYPES set (strong signals only — see
    // backend/utils/proctoring.js) from the session's cumulative counts, NOT highSeverityCount — that
    // count is the pause branch's own metric and includes second_speaker, deliberately excluded here.
    const counts = session.proctoring?.counts || {};
    const triggerCount = [...proctoring.AUTO_SUBMIT_TRIGGER_TYPES].reduce((sum, t) => sum + (Number(counts[t]) || 0), 0);
    if (triggerCount < (session.softLock.flagThreshold || 3)) return { paused: false, terminated: false };

    const paper = await AssessmentPaper.findById(session.paper);
    for (const state of session.sectionState) {
      if (state.status === "in_progress") await closeSection(session, paper, state, "submit");
    }
    session.softLock.triggeredCount = (session.softLock.triggeredCount || 0) + 1;
    await finalizeSession(session, { completedBy: "integrity_violation" });

    // Fire-and-forget — the session is already ended; nothing about it should wait on a
    // best-effort admin ping (unlike the pause branch below, which is unchanged from before).
    notifyAdmin({
      companyId: session.company,
      type: "assessment_softlock",
      title: "Assessment auto-submitted — integrity violation",
      message: `An assessment was auto-submitted after ${triggerCount} hard integrity flags (camera/identity/device signals). Review it from the assessment tracker — this was scored from whatever was answered before the cutoff.`,
      meta: { assessmentSessionId: session._id, candidateId: session.candidate },
    }).catch(() => {});
    return { paused: false, terminated: true };
  }

  if (highSeverityCount < (session.softLock.flagThreshold || 3)) return { paused: false, terminated: false };

  session.status = "paused";
  session.pause = {
    ...(session.pause?.toObject?.() || session.pause || {}),
    pausedAt: new Date(),
    reason: `soft-lock: ${highSeverityCount} high-severity integrity flags`,
    notifiedAdminAt: new Date(),
  };
  session.softLock.triggeredCount = (session.softLock.triggeredCount || 0) + 1;
  await session.save();
  emitTrackerUpdate(session);

  await notifyAdmin({
    companyId: session.company,
    type: "assessment_softlock",
    title: "Assessment paused — review needed",
    message: `An assessment was paused after ${highSeverityCount} high-severity integrity flags. Resume or end it from the assessment tracker; it auto-resumes in ${Math.round(SOFTLOCK_AUTORESUME_MS() / 60000)} minutes if nobody responds.`,
    meta: { assessmentSessionId: session._id, candidateId: session.candidate },
  }).catch(() => {});
  return { paused: true, terminated: false };
}

/** Resume (human action, or the fail-open auto-resume). Shifts the active
 * section's clock forward by the pause duration so the candidate loses nothing. */
async function resumeFromPause(session, { by, auto = false }) {
  if (session.status !== "paused") return session;
  const pausedAt = session.pause?.pausedAt;
  const pausedMs = pausedAt ? Date.now() - pausedAt.getTime() : 0;
  for (const state of session.sectionState) {
    if (state.status === "in_progress" && state.startedAt) {
      state.startedAt = new Date(state.startedAt.getTime() + pausedMs);
    }
  }
  session.markModified("sectionState");
  session.pause.pausedMsTotal = (session.pause.pausedMsTotal || 0) + pausedMs;
  session.pause.pausedAt = undefined;
  session.pause.reason = auto ? "auto-resumed (no reviewer response — fail open)" : `resumed by ${by}`;
  session.status = "in_progress";
  await session.save();
  emitTrackerUpdate(session);
  return session;
}

module.exports = {
  claimLoopEnabled,
  hashToken,
  buildAssessmentUrl,
  liveSessionFor,
  sendAssessment,
  skipAssessment,
  autoAssignAfterAtsPass,
  resendAssessment,
  loginWithToken,
  openSession,
  dashboardPayload,
  itemsPayload,
  startAssessment,
  startSection,
  saveResponse,
  submitSection,
  submitAssessment,
  finalizeSession,
  expireSession,
  rescoreAfterAssessment,
  maybeSoftLock,
  resumeFromPause,
  remainingSecFor,
};
