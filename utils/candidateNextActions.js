// Candidate-facing "what happens next" engine.
//
// Every other candidate portal shows one recruiter-set label ("Under Review")
// with no owner and no date. That label is unfalsifiable — it is equally true on
// day 1 and on day 60 — so the candidate cannot tell whether they are blocking
// the process or the company is, and the real deadlines that actually decide
// outcomes (assessment start windows, interview link expiry) live only in an
// email that gets lost. People then fail by missing a window rather than on
// merit, which is exactly the opacity that transparency duties target.
//
// This module answers, for each application: WHO is it waiting on, and BY WHEN.
// It is deliberately pure — no DB, no Date.now(), no mongoose — because it
// decides what a candidate is told about their own hiring outcome, and that
// deserves to be reproducible and unit-testable. `now` is injected.
//
// It reports state; it never invents an explanation. A rejection is reported as
// a rejection with its date, never with a machine-authored reason.

// Deadline proximity bands. Used for emphasis only — the exact timestamp is
// always shown alongside, so the band can never be the whole story.
const SOON_MS = 24 * 60 * 60 * 1000;

function toTime(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

function urgency(dueAt, now) {
  const due = toTime(dueAt);
  if (due === null) return "none";
  if (due <= now) return "overdue";
  return due - now <= SOON_MS ? "soon" : "scheduled";
}

// When a stage was last changed — used for honest "waiting since" reporting on
// the company's side of the ledger. Falls back to application creation.
function lastMovedAt(application) {
  const history = application.stageHistory || [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const at = toTime(history[i]?.at);
    if (at !== null) return new Date(at).toISOString();
  }
  return application.createdAt ? new Date(application.createdAt).toISOString() : null;
}

// --- per-session actions ----------------------------------------------------

// An assessment the candidate still owes. Two distinct deadlines matter and are
// routinely confused: `startDeadline` is the last moment they may BEGIN, and
// `expiresAt` is when the window shuts regardless. Once started, the finish
// deadline is the operative one.
function assessmentAction(session, now) {
  const status = session.status;
  if (status === "completed") {
    return {
      kind: "assessment",
      owner: "company",
      state: "done",
      title: "Assessment submitted",
      detail: "Your answers are with the hiring team.",
      at: session.completedAt || null,
    };
  }
  if (status === "cancelled") {
    return {
      kind: "assessment",
      owner: "none",
      state: "cancelled",
      title: "Assessment cancelled",
      detail: "The hiring team withdrew this assessment.",
      at: null,
    };
  }

  const started = Boolean(session.startedAt) || status === "in_progress" || status === "paused";
  const dueAt = started ? session.expiresAt : session.startDeadline || session.expiresAt;
  const band = urgency(dueAt, now);

  // `expired` is a status the cron sets; a still-"scheduled" session whose
  // window has passed is equally expired in practice. Treat both the same so a
  // candidate is never told they still have time when they do not.
  if (status === "expired" || band === "overdue") {
    return {
      kind: "assessment",
      owner: "candidate",
      state: "missed",
      title: "Assessment window closed",
      detail: started
        ? "Your assessment was not submitted before the window closed. Any answers you saved were kept — the hiring team can reopen it if they choose to."
        : "The window to start this assessment has passed. Only the hiring team can reopen it.",
      dueAt: dueAt || null,
      sessionId: session._id,
      canRecoverLink: true,
    };
  }

  return {
    kind: "assessment",
    owner: "candidate",
    state: started ? "in_progress" : "due",
    title: started ? "Finish your assessment" : "Take your assessment",
    detail: started
      ? "You have started this assessment. Your saved answers are still there — pick up where you left off."
      : "You can start it here, or from the link in your invitation email.",
    dueAt: dueAt || null,
    urgency: band,
    sessionId: session._id,
    canRecoverLink: true,
    // The window is open, so this session can be entered straight from the
    // dashboard — no emailed link required. `missed` deliberately omits this:
    // an expired window is a recruiter decision to reopen, not a button.
    canOpen: true,
  };
}

// An interview the candidate still owes. Unlike an assessment, this one has a
// scheduled TIME as well as a link expiry, and the two are different promises.
function interviewAction(session, now) {
  const status = session.status;
  const aiStatus = session.aiInterview?.status;

  if (status === "completed" || aiStatus === "completed") {
    return {
      kind: "interview",
      owner: "company",
      state: "done",
      title: "Interview completed",
      detail: "Your interview is with the hiring team for review.",
      at: session.completedAt || null,
    };
  }
  if (status === "cancelled") {
    return {
      kind: "interview",
      owner: "none",
      state: "cancelled",
      title: "Interview cancelled",
      detail: "The hiring team cancelled this interview.",
      at: null,
    };
  }

  const dueAt = session.expiresAt;
  const band = urgency(dueAt, now);
  const started = Boolean(session.startedAt) || status === "in_progress" || aiStatus === "in_progress";

  if (status === "expired" || band === "overdue") {
    return {
      kind: "interview",
      owner: "candidate",
      state: "missed",
      title: "Interview link expired",
      detail: started
        ? "Your interview was not finished before the link expired. The hiring team can reissue it, and you would resume where you left off."
        : "This interview is no longer open. Only the hiring team can reschedule it.",
      dueAt: dueAt || null,
      scheduledAt: session.interviewAt || null,
      sessionId: session._id,
      canRecoverLink: true,
    };
  }

  return {
    kind: "interview",
    owner: "candidate",
    state: started ? "in_progress" : "due",
    title: started ? "Resume your interview" : "Attend your interview",
    // No fixed slot is enforced anywhere — the portal admits this session from
    // the moment it exists until expiresAt, which is exactly what the invitation
    // email promises ("take it whenever suits you"). Telling the candidate to
    // wait for interviewAt would invent a rule the system does not have, and the
    // cost of believing it is a missed window.
    detail: started
      ? "You have already started. Rejoining resumes the same interview."
      : "You can start it here any time before it closes, or use the link in your invitation email.",
    dueAt: dueAt || null,
    scheduledAt: session.interviewAt || null,
    urgency: band,
    sessionId: session._id,
    canRecoverLink: true,
    // See assessmentAction: live window ⇒ enterable from the dashboard.
    canOpen: true,
  };
}

// --- stage-derived actions --------------------------------------------------

// Stages where nothing is owed by anyone and the process has ended. Reported
// plainly, with a date, and with no machine-authored explanation attached.
const CLOSED = {
  rejected: {
    title: "Not moving forward",
    detail: "The hiring team decided not to progress this application.",
  },
  joined: { title: "You joined", detail: "This application is complete." },
  offer_accepted: { title: "Offer accepted", detail: "Congratulations — the hiring team will be in touch." },
};

// What the company owes, per stage. Naming the specific step is the point: a
// generic "in review" tells the candidate nothing they did not already know.
const COMPANY_STEP = {
  applied: "Your application is being screened.",
  ats_passed: "You passed screening. The hiring team is deciding the next step.",
  assessment_completed: "Your assessment is being reviewed.",
  ai_interview_completed: "Your interview is being reviewed.",
  under_review: "The hiring team is reviewing your application.",
  shortlisted: "You are shortlisted. The hiring team is arranging the next round.",
  hr_interview: "Your HR interview round is in progress with the hiring team.",
  technical_interview: "Your technical round is in progress with the hiring team.",
  manager_interview: "Your manager round is in progress with the hiring team.",
  selected: "You have been selected. The hiring team is preparing an offer.",
};

// --- the engine -------------------------------------------------------------

// Returns one primary action per application, plus the full list, so the UI can
// lead with what is actually owed rather than with a status label.
//
// Precedence is deliberate: a live obligation on the CANDIDATE always outranks
// whatever the stage field says, because the stage lags the session. A
// candidate whose assessment closes in two hours must see that, not
// "Assessment Sent".
function buildNextActions({ applications = [], interviewSessions = [], assessmentSessions = [], now = 0 } = {}) {
  const byApplication = new Map();
  const push = (candidateId, action) => {
    if (!candidateId || !action) return;
    const key = String(candidateId);
    if (!byApplication.has(key)) byApplication.set(key, []);
    byApplication.get(key).push(action);
  };

  for (const s of assessmentSessions) push(s.candidate, assessmentAction(s, now));
  for (const s of interviewSessions) push(s.candidate, interviewAction(s, now));

  return applications.map((application) => {
    const key = String(application._id);
    const actions = byApplication.get(key) || [];
    const status = application.status;

    if (CLOSED[status]) {
      const closed = { kind: "closed", owner: "none", state: "closed", ...CLOSED[status], at: lastMovedAt(application) };
      return { applicationId: application._id, primary: closed, actions };
    }

    // An offer is an obligation on the candidate that has no session object, so
    // it is derived from the stage rather than from a session.
    if (status === "offer_sent") {
      const offer = {
        kind: "offer",
        owner: "candidate",
        state: "due",
        title: "Respond to your offer",
        detail: "The hiring team has sent you an offer.",
        at: application.offer?.sentAt || lastMovedAt(application),
      };
      return { applicationId: application._id, primary: offer, actions };
    }

    // Live obligations on the candidate, most urgent first. `missed` sorts above
    // everything: a closed window the candidate can still recover from is the
    // single most valuable thing to show them.
    const mine = actions.filter((a) => a.owner === "candidate");
    if (mine.length > 0) {
      const rank = { missed: 0, in_progress: 1, due: 2 };
      const sorted = [...mine].sort((a, b) => {
        const r = (rank[a.state] ?? 9) - (rank[b.state] ?? 9);
        if (r !== 0) return r;
        return (toTime(a.dueAt) ?? Infinity) - (toTime(b.dueAt) ?? Infinity);
      });
      return { applicationId: application._id, primary: sorted[0], actions };
    }

    const since = lastMovedAt(application);
    const waiting = {
      kind: "review",
      owner: "company",
      state: "waiting",
      title: "With the hiring team",
      // No stage entry means a status this build does not model. Say that
      // plainly rather than rendering a confident-looking blank.
      detail: COMPANY_STEP[status] || "Your application is with the hiring team.",
      since,
    };
    return { applicationId: application._id, primary: waiting, actions };
  });
}

module.exports = { buildNextActions, SOON_MS };
