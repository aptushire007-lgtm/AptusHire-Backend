// RoundScorecard orchestration: mint → open (blind) → submit → write back.
//
// The one-paragraph version of why this service exists: the platform's machine
// judgements are cited, reproducible, and auditable, while its HUMAN judgements —
// the three interview rounds that actually decide the hire — recorded nothing at
// all. This closes that gap without asking a hiring manager to change how they
// run an interview.
//
// Non-obvious behaviours, all deliberate:
//   - `createScorecard` captures the engine's score AT MINT TIME and never sends
//     it to the panelist until they submit. That is the blind-first guarantee; it
//     lives here rather than in the UI because a client-side "don't peek" is not
//     a guarantee, it is a suggestion.
//   - Submitting NEVER moves the candidate's pipeline stage. One panelist's
//     "advance" is a recommendation from one person; the recruiter still acts.
//     Auto-advancing on a single scorecard would make the multi-interviewer
//     design meaningless and would hand an adverse action to an automated path.
//   - Verdict write-back respects `scorecardEngine.outranks`. Two humans landing
//     on the same claim do NOT overwrite each other — the second one raises a
//     contradiction alert and a person reconciles it (rule 4).

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const RoundScorecard = require("../models/RoundScorecard");
const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const RoleRubric = require("../models/RoleRubric");
const ClaimGraph = require("../models/ClaimGraph");
const AtsAssessment = require("../models/AtsAssessment");
const AuditLog = require("../models/AuditLog");
const { hashToken } = require("../utils/authTokens");
const { notifyAdmin } = require("./notificationService");
const { dispatchEmail } = require("./emailDispatchService");
const templates = require("../utils/emailTemplates");
const { STAGE_LABELS } = require("../utils/pipeline");
const engine = require("../utils/scorecardEngine");

const VALIDITY_HOURS = Number(process.env.SCORECARD_VALIDITY_HOURS) || 72;
// A human/engine gap this wide is worth a person's attention — either the engine
// is miscalibrated for this role or the interview surfaced something the résumé
// could not. Both are findings; neither is noise to be averaged away.
const DISAGREEMENT_ALERT_POINTS = Number(process.env.SCORECARD_DISAGREEMENT_ALERT) || 25;

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

// The panelist form lives in the candidate app alongside the other token-based
// portals — it is the app already built for "no account, the link is your
// identity". Nothing about it is candidate-facing beyond that shared shape.
function buildScorecardUrl(token) {
  const base = String(process.env.CLIENT_ORIGIN_USER || "http://localhost:5174").split(",")[0].trim().replace(/\/$/, "");
  return `${base}/scorecard/${token}`;
}

function signPortalToken(scorecard) {
  const expiresInSeconds = Math.max(60, Math.floor((scorecard.expiresAt.getTime() - Date.now()) / 1000));
  return jwt.sign(
    { scorecardId: String(scorecard._id), email: scorecard.interviewer.email },
    process.env.JWT_SECRET,
    { expiresIn: expiresInSeconds, audience: "scorecard" }
  );
}

/** Short human-readable rendering of a claim, for the panelist's probe list. */
function summariseClaim(claim) {
  return [claim.subject, claim.predicate, claim.object].filter(Boolean).join(" ").trim() || claim.id;
}

/**
 * The probe list for THIS round: high-weight claims the pipeline still cannot
 * prove, computed when the scorecard opens rather than pre-chained. Rounds may
 * legitimately run in any order (pipeline.js allows lateral moves inside
 * ROUND_STAGES) and two may be open at once, so "what is still unverified" is a
 * question that can only be answered at open time.
 */
function buildTargetClaims({ assessment, graph, rubric }) {
  if (!assessment || !graph) return [];
  const claimsById = new Map((graph.claims || []).map((c) => [c.id, c]));
  const criteriaById = new Map((rubric?.criteria || []).map((c) => [c.id, c]));
  const settled = new Set(["verified_in_assessment", "verified_in_interview", "verified_by_human"]);

  const out = [];
  for (const target of assessment.unverifiedHighWeightClaims || []) {
    const claim = claimsById.get(target.claimId);
    if (!claim || settled.has(claim.verificationStatus)) continue;
    const criterion = criteriaById.get(target.criterionId);
    out.push({
      claimId: claim.id,
      criterionId: target.criterionId,
      summary: summariseClaim(claim),
      probeHint: criterion?.probeHint || "",
    });
  }
  return out;
}

