// Candidate-facing views of internal documents. Everything the candidate's own
// browser receives goes through here — a raw Candidate or InterviewSession doc
// carries recruiter-only material (ATS internals, the interview evaluation and
// recommendation, proctoring risk, tokenHash, resumeText, hostility report)
// that must never ship to the applicant. Anything not listed here is withheld
// on purpose; add fields deliberately, never by spreading the doc.

// A candidate's view of their own application. Stage history is stages+dates
// only: `by` (admin identity) and `note` (internal remarks) stay server-side.
function toApplicationView(c) {
  return {
    _id: c._id,
    job: c.job,
    status: c.status,
    createdAt: c.createdAt,
    resumeOriginalName: c.resumeOriginalName,
    stageHistory: (c.stageHistory || []).map((h) => ({ stage: h.stage, at: h.at })),
    offer:
      c.offer && c.offer.status !== "none"
        ? { status: c.offer.status, message: c.offer.message, sentAt: c.offer.sentAt, respondedAt: c.offer.respondedAt }
        : undefined,
  };
}

// A candidate's view of their interview session: schedule + coarse progress.
// Never the tokenHash, proctoring state, transcript, or evaluation.
// `candidate` is the applicant's own application id — already theirs, and needed
// to line a session up against the right application on the dashboard.
function toSessionView(s) {
  const ai = s.aiInterview;
  return {
    _id: s._id,
    candidate: s.candidate,
    job: s.job,
    status: s.status,
    interviewAt: s.interviewAt,
    expiresAt: s.expiresAt,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    aiInterview: ai ? { status: ai.status, questionCount: ai.questionCount } : undefined,
  };
}

// A candidate's view of their assessment session: the schedule, the two
// deadlines that actually decide the outcome, and how far through they are.
//
// Withheld on purpose, and not by accident of omission:
//   - `result` (score, perItem, perCriterion, claimVerdicts, reproducibilityHash)
//     — an evaluation the recruiter has not released; releasing it here would
//     also hand a re-taking candidate the answer key.
//   - `assembledItems` — the questions and their per-candidate option order.
//   - `proctoring` — risk score, band, events, identity match. Adverse material
//     that a human must review before it means anything.
//   - `tokenHash`, `paper`, `assignment` — internal identifiers.
//
// Progress is reported as counts of the candidate's OWN sections, which is what
// "am I nearly done" needs and carries none of the above.
function toAssessmentSessionView(s) {
  const sections = s.sectionState || [];
  return {
    _id: s._id,
    candidate: s.candidate,
    job: s.job,
    status: s.status,
    validFrom: s.validFrom,
    startDeadline: s.startDeadline,
    expiresAt: s.expiresAt,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    progress: {
      totalSections: sections.length,
      completedSections: sections.filter((x) => x.status === "completed").length,
      // Answered-count only — never which items, nor whether they were right.
      answered: (s.responses || []).length,
      totalItems: (s.assembledItems || []).length,
    },
  };
}

// Minimal application receipt returned from POST /jobs/:id/apply.
function toApplyReceipt(c, job) {
  return {
    _id: c._id,
    job: job ? { _id: job._id, title: job.title } : c.job,
    status: c.status,
    createdAt: c.createdAt,
  };
}

module.exports = { toApplicationView, toSessionView, toAssessmentSessionView, toApplyReceipt };
