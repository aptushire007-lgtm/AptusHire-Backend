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
      evaluation: ev ? {
        ...ev,
        summary: `Human review required. ${sentence} Review the transcript and untested criteria before deciding the next step.`,
        recommendation: "review",
        reviewReason: reason,
        overallScore: null, communication: null, technicalKnowledge: null,
        problemSolving: null, confidence: null, delivery: null,
        strengths: [], weaknesses: [], missingSkills: [],
      } : ev,
    },
  };
}

module.exports = { reviewReport };
