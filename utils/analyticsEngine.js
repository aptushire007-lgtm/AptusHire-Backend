// Pure analytics computations (BUILD-PLAN Phase 12). No I/O, no clock, no
// model — controllers fetch rows, these functions compute, tests pin them.

const { STAGES, normalizeStage } = require("./pipeline");

// Funnel: how many candidates REACHED each stage (from the append-only
// stageHistory), plus per-stage conversion from the previous reached count.
function computeFunnel(candidates) {
  const reached = Object.fromEntries(STAGES.map((s) => [s, 0]));
  let rejected = 0;
  for (const c of candidates) {
    const seen = new Set((c.stageHistory || []).map((h) => normalizeStage(h.stage)));
    if (normalizeStage(c.status) === "rejected") rejected += 1;
    for (const s of seen) {
      if (reached[s] !== undefined) reached[s] += 1;
    }
  }
  const stages = STAGES.map((stage, i) => {
    const count = reached[stage];
    // Convert from the nearest PRIOR stage anyone actually reached — the
    // assessment stages are opt-in (skipped candidates go ats_passed →
    // interview_scheduled directly), so an untouched intermediate stage must
    // not zero out the next stage's conversion.
    let prev = candidates.length;
    for (let j = i - 1; j >= 0; j--) {
      if (reached[STAGES[j]] > 0) {
        prev = reached[STAGES[j]];
        break;
      }
    }
    return {
      stage,
      count,
      conversionFromPrevious: prev > 0 ? Math.round((count / prev) * 1000) / 1000 : null,
    };
  });
  return { total: candidates.length, rejected, stages };
}

// Time-to-hire: applied → offer_accepted/joined, in days. Median beats mean
// for skewed hiring timelines; both are reported with n.
function computeTimeToHire(candidates) {
  const durations = [];
  for (const c of candidates) {
    const history = c.stageHistory || [];
    const start = history.find((h) => normalizeStage(h.stage) === "applied")?.at || c.createdAt;
    const hire = history.find((h) => ["offer_accepted", "joined"].includes(normalizeStage(h.stage)))?.at;
    if (!start || !hire) continue;
    const days = (new Date(hire) - new Date(start)) / 86400000;
    if (days >= 0) durations.push(days);
  }
  if (!durations.length) return { n: 0, meanDays: null, medianDays: null };
  durations.sort((a, b) => a - b);
  const mean = durations.reduce((s, d) => s + d, 0) / durations.length;
  const mid = Math.floor(durations.length / 2);
  const median = durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
  return {
    n: durations.length,
    meanDays: Math.round(mean * 10) / 10,
    medianDays: Math.round(median * 10) / 10,
  };
}

// Score distribution in decile bins (same shape the calibration curve uses).
function scoreDistribution(scores) {
  const bins = [];
  for (let lo = 0; lo < 100; lo += 10) {
    const hi = lo + 10 === 100 ? 100 : lo + 9;
    bins.push({ lo, hi, count: 0 });
  }
  for (const raw of scores) {
    const s = Number(raw);
    if (!Number.isFinite(s)) continue;
    const idx = Math.min(9, Math.max(0, Math.floor(s / 10)));
    bins[idx].count += 1;
  }
  return bins;
}

// Which criteria eliminate the most candidates: absent/contradicted findings
// among decline-band assessments, ranked. Evidence-native — no competitor can
// even ask this question of their own data.
function topEliminators(assessments) {
  const byCriterion = new Map();
  for (const a of assessments) {
    if (a.band !== "decline") continue;
    for (const f of a.criterionFindings || []) {
      if (f.kind === "disqualifier") continue;
      if (!["absent", "contradicted"].includes(f.status)) continue;
      const key = `${f.criterionId}|${f.label}`;
      const row = byCriterion.get(key) || { criterionId: f.criterionId, label: f.label, eliminations: 0 };
      row.eliminations += 1;
      byCriterion.set(key, row);
    }
  }
  return [...byCriterion.values()].sort((a, b) => b.eliminations - a.eliminations);
}

