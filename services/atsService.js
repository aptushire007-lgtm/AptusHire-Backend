// ATS orchestration. Three engine modes (BUILD-PLAN Phase 6.5), selected per
// tenant (CompanySettings.ai.atsEngine) with ATS_ENGINE as the fleet default:
//
//   legacy — deterministic keyword engine only (today's behaviour).
//   shadow — behave on legacy; ALSO run the evidence engine and persist its
//            assessment for comparison. Divergences are counted, behaviour
//            never changes. This is the mandatory soak before "live".
//   live   — the evidence engine drives the decision; legacy remains the
//            LABELLED fallback for any failure (engine: "fallback-legacy").
//
// Regardless of engine: the review band routes to the human queue and NEVER
// auto-rejects — auto-reject stays opt-in and applies only to explicit fails.

const crypto = require("crypto");
const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const InterviewQueue = require("../models/InterviewQueue");
const User = require("../models/User");
const CompanySettings = require("../models/CompanySettings");
const ReviewItem = require("../models/ReviewItem");
const storageService = require("./storageService");
const extractResumeText = require("../utils/extractResumeText");
const { detectFileType } = require("../utils/verifyFileSignature");
const { computeAtsScore } = require("../utils/atsEngine");
const { createInterviewSessionIfNeeded } = require("./interviewInvitationService");
const { notifyAdmin, notifyCandidate } = require("./notificationService");
const { appendStageHistory } = require("../utils/pipeline");
const resumeDefenseService = require("./resumeDefenseService");
const evidenceAtsService = require("./evidenceAtsService");
const llm = require("./llmService");
const metrics = require("../utils/metrics");
const { getScreeningQueue } = require("../queues/screeningQueue");
const { getRescoreQueue } = require("../queues/rescoreQueue");
const { runInBackground } = require("../utils/backgroundTasks");

const QUEUE_JOB_OPTS = { attempts: 3, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: 100, removeOnFail: 500 };

metrics.registerMetric("ats_shadow_divergence_total", "counter", "Shadow runs where evidence and legacy disagree");

function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

const EMPTY_INGEST = { text: "", blocks: [], artifacts: { invisibleChars: 0, controlChars: 0 }, status: "failed" };

async function getResumeIngest(candidate) {
  let buffer;
  try {
    buffer = await storageService.getObjectBuffer(candidate.resumePath);
  } catch (err) {
    console.error("Could not read resume file for ATS scoring:", err.message);
    return EMPTY_INGEST;
  }

  let mimeType = detectFileType(buffer);
  if (!mimeType) {
    // Legacy .doc uploads (pre-dating magic-byte detection) aren't a supported
    // extraction format; fall back to extension so scoring still runs on
    // structured fields even though resume text will be empty.
    return EMPTY_INGEST;
  }

  return extractResumeText(buffer, mimeType);
}

// The ATS-pass side effects, shared with the review queue's "advance"
// resolution so a human decision produces exactly the machine-pass pathway.
//
// The recruiter gate (ASSESSMENT-ENGINE-PLAN A2.3): when the job runs
// `assessmentPolicy: manual`, an ATS pass PARKS the candidate at ats_passed —
// the recruiter decides "Send assessment" or "Skip to AI interview" from the
// awaiting-decision queue. `auto` (drives) assigns the assessment immediately.
// `off` (the default for every existing job) is byte-identical to before.
// The gate predicate, exported for tests. Deliberately a function of policy
// alone: paper readiness, quota, or any other system state must never appear
// here — "not ready" degrades the recruiter's options inside the gate, it never
// bypasses the recruiter.
function assessmentGateEngages(engineOn, assessmentPolicy) {
  return Boolean(engineOn) && ["manual", "auto"].includes(assessmentPolicy);
}

