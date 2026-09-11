const { STAGES, normalizeStage, isTerminal } = require("./pipeline");
const DAY = 86400000;

// Constant-space accumulator: evidence stays on the server, never in a full-list response.
exports.createPipelineSummary = (now = Date.now()) => {
  const value = { total: 0, active: 0, newThisWeek: 0, underReview: 0, aiCompleted: 0, scoredCount: 0, offersOut: 0, longestOfferDays: null, stageAgeSample: 0, shortlisted: 0 };
  let scoreSum = 0, ageSum = 0;
  const stages = {};
  return {
    add(candidate) {
      const stage = normalizeStage(candidate.status);
      value.total++;
      stages[stage] = (stages[stage] || 0) + 1;
      if (+new Date(candidate.createdAt) >= now - 7 * DAY) value.newThisWeek++;
      if (stage === "under_review") value.underReview++;
      if (stage === "ai_interview_completed") value.aiCompleted++;
      const ats = candidate.ats;
      if (ats && (ats.scoredAt || (ats.decision && ats.decision !== "pending"))) { value.scoredCount++; scoreSum += ats.overallScore || 0; }
      if (stage === "offer_sent") {
        value.offersOut++;
        const days = candidate.offer?.sentAt ? Math.floor((now - +new Date(candidate.offer.sentAt)) / DAY) : NaN;
        if (Number.isFinite(days) && days >= 0) value.longestOfferDays = Math.max(value.longestOfferDays ?? 0, days);
      }
      let entered = candidate.createdAt;
      let furthest = STAGES.indexOf(stage);
      for (const event of candidate.stageHistory || []) {
        const normalized = normalizeStage(event.stage);
        if (normalized === stage && event.at) entered = event.at;
        furthest = Math.max(furthest, STAGES.indexOf(normalized));
      }
      if (furthest >= STAGES.indexOf("shortlisted")) value.shortlisted++;
      if (!isTerminal(stage)) {
        value.active++;
        const days = entered ? Math.floor((now - +new Date(entered)) / DAY) : NaN;
        if (Number.isFinite(days) && days >= 0) { value.stageAgeSample++; ageSum += days; }
      }
    },
    result() { return { stages, kpis: { ...value,
      avgScore: value.scoredCount ? Math.round(scoreSum / value.scoredCount) : null,
      avgDaysInStage: value.stageAgeSample ? Math.round(ageSum / value.stageAgeSample * 10) / 10 : null,
      passThroughPct: value.total ? Math.round(value.shortlisted / value.total * 100) : null,
    } }; },
  };
};