/**
 * Mint a scorecard for one interviewer on one round. Returns the raw link token
 * alongside the document — the ONLY time it exists in plaintext; the model stores
 * a hash.
 */
async function createScorecard({ candidateId, companyId, stage, interviewer, invitedBy }) {
  const candidate = await Candidate.findOne({ _id: candidateId, company: companyId });
  if (!candidate) throw httpError(404, "Candidate not found");

  const name = String(interviewer?.name || "").trim();
  const email = String(interviewer?.email || "").trim().toLowerCase();
  if (!name || !email) throw httpError(400, "The interviewer's name and email are required — every observation carries a person");

  const job = await Job.findOne({ _id: candidate.job, company: companyId });
  if (!job) throw httpError(409, "The candidate's job no longer exists");

  // Rubric-bound by construction: no approved rubric ⇒ no scorecard. A generic
  // competency grid is exactly what this feature exists to avoid shipping.
  const rubric = await RoleRubric.findOne({ job: job._id, company: companyId, status: "approved" }).sort({ version: -1 });
  if (!rubric) {
    throw httpError(
      409,
      "This job has no approved rubric yet — approve one first so the scorecard is scored against this role's criteria rather than a generic checklist",
      "NO_APPROVED_RUBRIC"
    );
  }

  const existing = await RoundScorecard.findOne({ company: companyId, candidate: candidate._id, stage, "interviewer.email": email, status: "open" });
  if (existing) throw httpError(409, `${name} already has an open scorecard for this round — resend that link instead of minting a second`, "SCORECARD_EXISTS");

  const assessment = await AtsAssessment.findOne({ candidate: candidate._id, company: companyId }).sort({ createdAt: -1 });
  const graph = assessment?.claimGraph
    ? await ClaimGraph.findById(assessment.claimGraph)
    : await ClaimGraph.findOne({ candidate: candidate._id, company: companyId }).sort({ createdAt: -1 });

  const token = crypto.randomBytes(32).toString("hex");
  const scorecard = await RoundScorecard.create({
    candidate: candidate._id,
    job: job._id,
    company: companyId,
    stage,
    rubric: rubric._id,
    rubricVersion: rubric.version,
    interviewer: { user: interviewer.userId || undefined, name, email },
    invitedBy: { user: invitedBy?.user, name: invitedBy?.name || "", at: new Date() },
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + VALIDITY_HOURS * 60 * 60 * 1000),
    targetClaims: buildTargetClaims({ assessment, graph, rubric }),
    // Blind-first: pinned now, withheld until submit.
    engineSnapshot: assessment
      ? { score: assessment.overallScore, band: assessment.band, capturedAt: new Date() }
      : { score: null, band: "", capturedAt: new Date() },
  });

  return { scorecard, token, candidate, job, rubric };
}

/**
 * Email the panelist their link. Goes through dispatchEmail (not mailer) so the
 * EmailLog audit row and the BullMQ retry path apply exactly as they do to every
 * other outbound mail.
 */
async function sendInvite({ scorecard, token, candidate, job, reminder = false }) {
  const args = {
    interviewerName: scorecard.interviewer.name,
    candidateName: candidate?.basicDetails?.name || "the candidate",
    jobTitle: job?.title || "",
    stageLabel: STAGE_LABELS[scorecard.stage] || scorecard.stage,
    scorecardUrl: buildScorecardUrl(token),
    expiresAt: scorecard.expiresAt,
    targetCount: (scorecard.targetClaims || []).length,
  };
  const built = reminder ? templates.scorecardReminderEmailTemplate(args) : templates.scorecardInviteEmailTemplate(args);
  return dispatchEmail({
    to: scorecard.interviewer.email,
    subject: built.subject,
    text: built.text,
    html: built.html,
    category: reminder ? "scorecard_reminder" : "scorecard_invite",
    relatedType: "RoundScorecard",
    relatedId: String(scorecard._id),
    company: scorecard.company,
  });
}

/**
 * Re-send with token ROTATION (the assessment-resend pattern): the old link dies
 * the moment a new one is issued, so a forwarded or leaked link cannot be used
 * after the recruiter has re-sent.
 */
