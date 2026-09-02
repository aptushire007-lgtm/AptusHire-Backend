// The three CV analysis cards: Document Professionalism, CV Red Flag Analysis,
// and Key Attributes.
//
// ---------------------------------------------------------------------------
// NO MODEL RUNS IN THIS FILE
// ---------------------------------------------------------------------------
//
// Everything below is a join over things already computed and already cited:
// the claim graph (utils/claimConsistency), the hostility report
// (services/resumeDefenseService), and the extraction telemetry. Every row that
// makes a claim carries the verbatim span it came from, because those spans were
// verified as literal substrings of the résumé when the claim graph was built.
//
// That is the difference from the card this is modelled on. The reference
// generates a paragraph per row and asks the reader to trust it. These rows are
// arithmetic over evidence a reviewer can open and check, which also means they
// are reproducible: the same résumé produces the same card every time, with no
// temperature and no prompt version to drift.
//
// ---------------------------------------------------------------------------
// TWO THINGS THIS FILE REFUSES TO DO
// ---------------------------------------------------------------------------
//
// 1. EMPLOYMENT GAPS ARE NOT RED FLAGS. The reference files "6-month gap between
//    2020 and 2021" under a heading that says Red Flag. ClaimGraph's own header
//    forbids that: gaps are "recorded and NEVER scored (documented disparate
//    impact on carers and people with health conditions)". They appear here as
//    neutral timeline facts, in the neutral tone, never counted into a flag
//    total and never colouring a row. Overlaps and inflation are different —
//    those are internal contradictions in the document itself, which is a
//    property of the CV rather than of the life behind it.
//
// 2. NO TRAIT RATINGS. The reference's third card rates Leadership Potential,
//    Entrepreneurial Spirit, Innovative Thinking and Estimated Career Potential
//    out of five, from a document the candidate wrote about themselves. Those
//    rate how confidently somebody writes about their own character, and there
//    is nothing to cite behind them but the self-description itself. The rows
//    below report what the CV can actually evidence — how long, how many roles,
//    how much of it is quantified — each pointing at the span it came from.

// A share of something, expressed on the 0-5 scale the cards render, in half
// steps. Coarse on purpose: the difference between 61% and 64% specific claims
// is not a difference anybody should act on.
function toStars(numerator, denominator) {
  if (!denominator) return undefined;
  return Math.round((numerator / denominator) * 10) / 2;
}

function monthsToYears(months) {
  return Math.round((months / 12) * 10) / 10;
}

function firstQuote(claim) {
  return claim?.spans?.[0]?.quote || "";
}