async function advanceAfterAtsPass(candidate, job, score) {
  const assessmentPaperService = require("./assessmentPaperService");
  // The gate engages on POLICY, never on system readiness. Requiring an
  // approved paper here let candidates fall through to an instant interview
  // link whenever the paper wasn't ready yet — a race deciding what the
  // recruiter explicitly reserved for themselves. With no paper approved the
  // candidate parks in the awaiting-decision queue: Skip works immediately,
  // Send starts working the moment a paper is approved.
  const gateActive = assessmentGateEngages(assessmentPaperService.engineEnabled(), job.assessmentPolicy);

  if (gateActive) {
    const paperReady = !!(await assessmentPaperService.getActivePaper(job._id, job.company));
    if (candidate.status === "applied") {
      appendStageHistory(candidate, "ats_passed");
      candidate.status = "ats_passed";
      await candidate.save();
    }
    if (job.assessmentPolicy === "auto" && paperReady) {
      try {
        await require("./assessmentService").autoAssignAfterAtsPass(candidate, job);
      } catch (err) {
        // Fail open to the awaiting-decision queue: a candidate must never be
        // lost because auto-assignment hiccuped.
        console.error(`[ats] auto assessment assignment failed for candidate ${candidate._id}: ${err.message}`);
        await notifyAwaitingDecision(candidate, job, { paperReady });
      }
    } else {
      // `auto` with no approved paper degrades to the same queue: the recruiter
      // delegated the send, not the decision to bypass the assessment.
      await notifyAwaitingDecision(candidate, job, { paperReady });
    }
    return;
  }

  if (candidate.status === "applied") {
    appendStageHistory(candidate, "ats_passed");
    candidate.status = "interview_scheduled";
    appendStageHistory(candidate, "interview_scheduled");
  }
  await InterviewQueue.findOneAndUpdate(
    { candidate: candidate._id },
    { candidate: candidate._id, job: job._id, company: job.company, atsScore: score, status: "queued" },
    { upsert: true, new: true }
  );
  await createInterviewSessionIfNeeded(candidate, job);
}

async function notifyAwaitingDecision(candidate, job, { paperReady = true } = {}) {
  try {
    await notifyAdmin({
      companyId: job.company,
      type: "assessment_decision_needed",
      title: "Candidate awaiting your decision",
      message: paperReady
        ? `${candidate.basicDetails.name} passed screening for ${job.title}. Send the skills assessment, or skip straight to the AI interview.`
        : `${candidate.basicDetails.name} passed screening for ${job.title}. No approved assessment paper exists yet — approve one to send the assessment, or skip straight to the AI interview.`,
      meta: { candidateId: candidate._id, jobId: job._id },
    });
  } catch (err) {
    console.error("[ats] awaiting-decision notification failed:", err.message);
  }
}

// A shadow copy of the candidate with every field they accepted VERBATIM from
// autofill removed, for the counterfactual score. Edited suggestions stay: an
// edit is the candidate's own act, and the resulting entry is theirs. Only the
// shape atsEngine reads is rebuilt — this object is never persisted.
function withoutAcceptedSuggestions(candidate) {
  const typed = (entry) => entry?.provenance?.source !== "autofill_accepted";
  const acceptedSkills = new Set(
    (candidate.skillProvenance || [])
      .filter((s) => s.source === "autofill_accepted")
      .map((s) => String(s.value).trim().toLowerCase())
  );
  return {
    experience: (candidate.experience || []).filter(typed),
    education: (candidate.education || []).filter(typed),
    projects: (candidate.projects || []).filter(typed),
    certificates: (candidate.certificates || []).filter(typed),
    skills: (candidate.skills || []).filter((s) => !acceptedSkills.has(String(s).trim().toLowerCase())),
  };
}