async function resendInvite({ scorecardId, companyId }) {
  const scorecard = await RoundScorecard.findOne({ _id: scorecardId, company: companyId });
  if (!scorecard) throw httpError(404, "Scorecard not found");
  if (scorecard.status !== "open") throw httpError(409, "Only an open scorecard can be re-sent");

  const token = crypto.randomBytes(32).toString("hex");
  scorecard.tokenHash = hashToken(token);
  scorecard.expiresAt = new Date(Date.now() + VALIDITY_HOURS * 60 * 60 * 1000);
  await scorecard.save();

  const candidate = await Candidate.findById(scorecard.candidate);
  const job = await Job.findById(scorecard.job);
  await sendInvite({ scorecard, token, candidate, job });
  return scorecard;
}

/** Withdraw an open scorecard (candidate rejected, round cancelled, wrong panelist). */
async function cancelScorecard({ scorecardId, companyId }) {
  const scorecard = await RoundScorecard.findOne({ _id: scorecardId, company: companyId });
  if (!scorecard) throw httpError(404, "Scorecard not found");
  if (scorecard.status === "submitted") {
    throw httpError(409, "A submitted scorecard is a record of what someone observed — it cannot be withdrawn");
  }
  scorecard.status = "cancelled";
  await scorecard.save();
  return scorecard;
}

async function loginWithToken(token) {
  const scorecard = await RoundScorecard.findOne({ tokenHash: hashToken(token) });
  if (!scorecard) throw httpError(404, "Invalid scorecard link");
  if (scorecard.status === "cancelled") throw httpError(410, "This scorecard was withdrawn by the recruiting team");
  if (scorecard.status === "submitted") throw httpError(409, "You have already submitted this scorecard");
  if (new Date() > scorecard.expiresAt) throw httpError(410, "This scorecard link has expired — ask the recruiting team to re-send it");

  if (!scorecard.openedAt) {
    scorecard.openedAt = new Date();
    await scorecard.save();
  }
  return { token: signPortalToken(scorecard), scorecard };
}

/**
 * The panelist-facing payload. ALLOW-LIST ONLY, and structurally blind: the
 * engine's score and band are not read here at all, so they cannot leak into the
 * form that is supposed to be filled without them. A serializer test asserts it.
 */
function panelistPayload({ scorecard, candidate, job, rubric }) {
  return {
    stage: scorecard.stage,
    status: scorecard.status,
    expiresAt: scorecard.expiresAt,
    interviewer: { name: scorecard.interviewer.name },
    candidate: {
      name: candidate?.basicDetails?.name || "",
      // Deliberately minimal: a panelist needs to know who they are talking to,
      // not the candidate's contact details or application history.
      appliedFor: job?.title || "",
    },
    job: { title: job?.title || "", department: job?.department || "" },
    rubricVersion: scorecard.rubricVersion,
    ratingLabels: engine.RATING_LABELS,
    criteria: engine.ratableCriteria(rubric).map((c) => ({
      id: c.id,
      label: c.label,
      kind: c.kind,
      rationale: c.rationale,
      acceptableEvidence: c.acceptableEvidence || [],
      probeHint: c.probeHint || "",
      // The claims this round is being asked to test, attached to their criterion
      // so the form reads as "here is what to probe", not "here is a grid".
      targetClaims: (scorecard.targetClaims || [])
        .filter((t) => t.criterionId === c.id)
        .map((t) => ({ claimId: t.claimId, summary: t.summary, probeHint: t.probeHint })),
    })),
    decisions: engine.DECISIONS,
  };
}

/**
 * Apply this scorecard's claim verdicts to the ClaimGraph. Precedence comes from
 * `engine.outranks`, so a machine verdict never beats a human one and — crucially
 * — a SECOND human never silently overwrites the first. Returns the applied and
 * conflicting sets; the conflicts are what the recruiter gets alerted about.
 */
