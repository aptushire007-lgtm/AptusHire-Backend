// Candidate hiring-pipeline definition (Module 11 — Hiring Pipeline & Candidate
// Lifecycle). Pure helpers only: ordered stages, display labels, legacy status
// mapping, and transition validation. No DB / no side effects — the pipeline
// service and controllers consume this.

// Canonical ordered pipeline. Index order encodes "forward" progress; `rejected`
// is a terminal off-ramp reachable from any active stage and is intentionally
// kept out of the ordered progression.
const STAGES = [
  "applied",
  "ats_passed",
  // Assessment stages (ASSESSMENT-ENGINE-PLAN A2.3) are OPT-IN: a candidate only
  // enters them when a recruiter explicitly assigns an assessment. The skip path
  // (ats_passed → interview_scheduled) is a plain forward move and never touches
  // them, so tenants without the feature see byte-identical transitions.
  "assessment_scheduled",
  "assessment_completed",
  "interview_scheduled",
  "ai_interview_completed",
  "under_review",
  "shortlisted",
  "hr_interview",
  "technical_interview",
  "manager_interview",
  "selected",
  "offer_sent",
  "offer_accepted",
  "joined",
];

const REJECTED = "rejected";

// Terminal stages: no transitions are allowed out of these.
const TERMINAL_STAGES = ["joined", REJECTED];

// Interview rounds may be scheduled in any order (a company might run technical
// before HR), so lateral moves within this group are allowed.
const ROUND_STAGES = ["hr_interview", "technical_interview", "manager_interview"];

const STAGE_LABELS = {
  applied: "Applied",
  ats_passed: "ATS Passed",
  assessment_scheduled: "Assessment Sent",
  assessment_completed: "Assessment Completed",
  interview_scheduled: "Interview Scheduled",
  ai_interview_completed: "AI Interview Completed",
  under_review: "Under Review",
  shortlisted: "Shortlisted",
  hr_interview: "HR Interview",
  technical_interview: "Technical Interview",
  manager_interview: "Manager Interview",
  selected: "Selected",
  offer_sent: "Offer Sent",
  offer_accepted: "Offer Accepted",
  joined: "Joined",
  rejected: "Rejected",
};

// Statuses used by earlier versions of the app, mapped onto the new pipeline so
// existing Candidate documents keep validating and rendering correctly.
const LEGACY_STAGE_MAP = {
  interview_queue: "interview_scheduled",
  next_round: "shortlisted",
};

function normalizeStage(stage) {
  return LEGACY_STAGE_MAP[stage] || stage;
}

function isValidStage(stage) {
  return stage === REJECTED || STAGES.includes(stage);
}

function isTerminal(stage) {
  return TERMINAL_STAGES.includes(normalizeStage(stage));
}

function stageIndex(stage) {
  return STAGES.indexOf(normalizeStage(stage));
}

function stageLabel(stage) {
  const s = normalizeStage(stage);
  return STAGE_LABELS[s] || s;
}

// Transition rules (prevents invalid jumps required by the module spec):
//  - No transitions out of a terminal stage (joined / rejected).
//  - No no-op transitions (same stage).
//  - Any active stage may move to `rejected`.
//  - Forward moves along the ordered pipeline are allowed.
//  - Lateral moves among interview rounds are allowed (any round order).
function canTransition(fromStage, toStage) {
  const from = normalizeStage(fromStage);
  const to = normalizeStage(toStage);

  if (!isValidStage(from) || !isValidStage(to)) return false;
  if (from === to) return false;
  if (isTerminal(from)) return false;
  if (to === REJECTED) return true;

  const fromIdx = stageIndex(from);
  const toIdx = stageIndex(to);
  if (fromIdx === -1 || toIdx === -1) return false;

  if (toIdx > fromIdx) return true;
  if (ROUND_STAGES.includes(from) && ROUND_STAGES.includes(to)) return true;

  return false;
}

function allowedNextStages(fromStage) {
  return [...STAGES, REJECTED].filter((s) => canTransition(fromStage, s));
}

// Appends a stage-history entry in place. `candidate.stageHistory` must exist
// (the Candidate schema defaults it to []).
function appendStageHistory(candidate, stage, { note, by } = {}) {
  candidate.stageHistory.push({
    stage: normalizeStage(stage),
    note: note || undefined,
    by: by || "system",
    at: new Date(),
  });
}

module.exports = {
  STAGES,
  REJECTED,
  TERMINAL_STAGES,
  ROUND_STAGES,
  STAGE_LABELS,
  LEGACY_STAGE_MAP,
  normalizeStage,
  isValidStage,
  isTerminal,
  stageIndex,
  stageLabel,
  canTransition,
  allowedNextStages,
  appendStageHistory,
};
