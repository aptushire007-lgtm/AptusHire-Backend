// Read-time projection only. Stored assessments, evidence and stages are untouched.
function reviewReport(report) {
  const interview = report?.interview;
  if (!interview) return report;
  const ev = interview.evaluation;
  const withheld = interview.status === "ended_early" || Boolean(ev?.reviewReason)
    || interview.recommendedAction?.suppressed === true;
  if (!withheld) return report;
  const reason = ev?.reviewReason || interview.recommendedAction?.justification
    || "The interview ended before enough evidence was collected";
  const sentence = reason.charAt(0).toUpperCase() + reason.slice(1).replace(/[.!?]+$/, "") + ".";
  return {
    ...report,
    interview: {
      ...interview,
      competencyTriplet: null,
      verdict: { verdict: "REVIEW", reason: "Human review required; automated recommendation withheld.", confidence: "Low" },
      verdictChip: { ...interview.verdictChip, label: "Needs human review", tone: "amber" },
      recommendedAction: { action: "Manual review", justification: reason, suppressed: true },
      // The score, sub-scores, strengths/weaknesses and missing skills are the model's actual read
      // of the transcript that exists — they are shown as-is regardless of why review is required.
      // What stays withheld is the AUTOMATED DECISION: the free-text `summary` can itself carry a
      // narrative verdict ("should not be hired") that would bypass human review just as much as an
      // exposed `recommendation` would, so it is still replaced, not the numeric evidence.
      evaluation: ev ? {
        ...ev,
        summary: `Human review required. ${sentence} Review the transcript and untested criteria before deciding the next step.`,
        recommendation: "review",
        reviewReason: reason,
      } : ev,
    },
  };
}

module.exports = { reviewReport };