function statementOf(claim) {
  return `${claim.subject || ""} ${claim.predicate || ""} ${claim.object || ""}`.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Card 1 — Document Professionalism
// ---------------------------------------------------------------------------
//
// Deliberately NOT "attention to detail" as the reference scores it. Theirs is
// largely a typo-and-formatting read, and that tracks access to professional CV
// help and writing in a second language at least as strongly as it tracks care.
// Neither is job-related, and both fall hardest on candidates who are already
// disadvantaged by the format.
//
// What is left when you remove that is still worth knowing, and is genuinely
// about the document as EVIDENCE: is it dated, and does it say anything
// specific. A CV of undated roles and unquantified claims is harder to verify —
// which is a fact about how much work the next round has to do, not a judgement
// about the person.

function documentProfessionalism(graph) {
  const claims = graph?.claims || [];
  if (!claims.length) return null;

  // --- Completeness: can this document be checked at all? -------------------
  const periods = claims.filter((c) => c.type === "employment_period");
  const dated = periods.filter((c) => c.normalized?.startDate);
  const undated = periods.filter((c) => !c.normalized?.startDate);

  const completeness = {
    key: "completeness",
    label: "Completeness",
    hint: "Whether the CV gives enough to check it against.",
    score: periods.length ? toStars(dated.length, periods.length) : undefined,
    value: periods.length ? `${dated.length}/${periods.length} roles dated` : "No roles found",
    findings: [
      ...(undated.length
        ? [
            {
              text: `${undated.length} role${undated.length === 1 ? "" : "s"} carry no dates, so tenure and overlap can't be checked on ${undated.length === 1 ? "it" : "them"}.`,
              tone: "neutral",
            },
          ]
        : []),
      ...undated.slice(0, 4).map((c) => ({ text: statementOf(c), quote: firstQuote(c), tone: "neutral" })),
      ...(undated.length === 0 && periods.length
        ? [{ text: "Every role on the CV is dated.", tone: "positive" }]
        : []),
    ],
  };

  // --- Specificity: is there anything here to verify? -----------------------
  // `specificity` is set per claim at extraction time and is already one of
  // vague / specific / quantified. This is a count of those, not a new reading.
  const gradeable = claims.filter((c) => c.specificity);
  const quantified = gradeable.filter((c) => c.specificity === "quantified");
  const specific = gradeable.filter((c) => c.specificity === "specific");
  const vague = gradeable.filter((c) => c.specificity === "vague");

  const specificity = {
    key: "specificity",
    label: "Specificity",
    hint: "How much of the CV states something checkable rather than a description of duties.",
    // Quantified counts full, specific counts half, vague counts nothing.
    score: toStars(quantified.length + specific.length * 0.5, gradeable.length),
    value: gradeable.length ? `${quantified.length} of ${gradeable.length} quantified` : "—",
    findings: [
      ...quantified.slice(0, 4).map((c) => ({ text: statementOf(c), quote: firstQuote(c), tone: "positive" })),
      ...(vague.length
        ? [
            {
              text: `${vague.length} claim${vague.length === 1 ? "" : "s"} state a responsibility without a result — worth probing rather than reading as a weakness.`,
              tone: "neutral",
            },
          ]
        : []),
    ],
  };

  return { rows: [completeness, specificity] };
}

// ---------------------------------------------------------------------------
// Card 2 — CV Red Flag Analysis
// ---------------------------------------------------------------------------
//
// Three rows, and the tone of each is decided here rather than at the render, so
// that a gap can never be coloured like a contradiction by a later CSS change.
//
// `tone` is one of "clear" (nothing found), "flag" (something the document
// contradicts about itself) or "neutral" (recorded, carries no judgement).

// A contradiction about DATES is a timeline finding; one about claimed totals is
// a representation finding. The distinction matters because they have different
// remedies: the first is usually a typo or a rounded date, the second is the one
// worth asking about.
function isTimelineContradiction(c) {
  return /overlap|ends \(|before it starts/i.test(c.description || "");
}

function redFlagAnalysis({ internalContradictions = [], timelineGaps = [], hostility, extraction } = {}) {
  const timelineIssues = internalContradictions.filter(isTimelineContradiction);
  const representationIssues = internalContradictions.filter((c) => !isTimelineContradiction(c));

  // --- Timeline and tenure --------------------------------------------------
  const timeline = {
    key: "timeline",
    label: "Timeline and Tenure",
    tone: timelineIssues.length ? "flag" : "clear",
    value: timelineIssues.length
      ? `${timelineIssues.length} to check`
      : "Nothing contradictory",
    findings: [
      ...timelineIssues.map((c) => ({ text: c.description, tone: "flag" })),
      // GAPS ARE NEUTRAL AND ARE NOT COUNTED. They sit under this row because it
      // is where a reader looks for them, but they never set `tone`, never add
      // to `value`, and carry the sentence that says so.
      ...timelineGaps.map((g) => ({
        text: `${g.months}-month gap between ${g.from} and ${g.to}.`,
        tone: "neutral",
      })),
      ...(timelineGaps.length
        ? [
            {
              text: "Gaps are recorded, never scored, and never count against anyone — there are too many ordinary reasons for one.",
              tone: "note",
            },
          ]
        : []),
      ...(!timelineIssues.length && !timelineGaps.length
        ? [{ text: "Dates are continuous and none of the roles overlap.", tone: "positive" }]
        : []),
    ],
  };

  // --- Experience and representation ---------------------------------------
  const representation = {
    key: "representation",
    label: "Experience and Representation",
    tone: representationIssues.length ? "flag" : "clear",
    value: representationIssues.length ? `${representationIssues.length} to check` : "Consistent",
    findings: representationIssues.length
      ? representationIssues.map((c) => ({ text: c.description, tone: "flag" }))
      : [{ text: "What the CV claims in total matches what its dated roles add up to.", tone: "positive" }],
  };

  // --- Other flags ----------------------------------------------------------
  // From the hostility report, which already grades its own signals. Advisory
  // signals — AI-assisted writing being the main one — are surfaced but never
  // counted into the total, because those detectors are unreliable and using an
  // LLM to write a CV is not misconduct.
  const signals = hostility?.signals || [];
  const counted = signals.filter((s) => s.severity === "critical" || s.severity === "warning");
  const advisory = signals.filter((s) => s.severity === "advisory");
  const dropped = extraction?.droppedClaims || 0;

  const other = {
    key: "other",
    label: "Other Red Flags",
    tone: counted.length ? "flag" : "clear",
    value: counted.length ? `${counted.length} found` : "None",
    findings: [
      ...counted.map((s) => ({ text: s.message, quote: s.spans?.[0]?.quote || "", tone: "flag" })),
      ...advisory.map((s) => ({ text: s.message, tone: "note" })),
      ...(dropped
        ? [
            {
              // Our instrument's own failure rate, printed beside the candidate's
              // flags rather than hidden. A résumé where many claims could not be
              // cited is one the extraction struggled with — often a scan or an
              // unusual layout — and that is a reason to read the document
              // itself, not a mark against the person.
              text: `${dropped} extracted claim${dropped === 1 ? "" : "s"} couldn't be traced back to the document and ${dropped === 1 ? "was" : "were"} discarded. That's our parser, not the candidate.`,
              tone: "note",
            },
          ]
        : []),
      ...(!counted.length && !advisory.length && !dropped
        ? [{ text: "No manipulation signals, hidden text or injected instructions.", tone: "positive" }]
        : []),
    ],
  };

  return { rows: [timeline, representation, other] };
}

// ---------------------------------------------------------------------------
// Card 3 — Key Attributes
// ---------------------------------------------------------------------------
//
// The reference calls this "Key Attributes & Potential" and fills it with
// Leadership Potential, Entrepreneurial Spirit, Innovative Thinking and
// Estimated Career Potential, rated out of five off the CV.
//
// Those are not dropped here because they are unflattering to compute — they are
// dropped because there is nothing to cite behind them. The only evidence a CV
// offers for "entrepreneurial spirit" is the candidate's own description of
// themselves as entrepreneurial, so the rating measures how confidently somebody
// writes about their character. "Estimated Career Potential" goes further and
// predicts a ceiling, which is a claim about a person's future that no document
// can support and that nobody should be making from one.
//
// What the CV genuinely evidences is below: how long, how many, how deep, how
// much of it is checkable. Every row points at its spans.

// Specialist / Generalist / Hybrid, from the spread of domains across the dated
// roles. Descriptive, not a rating — it says what shape the career is, and the
// same CV always produces the same word.
function experienceModel(periods, experiences) {
  const domains = new Set(
    [...periods, ...experiences].map((c) => (c.normalized?.domain || "").trim().toLowerCase()).filter(Boolean)
  );
  if (!domains.size) return null;
  if (domains.size === 1) return { label: "Specialist", detail: `All roles in ${[...domains][0]}.` };
  if (domains.size >= 4) return { label: "Generalist", detail: `Roles across ${domains.size} domains.` };
  return { label: "Hybrid", detail: `Roles across ${domains.size} domains.` };
}

function keyAttributes(graph, { totalMonths } = {}) {
  const claims = graph?.claims || [];
  if (!claims.length) return null;

  const periods = claims.filter((c) => c.type === "employment_period");
  const experiences = claims.filter((c) => c.type === "experience");
  const outcomes = claims.filter((c) => c.type === "outcome");

  const rows = [];

  // --- Progression ----------------------------------------------------------
  if (periods.length) {
    const years = totalMonths ? monthsToYears(totalMonths) : null;
    rows.push({
      key: "progression",
      label: "Progression",
      hint: "Roles held, and over how long.",
      value: years ? `${periods.length} roles / ${years} yrs` : `${periods.length} roles`,
      findings: periods
        .slice(0, 6)
        .map((c) => ({
          text: [statementOf(c), c.normalized?.startDate ? `(${c.normalized.startDate} – ${c.normalized.endDate || "present"})` : null]
            .filter(Boolean)
            .join(" "),
          quote: firstQuote(c),
          tone: "neutral",
        })),
    });
  }

  // --- Evidenced outcomes ---------------------------------------------------
  // The closest honest thing to the reference's "delivery record": not whether
  // they seem like a deliverer, but how many of their stated results carry a
  // number. A quantified outcome is checkable in the next round; a vague one is
  // a sentence.
  if (outcomes.length) {
    const quantified = outcomes.filter((c) => c.specificity === "quantified");
    rows.push({
      key: "outcomes",
      label: "Evidenced outcomes",
      hint: "Results stated with a figure attached, rather than described.",
      score: toStars(quantified.length, outcomes.length),
      value: `${quantified.length} of ${outcomes.length}`,
      findings: quantified.length
        ? quantified.slice(0, 5).map((c) => ({ text: statementOf(c), quote: firstQuote(c), tone: "positive" }))
        : [
            {
              text: "No result on this CV carries a figure. Worth asking for one specific number in the next round.",
              tone: "neutral",
            },
          ],
    });
  }

  // --- Depth ----------------------------------------------------------------
  // The longest single tenure, which is the one thing about "how deep did they
  // go" that a CV states rather than implies.
  const longest = periods
    .map((c) => {
      const s = c.normalized?.startDate;
      const e = c.normalized?.endDate;
      if (!s) return null;
      const parse = (v) => {
        const m = String(v).match(/^(\d{4})(?:-(\d{1,2}))?/);
        return m ? Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0) : null;
      };
      const start = parse(s);
      const end = e ? parse(e) : new Date().getFullYear() * 12 + new Date().getMonth();
      if (start === null || end === null || end < start) return null;
      return { claim: c, months: end - start };
    })
    .filter(Boolean)
    .sort((a, b) => b.months - a.months)[0];

  if (longest) {
    rows.push({
      key: "depth",
      label: "Longest tenure",
      hint: "The single role they stayed in longest.",
      value: `${monthsToYears(longest.months)} yrs`,
      findings: [{ text: statementOf(longest.claim), quote: firstQuote(longest.claim), tone: "neutral" }],
    });
  }

  if (!rows.length) return null;
  return { model: experienceModel(periods, experiences), rows };
}

module.exports = {
  documentProfessionalism,
  redFlagAnalysis,
  keyAttributes,
  experienceModel,
  toStars,
};