async function writeVerdictsToClaimGraph(scorecard, writeBacks) {
  if (!writeBacks.length) return { applied: 0, conflicts: [] };
  const graph = await ClaimGraph.findOne({ candidate: scorecard.candidate, company: scorecard.company }).sort({ createdAt: -1 });
  if (!graph) return { applied: 0, conflicts: [] };

  const byId = new Map(graph.claims.map((c) => [c.id, c]));
  let applied = 0;
  const conflicts = [];

  for (const wb of writeBacks) {
    const claim = byId.get(wb.claimId);
    if (!claim) continue;
    if (engine.outranks(claim.verificationStatus, wb.status)) {
      claim.verificationStatus = wb.status;
      if (wb.status === "verified_by_human") claim.selfReportedOnly = false;
      applied += 1;
    } else if (claim.verificationStatus !== wb.status) {
      // Equal or higher rank and a DIFFERENT verdict: two humans (or a human and
      // a live interview) reached opposite conclusions on the same claim. Record
      // it for a person; never average, never last-write-wins.
      conflicts.push({ claimId: wb.claimId, existing: claim.verificationStatus, incoming: wb.status });
    }
  }

  if (applied > 0) {
    graph.markModified("claims");
    await graph.save();
  }
  return { applied, conflicts };
}

/**
 * Submit one interviewer's observations. Validates, computes (in code), writes
 * back, reveals the engine delta, and alerts a human where the rules say to.
 * The document becomes immutable on save.
 */
async function submitScorecard(scorecard, { ratings, decision, decisionReason }, req) {
  if (scorecard.status !== "open") throw httpError(409, "This scorecard is no longer open");

  const rubric = await RoleRubric.findById(scorecard.rubric);
  if (!rubric) throw httpError(409, "The rubric this scorecard was opened against no longer exists");

  const { errors, rows } = engine.validateSubmission({ rubric, ratings, decision, decisionReason });
  if (errors.length) throw httpError(400, errors.join(" · "), "SCORECARD_INVALID");

  const rollup = engine.computeRollup({ rubric, rows });
  const reproducibilityHash = engine.reproducibilityHash({ rubricVersion: scorecard.rubricVersion, rows, rollup });

  const writeBacks = engine.claimWriteBacks(rows);
  const { applied, conflicts } = await writeVerdictsToClaimGraph(scorecard, writeBacks);

  const disagreement = engine.computeDisagreement({
    engineScore: scorecard.engineSnapshot?.score ?? null,
    humanScore: rollup.score,
  });

  scorecard.ratings = rows;
  scorecard.rollup = { ...rollup, reproducibilityHash };
  scorecard.disagreement = disagreement;
  scorecard.decision = decision;
  scorecard.decisionReason = String(decisionReason || "").trim();
  scorecard.revealedAt = new Date();
  scorecard.submittedAt = new Date();
  scorecard.status = "submitted";
  await scorecard.save();

  await AuditLog.create({
    company: scorecard.company,
    actorUserId: scorecard.interviewer.user,
    actorEmail: scorecard.interviewer.email,
    actorRole: "interviewer",
    action: "scorecard.submit",
    resourceType: "RoundScorecard",
    resourceId: String(scorecard._id),
    ip: req?.ip,
    userAgent: req?.headers?.["user-agent"],
    meta: {
      stage: scorecard.stage,
      decision,
      score: rollup.score,
      coverage: rollup.coverage,
      claimsWritten: applied,
      conflicts: conflicts.length,
      reproducibilityHash,
    },
  });

  await dispatchAlerts(scorecard, { rows, conflicts, disagreement });
  return scorecard;
}

// The alert types this service can dispatch. Declared as a table rather than
// left inline because `send()` below passes `type` as a variable, which is
// invisible to the static scan in notificationTypes.test.js — and an enum miss
// on these is not a dropped nicety, it is the alert that was supposed to pull a
// human in. The table is asserted against the AdminNotification enum directly.
const ALERT_TYPES = {
  submitted: "scorecard_submitted",
  contradiction: "scorecard_contradiction",
  disagreement: "scorecard_disagreement",
};