// Claim-verification outcomes by normalised skill ("résumé-inflation patterns
// by skill" — Phase 8 verdicts aggregated). `probeRows` =
// [{ skill, verdict }] already joined by the caller.
function verificationBySkill(probeRows) {
  const bySkill = new Map();
  for (const row of probeRows) {
    const skill = row.skill || "(unspecified)";
    const s = bySkill.get(skill) || { skill, probed: 0, verified: 0, contradicted: 0, inconclusive: 0 };
    s.probed += 1;
    if (row.verdict === "verified") s.verified += 1;
    else if (row.verdict === "contradicted") s.contradicted += 1;
    else s.inconclusive += 1;
    bySkill.set(skill, s);
  }
  return [...bySkill.values()]
    .map((s) => ({ ...s, contradictionRate: s.probed ? Math.round((s.contradicted / s.probed) * 1000) / 1000 : 0 }))
    .sort((a, b) => b.contradicted - a.contradicted || b.probed - a.probed);
}

// Engine-vs-human override rates from resolved review items:
// how often did a human disagree with the engine's band?
function overrideRates(reviewItems) {
  const resolved = reviewItems.filter((r) => r.status === "resolved" && r.resolution?.decision);
  let agree = 0;
  let overrideAdvance = 0; // engine said review/decline, human advanced
  let overrideDecline = 0; // engine said review/advance, human declined
  for (const r of resolved) {
    const engineBand = r.label?.engineBand;
    const human = r.resolution.decision; // advance | decline
    if ((engineBand === "advance" && human === "advance") || (engineBand === "decline" && human === "decline")) agree += 1;
    else if (human === "advance") overrideAdvance += 1;
    else overrideDecline += 1;
  }
  return {
    resolved: resolved.length,
    agree,
    overrideAdvance,
    overrideDecline,
    overrideRate: resolved.length ? Math.round(((overrideAdvance + overrideDecline) / resolved.length) * 1000) / 1000 : null,
  };
}

// Counterfactual probe results over a set of assessments (the live bias
// monitoring record the audit pack reports).
function summarizeCounterfactuals(assessments) {
  let ran = 0;
  let identical = 0;
  let leaks = 0;
  for (const a of assessments) {
    if (!a.qa?.counterfactual?.ran) continue;
    ran += 1;
    if (a.qa.counterfactual.identical === true) identical += 1;
    else if (a.qa.counterfactual.identical === false) leaks += 1;
  }
  return { ran, identical, leaks };
}

// Phase 15.9 — source quality measured by DOWNSTREAM TRUTH, not click volume:
// per source, how many applied, how many passed screening, how their claims
// held up under interview verification, how many advanced, how many were hired.
// "Naukri sends volume; referrals send verified claims" is a report no
// click-counting attribution tool can produce, because none of them verify claims.
//
// candidates: [{ source, ats, stageHistory, status }]
// probesByCandidate: Map(candidateId → [{ verdict }]) from assessed claim-probes.
const ADVANCE_STAGES = new Set(STAGES.slice(STAGES.indexOf("shortlisted")));
function sourceQuality(candidates, probesByCandidate = new Map()) {
  const rows = new Map();
  for (const c of candidates) {
    const channel = c.source?.channel || "(untagged)";
    if (!rows.has(channel)) {
      rows.set(channel, {
        channel,
        applied: 0,
        atsPassed: 0,
        advanced: 0,
        hires: 0,
        probed: 0,
        verified: 0,
        contradicted: 0,
      });
    }
    const row = rows.get(channel);
    row.applied += 1;
    if (c.ats?.decision === "pass") row.atsPassed += 1;
    const seen = new Set((c.stageHistory || []).map((h) => normalizeStage(h.stage)));
    if ([...seen].some((s) => ADVANCE_STAGES.has(s))) row.advanced += 1;
    if (seen.has("offer_accepted") || seen.has("joined")) row.hires += 1;
    for (const p of probesByCandidate.get(String(c._id)) || []) {
      if (!p.verdict) continue;
      row.probed += 1;
      if (p.verdict === "verified") row.verified += 1;
      if (p.verdict === "contradicted") row.contradicted += 1;
    }
  }
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 1000 : null);
  return [...rows.values()]
    .map((r) => ({
      ...r,
      atsPassRate: pct(r.atsPassed, r.applied),
      advanceRate: pct(r.advanced, r.applied),
      verificationRate: pct(r.verified, r.probed),
      contradictionRate: pct(r.contradicted, r.probed),
    }))
    .sort((a, b) => b.applied - a.applied);
}

module.exports = {
  computeFunnel,
  computeTimeToHire,
  scoreDistribution,
  topEliminators,
  verificationBySkill,
  overrideRates,
  summarizeCounterfactuals,
  sourceQuality,
};
