// Assignment-decision audit export (bias-audit groundwork). A disparate-impact
// review of an automated assessment starts one step EARLIER than the scores: who
// decided which ATS-passed candidates were subjected to the test at all, and who
// was waved straight through to the interview. That decision log already exists
// (Candidate.assessmentDecision, written by the Send/Skip gate) — these functions
// flatten it into a pivot-ready table an external auditor can consume.
//
// Pure functions over already-loaded documents: no queries, no LLM, no clock.

// Column order is the CSV contract — append new columns at the end only, so an
// auditor's saved pivot over an older export still lines up.
const COLUMNS = [
  "candidate_id",
  "candidate_name",
  "candidate_email",
  "job_id",
  "job_title",
  "ats_score",
  "decision",
  "decision_mode",
  "decided_by",
  "decided_at",
  "difficulty_tier",
  "tier_source",
  "tier_basis",
  "session_status",
  "total_correct",
  "total_items",
  "completed_by",
  "current_stage",
];

// One row per candidate. Candidates at the gate with no decision recorded yet
// appear as decision "pending" — the audit denominator is everyone the gate
// applied to, not just the decisions already made.
function auditRows({ candidates = [], sessionsByCandidate = new Map(), job = {} }) {
  return candidates.map((c) => {
    const d = c.assessmentDecision || {};
    const s = sessionsByCandidate.get(String(c._id)) || null;
    const tier = s?.difficultyTier || {};
    const result = s?.result?.scoredAt ? s.result : null;
    return {
      candidate_id: String(c._id),
      candidate_name: c.basicDetails?.name || "",
      candidate_email: c.basicDetails?.email || "",
      job_id: String(job._id || ""),
      job_title: job.title || "",
      ats_score: c.ats?.overallScore ?? "",
      decision: d.action || "pending",
      decision_mode: d.mode || "",
      decided_by: d.byName || "",
      decided_at: d.at ? new Date(d.at).toISOString() : "",
      difficulty_tier: tier.value || "",
      tier_source: tier.source || "",
      tier_basis: tier.basis || "",
      session_status: s?.status || "",
      total_correct: result ? result.totalCorrect : "",
      total_items: result ? result.totalItems : "",
      completed_by: result ? result.completedBy || "" : "",
      current_stage: c.status || "",
    };
  });
}

// Aggregates for the JSON view: overall sent/skip split, split by mode, and the
// per-decider rates an auditor scans first ("does one recruiter skip 90% while
// another skips 10%?"). Rates are omitted below 5 decided candidates — a rate
// over 2 decisions is noise wearing a percent sign.
const MIN_RATE_SAMPLE = 5;

function auditSummary(rows) {
  const decided = rows.filter((r) => r.decision === "sent" || r.decision === "skipped");
  const byDecider = new Map();
  const byMode = {};
  for (const r of decided) {
    byMode[r.decision_mode || "unknown"] = (byMode[r.decision_mode || "unknown"] || 0) + 1;
    const key = r.decided_by || "unknown";
    const entry = byDecider.get(key) || { decidedBy: key, sent: 0, skipped: 0 };
    entry[r.decision] += 1;
    byDecider.set(key, entry);
  }
  return {
    total: rows.length,
    pending: rows.length - decided.length,
    sent: decided.filter((r) => r.decision === "sent").length,
    skipped: decided.filter((r) => r.decision === "skipped").length,
    byMode,
    byDecider: [...byDecider.values()].map((e) => ({
      ...e,
      sentRate: e.sent + e.skipped >= MIN_RATE_SAMPLE ? Math.round((e.sent / (e.sent + e.skipped)) * 100) : null,
    })),
  };
}

// RFC 4180-style escaping: quote any field containing a comma, quote, or
// newline; double embedded quotes. Numbers pass through bare.
function csvField(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const lines = [COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(COLUMNS.map((col) => csvField(row[col])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

module.exports = { COLUMNS, auditRows, auditSummary, toCsv };