async function openReviewItem(candidate, job, assessment, reasons, summary) {
  try {
    await ReviewItem.findOneAndUpdate(
      { company: job.company, candidate: candidate._id, status: "open" },
      {
        $setOnInsert: { candidate: candidate._id, job: job._id, company: job.company, status: "open" },
        $set: {
          assessment: assessment?._id,
          reasons,
          summary,
          label: assessment
            ? { engineScore: assessment.overallScore, engineBand: assessment.band }
            : undefined,
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("Could not open review item:", err.message);
  }
}

async function runAtsForCandidate(candidate, job) {
  const ingest = await getResumeIngest(candidate);
  const resumeText = ingest.text;
  candidate.resumeText = resumeText;
  candidate.resumeHash = resumeText ? sha256(resumeText) : "";

  // A resume that produced no readable text means every text-based component
  // scores blind. That must never be silent: the admin is told the score below
  // is form-fields-only, instead of a legitimate candidate quietly bottoming
  // out with no signal to anyone.
  if (!resumeText) {
    await notifyAdmin({
      companyId: job.company,
      type: "system_alert",
      title: "Resume could not be read",
      message:
        `No text could be extracted from ${candidate.basicDetails.name}'s resume ` +
        `(${candidate.resumeOriginalName || "file"}). Their screening score is based on the application form only — ` +
        `consider asking them to re-upload a PDF or DOCX before acting on it.`,
      meta: { candidateId: candidate._id, jobId: job._id, ingestStatus: ingest.status },
    }).catch((err) => console.error("Could not send resume-extraction alert:", err.message));
  }

  // Phase 4: every résumé is treated as hostile input. The report FLAGS, it
  // never decides — nothing below branches on it, it is surfaced to the admin.
  candidate.hostility = resumeDefenseService.analyze(ingest);

  const legacyResult = computeAtsScore(job, candidate, resumeText);

  // How much of this score rests on suggestions the candidate accepted verbatim
  // rather than wrote. Four of the six deterministic components (experience,
  // education, projects, certifications) read ONLY the structured form fields —
  // they do not fall back to the résumé text — so a candidate who used autofill
  // arrives with those populated where an identical candidate who typed nothing
  // arrives with zeros. That completeness bias predates autofill and belongs to
  // the evidence engine to fix properly; what we will not do is let autofill
  // amplify it INVISIBLY. The delta is recorded, never subtracted: the candidate
  // attested to the fields, so they are legitimately theirs — but a recruiter
  // and an auditor can both now see the dependency instead of inferring it.
  if (candidate.autofill?.used) {
    try {
      candidate.autofill.scoreDelta =
        legacyResult.overallScore - computeAtsScore(job, withoutAcceptedSuggestions(candidate), resumeText).overallScore;
    } catch (err) {
      console.warn(`[ats] could not compute autofill score delta for candidate ${candidate._id}: ${err.message}`);
    }
  }

  const settings = await CompanySettings.findOne({ company: job.company }).select("compliance ai");
  const engineMode = evidenceAtsService.resolveEngineMode(settings);

  let effective = { ...legacyResult, engine: "legacy" };
  let assessment = null;

  if (engineMode === "shadow" || engineMode === "live") {
    try {
      assessment = await evidenceAtsService.runEvidenceAssessment(candidate, job, {
        mode: engineMode === "live" ? "live" : "shadow",
      });

      if (engineMode === "live") {
        effective = {
          ...legacyResult, // legacy component fields stay for old screens
          overallScore: assessment.overallScore,
          threshold: assessment.thresholds?.advance ?? legacyResult.threshold,
          decision: assessment.decision, // pass | review | fail
          scoredAt: assessment.scoredAt,
          engine: "evidence",
        };
      } else {
        // Shadow soak: count decision-level divergence, change nothing.
        const legacyPass = legacyResult.decision === "pass";
        const evidencePass = assessment.decision === "pass";
        if (legacyPass !== evidencePass || assessment.decision === "review") {
          metrics.incCounter("ats_shadow_divergence_total", {
            legacy: legacyResult.decision,
            evidence: assessment.decision,
          });
        }
      }
    } catch (err) {
      if (err.code === "INVARIANT_VIOLATION") {
        // Pipeline unsound: hard fallback + page an operator. This is an
        // engineering incident, never a candidate outcome.
        console.error(`[ats] INVARIANT VIOLATION for candidate ${candidate._id}: ${err.message}`);
        await notifyAdmin({
          companyId: job.company,
          type: "system_alert",
          title: "Evidence engine invariant violation — legacy engine used",
          message:
            `Scoring pipeline failed an internal soundness check for ${candidate.basicDetails.name} and fell back to the ` +
            `deterministic engine. Engineering has been signalled; no automated decision was made by the broken path.`,
          meta: { candidateId: candidate._id, jobId: job._id, violations: err.violations || [] },
        });
      } else if (err.code !== "NO_APPROVED_RUBRIC" && err.code !== "CLAIM_ENGINE_DISABLED") {
        console.warn(`[ats] evidence engine unavailable for candidate ${candidate._id} (${err.code || err.message}); using legacy`);
        // Rule 5: a degraded path must be visible where it surfaces. In LIVE mode
        // this is a tenant who bought evidence scoring, approved a rubric, and is
        // silently being served keyword scores — previously only a console.warn,
        // which is how it ran unnoticed on every application. The recruiter is
        // told, and told that Rescore is the retry.
        if (engineMode === "live") {
          await notifyAdmin({
            companyId: job.company,
            type: "system_alert",
            title: "Evidence scoring failed — keyword fallback used",
            message:
              `${candidate.basicDetails.name}'s screening for ${job.title} could not run the evidence engine ` +
              `— ${llm.describeFailure(err)} — so the score shown is the legacy keyword match, NOT rubric-based. ` +
              `Use "Rescore" on the candidate to retry once the cause is cleared.`,
            meta: { candidateId: candidate._id, jobId: job._id, reason: err.code || err.message },
          }).catch((e) => console.error("Could not send evidence-fallback alert:", e.message));
        }
      }
      if (engineMode === "live") effective = { ...legacyResult, engine: "fallback-legacy" };
    }
  }

  candidate.ats = effective;

  let reviewNeeded = false;

  if (effective.decision === "pass") {
    // Guarded on "applied" so an ATS rerun on an already advanced candidate
    // doesn't re-stamp the timeline. ATS sends its own notifications, so this
    // does not route through pipelineService (which would double-notify).
    await advanceAfterAtsPass(candidate, job, effective.overallScore);
  } else if (effective.decision === "review") {
    // The honest middle band: a human decides. Never auto-rejected, regardless
    // of tenant settings.
    reviewNeeded = true;
    await openReviewItem(
      candidate,
      job,
      assessment,
      [assessment?.reviewReason || "score_in_review_band", ...(assessment?.qa?.reasons || [])],
      `Score ${effective.overallScore} landed in the review band for ${job.title}.`
    );
  } else {
    // Automated rejection is a fair-hiring / legal-exposure decision. Only auto-reject
    // (and email the candidate) when the tenant has explicitly opted in; otherwise keep
    // a human in the loop — leave the candidate in place and flag it for admin review.
    const autoReject = settings?.compliance?.autoRejectAllowed === true;

    if (autoReject) {
      if (candidate.status !== "rejected") {
        appendStageHistory(candidate, "rejected", { note: `ATS score ${effective.overallScore} below threshold (auto-reject)` });
      }
      candidate.status = "rejected";
      const applicantUser = await User.findOne({ email: candidate.basicDetails.email, role: "candidate" });
      await notifyCandidate({
        candidateId: candidate._id,
        userId: applicantUser?._id,
        type: "rejection",
        title: "Application update",
        message: `Thank you for applying for ${job.title}. We will not be moving forward at this time.`,
        meta: { jobId: job._id },
        email: { to: candidate.basicDetails.email, template: "rejectionEmailTemplate", args: [candidate, job] },
      });
    } else {
      // Human-in-the-loop: no status change, no candidate email — the admin decides.
      // A fail is exactly as invisible as a review-band score if it only fires a
      // notification (easy to miss in a bell icon); it gets the same Review Queue
      // treatment so every non-pass outcome the system won't auto-act on lands in
      // one visible place, not scattered between a queue and a notification list.
      reviewNeeded = true;
      await openReviewItem(
        candidate,
        job,
        assessment,
        [assessment?.reviewReason || "score_below_threshold", ...(assessment?.qa?.reasons || [])],
        `Score ${effective.overallScore} was below threshold for ${job.title} — auto-reject is off, a human decides.`
      );
    }
  }

  await notifyAdmin({
    companyId: job.company,
    type: "ats_completed",
    title: reviewNeeded
      ? effective.decision === "review"
        ? "ATS routed a candidate to human review"
        : "ATS below threshold — needs review"
      : "ATS screening completed",
    message: reviewNeeded
      ? effective.decision === "review"
        ? `${candidate.basicDetails.name}'s screening for ${job.title} scored ${effective.overallScore} — in the review band. Please decide in the review queue.`
        : `${candidate.basicDetails.name}'s ATS score for ${job.title} was ${effective.overallScore} (below threshold). Auto-reject is off — please review and decide.`
      : `${candidate.basicDetails.name}'s ATS screening for ${job.title} completed with a score of ${effective.overallScore} (${effective.decision}).`,
    meta: {
      candidateId: candidate._id,
      jobId: job._id,
      score: effective.overallScore,
      decision: effective.decision,
      reviewNeeded,
      engine: effective.engine,
    },
  });

  await candidate.save();
  if (candidate.status === "rejected") {
    await require("./candidateRejectionReportService")
      .generateCandidateRejectionReport(candidate._id, { companyId: candidate.company })
      .catch((err) => console.error(`[ats] rejection report failed for candidate ${candidate._id}: ${err.message}`));
  }
  return candidate;
}

// Reload-by-ID entry point for the screening/rescore workers (§0.2/§1.1): a queued job carries
// only IDs, never a live Mongoose document, so both the screening and rescore path share this one
// reload-then-score step. runAtsForCandidate itself is untouched — only how it gets triggered
// changes here.
async function runAtsJob(candidateId, jobId) {
  const [candidate, job] = await Promise.all([Candidate.findById(candidateId), Job.findById(jobId)]);
  if (!candidate || !job) return;
  await runAtsForCandidate(candidate, job);
}

async function notifyScreeningFailure(candidateId, jobId, err) {
  const [candidate, job] = await Promise.all([Candidate.findById(candidateId), Job.findById(jobId)]);
  if (!candidate || !job) return;
  await notifyAdmin({
    companyId: job.company,
    type: "system_alert",
    title: "Screening did not complete",
    message:
      `${candidate.basicDetails.name}'s application for ${job.title} was received, but automated screening failed ` +
      `(${err.message}). Open the candidate and use "Re-run ATS" to retry.`,
    meta: { candidateId: candidate._id, jobId: job._id },
  }).catch(() => {});
}

async function notifyRescoreFailure(candidateId, jobId, err) {
  const [candidate, job] = await Promise.all([Candidate.findById(candidateId), Job.findById(jobId)]);
  if (!candidate || !job) return;
  await notifyAdmin({
    companyId: job.company,
    type: "system_alert",
    title: "Rescore did not complete",
    message: `Rescoring ${candidate.basicDetails.name} for ${job.title} failed (${err.message}). The previous score is unchanged.`,
    meta: { candidateId: candidate._id, jobId: job._id },
  }).catch(() => {});
}

// Durable screening (§1.1): enqueued onto BullMQ when Redis is configured, so a deploy or crash
// mid-screen no longer loses the candidate's application — the job survives the process and BullMQ
// retries it (attempts: 3) before screeningWorker.js raises the "did not complete" alert. Without
// Redis (this project's default local setup) it falls back to the same single-attempt in-process
// background run the codebase already uses elsewhere (runInBackground), so local dev keeps working
// unchanged.
async function enqueueScreening(candidateId, jobId) {
  const queue = getScreeningQueue();
  if (queue) {
    await queue.add("screen", { candidateId: String(candidateId), jobId: String(jobId) }, QUEUE_JOB_OPTS);
    return;
  }
  runInBackground(`screen candidate ${candidateId}`, async () => {
    try {
      await runAtsJob(candidateId, jobId);
    } catch (err) {
      console.error(`[apply] background screening failed for candidate ${candidateId}:`, err);
      await notifyScreeningFailure(candidateId, jobId, err);
    }
  });
}

// Durable rescore (§1.1) — identical mechanism to enqueueScreening, separate queue so the two are
// independently observable/scalable, matching the plan's two-queue split.
async function enqueueRescore(candidateId, jobId) {
  const queue = getRescoreQueue();
  if (queue) {
    await queue.add("rescore", { candidateId: String(candidateId), jobId: String(jobId) }, QUEUE_JOB_OPTS);
    return;
  }
  runInBackground(`rescore candidate ${candidateId}`, async () => {
    try {
      await runAtsJob(candidateId, jobId);
    } catch (err) {
      console.error(`[rescore] failed for candidate ${candidateId}:`, err);
      await notifyRescoreFailure(candidateId, jobId, err);
    }
  });
}

module.exports = {
  runAtsForCandidate,
  advanceAfterAtsPass,
  assessmentGateEngages,
  runAtsJob,
  notifyScreeningFailure,
  notifyRescoreFailure,
  enqueueScreening,
  enqueueRescore,
};