/** The three human-routing signals a submitted scorecard can raise. */
async function dispatchAlerts(scorecard, { rows, conflicts, disagreement }) {
  const contradicted = rows.flatMap((r) => r.claimVerdicts.filter((v) => v.verdict === "contradicted"));
  const label = scorecard.stage.replace(/_/g, " ");

  const send = (type, title, message, meta) =>
    notifyAdmin({ companyId: scorecard.company, type, title, message, meta }).catch((err) =>
      console.error(`[scorecard] ${type} notification failed:`, err.message)
    );

  await send(
    ALERT_TYPES.submitted,
    `Scorecard submitted — ${label}`,
    `${scorecard.interviewer.name} submitted a ${label} scorecard with a recommendation to ${scorecard.decision}.`,
    { scorecardId: String(scorecard._id), candidateId: String(scorecard.candidate), stage: scorecard.stage, decision: scorecard.decision }
  );

  if (contradicted.length || conflicts.length) {
    await send(
      ALERT_TYPES.contradiction,
      `Claim contradicted in ${label}`,
      conflicts.length
        ? `${scorecard.interviewer.name} reached a different conclusion than an earlier round on ${conflicts.length} claim(s). Nothing was overwritten — a person needs to reconcile this.`
        : `${scorecard.interviewer.name} disproved ${contradicted.length} claim(s) the résumé asserted.`,
      { scorecardId: String(scorecard._id), candidateId: String(scorecard.candidate), contradicted: contradicted.map((c) => c.claimId), conflicts }
    );
  }

  if (disagreement.delta !== null && Math.abs(disagreement.delta) >= DISAGREEMENT_ALERT_POINTS) {
    await send(
      ALERT_TYPES.disagreement,
      `Interviewer and engine disagree — ${label}`,
      `${scorecard.interviewer.name} scored this candidate ${Math.abs(disagreement.delta)} points ${
        disagreement.direction === "human_higher" ? "higher" : "lower"
      } than the engine. Worth a look: either the engine is miscalibrated for this role, or the interview surfaced something the résumé could not.`,
      { scorecardId: String(scorecard._id), candidateId: String(scorecard.candidate), ...disagreement }
    );
  }
}

/**
 * The Evidence Ledger: every rubric criterion for this candidate, down the left,
 * with what each round established across the top. This is the artifact the
 * whole feature exists to produce — one view where a machine verdict and a human
 * verdict sit side by side in the same vocabulary, each naming its evidence.
 */
async function ledgerForCandidate({ candidateId, companyId }) {
  const candidate = await Candidate.findOne({ _id: candidateId, company: companyId });
  if (!candidate) throw httpError(404, "Candidate not found");

  const assessment = await AtsAssessment.findOne({ candidate: candidateId, company: companyId }).sort({ createdAt: -1 });
  const rubric = assessment?.rubric
    ? await RoleRubric.findById(assessment.rubric)
    : await RoleRubric.findOne({ job: candidate.job, company: companyId, status: "approved" }).sort({ version: -1 });
  if (!rubric) return { available: false, reason: "This job has no approved rubric, so there is nothing to build a ledger against.", rounds: [], criteria: [] };

  const scorecards = await RoundScorecard.find({ candidate: candidateId, company: companyId, status: "submitted" }).sort({ submittedAt: 1 });

  const rounds = scorecards.map((s) => ({
    id: String(s._id),
    stage: s.stage,
    interviewer: s.interviewer.name,
    submittedAt: s.submittedAt,
    decision: s.decision,
    score: s.rollup?.score ?? null,
    withheldReason: s.rollup?.withheldReason || "",
    coverage: s.rollup?.coverage ?? 0,
    disagreement: s.disagreement,
    reproducibilityHash: s.rollup?.reproducibilityHash || "",
  }));

  const criteria = engine.ratableCriteria(rubric).map((c) => ({
    criterionId: c.id,
    label: c.label,
    kind: c.kind,
    weight: c.weight,
    cells: scorecards.map((s) => {
      const row = (s.ratings || []).find((r) => r.criterionId === c.id);
      return {
        roundId: String(s._id),
        // A round that did not assess a criterion renders as "not assessed",
        // never as a blank that reads like a zero (rule 5).
        assessed: Boolean(row && !row.notAssessed),
        rating: row && !row.notAssessed ? row.rating : null,
        note: row?.note || "",
        claimVerdicts: row?.claimVerdicts || [],
      };
    }),
  }));

  return { available: true, rubricVersion: rubric.version, rounds, criteria };
}

module.exports = {
  VALIDITY_HOURS,
  DISAGREEMENT_ALERT_POINTS,
  ALERT_TYPES,
  createScorecard,
  sendInvite,
  resendInvite,
  cancelScorecard,
  buildScorecardUrl,
  loginWithToken,
  panelistPayload,
  buildTargetClaims,
  writeVerdictsToClaimGraph,
  submitScorecard,
  ledgerForCandidate,
};
