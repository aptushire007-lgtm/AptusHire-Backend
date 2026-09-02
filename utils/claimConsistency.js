// Internal-consistency checks over a verified claim set (BUILD-PLAN Phase 5.5).
// Pure code, no model. Findings are EVIDENCE FOR A PROBE, never a penalty:
// contradictions route to humans and interviews; gaps are recorded and never
// scored (documented disparate impact — see ClaimGraph model header).

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

// Parse "2022-01", "2022", "January 2022", "Jan 2022" → month index (year*12+m).
// Returns null when unparseable — unparseable dates are simply skipped, never
// guessed.
function parseMonth(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase();
  let m = s.match(/^(\d{4})(?:-(\d{1,2}))?/);
  if (m) {
    const year = Number(m[1]);
    const month = m[2] ? Math.min(12, Math.max(1, Number(m[2]))) : 1;
    return year * 12 + (month - 1);
  }
  m = s.match(/^([a-z]+)\s+(\d{4})$/);
  if (m && MONTHS[m[1]]) return Number(m[2]) * 12 + (MONTHS[m[1]] - 1);
  return null;
}

function monthToLabel(idx) {
  const year = Math.floor(idx / 12);
  const month = (idx % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Analyse employment_period claims + total-experience claims.
 * `nowMonth` is injectable for tests; defaults to the current month.
 * Returns { internalContradictions, timelineGaps, totalMonths }.
 */
function analyzeTimeline(claims, { nowMonth } = {}) {
  const now = nowMonth ?? new Date().getFullYear() * 12 + new Date().getMonth();
  const contradictions = [];
  const gaps = [];

  const periods = [];
  for (const c of claims) {
    if (c.type !== "employment_period") continue;
    const start = parseMonth(c.normalized?.startDate);
    if (start === null) continue;
    let end = parseMonth(c.normalized?.endDate);
    if (end === null) end = now; // "present"
    if (end < start) {
      contradictions.push({
        claimIds: [c.id],
        description: `Employment period ends (${c.normalized.endDate}) before it starts (${c.normalized.startDate}).`,
      });
      continue;
    }
    periods.push({ id: c.id, start, end });
  }
  periods.sort((a, b) => a.start - b.start);

  // Overlaps > 1 month between consecutive periods (moonlighting is possible;
  // heavy overlap is a probe-worthy ambiguity, not an accusation).
  for (let i = 1; i < periods.length; i += 1) {
    const prev = periods[i - 1];
    const cur = periods[i];
    const overlap = prev.end - cur.start;
    if (overlap > 1) {
      contradictions.push({
        claimIds: [prev.id, cur.id],
        description: `Employment periods overlap by ${overlap} months (${monthToLabel(cur.start)} to ${monthToLabel(prev.end)}).`,
      });
    }
  }

  // Gaps ≥ 3 months — RECORDED ONLY, never scored.
  for (let i = 1; i < periods.length; i += 1) {
    const gap = periods[i].start - periods[i - 1].end;
    if (gap >= 3) {
      gaps.push({ from: monthToLabel(periods[i - 1].end), to: monthToLabel(periods[i].start), months: gap });
    }
  }

  // Union of covered months (overlaps counted once) for total-years comparison.
  let totalMonths = 0;
  let coveredTo = -Infinity;
  for (const p of periods) {
    const from = Math.max(p.start, coveredTo);
    if (p.end > from) {
      totalMonths += p.end - from;
      coveredTo = p.end;
    } else if (p.end > coveredTo) {
      coveredTo = p.end;
    }
  }

  // Claimed total experience ("six years of…") vs dated roles. Tolerance 18
  // months — rounded self-descriptions are normal; a multi-year inflation is a
  // contradiction worth probing.
  for (const c of claims) {
    if (c.type !== "experience") continue;
    const years = Number(c.normalized?.years);
    if (!Number.isFinite(years) || years <= 0) continue;
    if (periods.length === 0) continue;
    const claimedMonths = years * 12;
    if (claimedMonths - totalMonths > 18) {
      contradictions.push({
        claimIds: [c.id, ...periods.map((p) => p.id)],
        description:
          `Claimed ${years} years of experience, but the dated roles cover about ` +
          `${Math.round(totalMonths / 12)} years (${totalMonths} months).`,
      });
    }
  }

  return { internalContradictions: contradictions, timelineGaps: gaps, totalMonths };
}

module.exports = { analyzeTimeline, parseMonth };
