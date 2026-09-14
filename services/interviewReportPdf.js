// Renders an AI interview report (the same shape controllers/candidateController.buildInterviewReport
// returns) into a downloadable PDF, using the zero-dep utils/pdf.js builder.

const { PdfDoc, sanitize } = require("../utils/pdf");
// Derived values are computed ONCE, in the engine, and printed by both surfaces —
// see the scar comment on `bucketPercents` in the engine, which is what that rule
// was written from.

const INK = [0.09, 0.11, 0.15];
const MUTED = [0.42, 0.45, 0.5];
const BRAND = [0.16, 0.23, 0.42];
const WARN = [0.7, 0.45, 0.05];

const RECOMMENDATION = {
  strong_hire: "Strong Hire",
  hire: "Hire",
  maybe: "Maybe",
  no_hire: "No Hire",
};

const VERDICT_COLORS = {
  CLEAR_REJECT: [0.86, 0.15, 0.15],
  REVIEW: [0.85, 0.55, 0.06],
  ADVANCE: [0.11, 0.6, 0.4],
};
const VERDICT_LABELS = {
  CLEAR_REJECT: "CLEAR REJECT",
  REVIEW: "REVIEW",
  ADVANCE: "ADVANCE",
};

const RISK_BAND = { low: "Low", medium: "Medium", high: "High" };
const IDENTITY_STATUS = { match: "Matched the identity photo", mismatch: "Did NOT match the identity photo", unknown: "Not checked" };

function fmtWhen(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// Section heading with a small brand tick + generous spacing.
function heading(doc, label) {
  doc.moveDown(6);
  doc.ensure(28);
  doc.text(label, { size: 13, bold: true, color: INK, gap: 2 });
  doc.hr({ gapBefore: 2, gapAfter: 10 });
}

function labelValue(doc, label, value) {
  doc.ensure(16);
  const y = doc.y;
  doc._line(doc.left, y - 10, label, 10, false, MUTED);
  doc._line(doc.left, y - 10, String(value == null || value === "" ? "—" : value), 10, true, INK, "right", doc.contentWidth);
  doc.y -= 18;
}

function warningLine(doc, text) {
  doc.ensure(20);
  doc.text(text, { size: 10, bold: true, color: WARN, gap: 6 });
}

function identityStatusLabel(identityMatch) {
  return IDENTITY_STATUS[identityMatch?.status] || IDENTITY_STATUS.unknown;
}

// §1: the verdict banner — drawn full-bleed at the very top of the first page, above
// the brand header band. Color-coded so a recruiter reads the call before anything else.
function verdictBanner(doc, topY, verdict) {
  const bandH = 60;
  const color = VERDICT_COLORS[verdict.verdict] || VERDICT_COLORS.REVIEW;
  doc._fill(0, topY, doc.pageWidth, bandH, color);
  doc._line(doc.left, topY - 22, `VERDICT: ${VERDICT_LABELS[verdict.verdict] || verdict.verdict}`, 15, true, [1, 1, 1]);
  doc._line(doc.left, topY - 39, verdict.reason, 10, false, [1, 1, 1]);
  doc._line(doc.left, topY - 53, `Confidence: ${verdict.confidence}`, 9, true, [0.92, 0.95, 1]);
  return topY - bandH;
}

function brandHeaderBand(doc, topY, report) {
  const bandH = 66;
  doc._fill(0, topY, doc.pageWidth, bandH, BRAND);
  doc._line(doc.left, topY - 30, "AI Interview Report", 20, true, [1, 1, 1]);
  const sub = `${report.candidate?.name || "Candidate"}${report.job?.title ? "  ·  " + report.job.title : ""}`;
  doc._line(doc.left, topY - 50, sub, 11, false, [0.82, 0.86, 0.94]);
  return topY - bandH;
}

// §3: prominent, un-buried validity badge — every numeric score downstream is either
// real or explicitly a placeholder; this is where the recruiter learns which.
function validityBadge(doc, iv) {
  doc.ensure(20);
  if (iv.recommendedAction?.suppressed) {
    doc.text("Interview summary scores and automated recommendation are withheld. Review the recorded evidence before deciding the next step.", { size: 9, color: MUTED, gap: 8 });
  } else if (iv.engine === "fallback") {
    doc.text(
      "FALLBACK ENGINE — the real AI evaluation did not run. Every score below is a PLACEHOLDER from answer-completeness heuristics, not a real evaluation. A human must review the transcript directly.",
      { size: 10, bold: true, color: WARN, gap: 8 }
    );
  } else {
    doc.text("Real AI evaluation engine ran for this interview.", { size: 9, color: MUTED, gap: 8 });
  }
}

function buildReportPdf(report) {
  const doc = new PdfDoc();
  const iv = report.hasInterview ? report.interview || {} : null;

  let topY = doc.pageHeight;
  if (iv?.verdict) topY = verdictBanner(doc, topY, iv.verdict);
  topY = brandHeaderBand(doc, topY, report);
  doc.y = topY - 22;

  if (iv) validityBadge(doc, iv);

  // --- Overview ---
  labelValue(doc, "Candidate", report.candidate?.name);
  if (report.candidate?.email) labelValue(doc, "Email", report.candidate.email);
  if (report.job?.title) labelValue(doc, "Position", report.job.title + (report.job.department ? ` (${report.job.department})` : ""));
  labelValue(doc, "Current stage", report.stageLabel || report.stage);
  if (report.decisionTrail) {
    labelValue(
      doc,
      "Decided by",
      `${report.decisionTrail.by || "system"} · ${fmtWhen(report.decisionTrail.at)}${report.decisionTrail.note ? " — " + report.decisionTrail.note : ""}`
    );
  }

  // One label map for the whole document, so no section prints a bare "c5".
  const criterionLabels = Object.fromEntries((report.coverage?.rows || []).map((r) => [r.criterionId, r.label]));

  if (!report.hasInterview) {
    heading(doc, "Interview status");
    doc.text(
      "This candidate has not completed the AI interview yet. The full evaluation and transcript will appear here once the interview is finished.",
      { size: 11, color: MUTED }
    );
    // Coverage spans résumé + assessment, so it is meaningful with no interview.
    coverageSection(doc, report.coverage);
    // The assessment often completes before the interview — show what exists.
    assessmentSection(doc, report.assessment, criterionLabels);
    footer(doc, report);
    return doc.render();
  }

  // Above everything else: a degraded session invalidates what follows it.
  sessionQualitySection(doc, iv.sessionQuality);

  // §4: identity + duration flags surfaced immediately, not buried in Integrity.
  labelValue(doc, "Identity check", identityStatusLabel(report.proctoring?.identityMatch));
  if (iv.durationFlag?.abnormallyShort) {
    warningLine(
      doc,
      `Abnormally short session — averaging ${iv.durationFlag.secondsPerQuestion}s per question (${iv.durationFlag.totalSeconds}s total for ${iv.questionCount} questions).`
    );
  }

  const ev = iv.evaluation;

  labelValue(doc, "Interview status", String(iv.status || "Unknown").replace(/_/g, " "));
  labelValue(doc, "Format", iv.modality === "voice" ? "Voice (spoken answers)" : "Text");
  labelValue(doc, "Engine", iv.engine === "fallback" ? "Deterministic fallback (external AI not used)" : "AI");
  labelValue(doc, "Questions recorded", iv.questionCount);
  labelValue(doc, "Planned question maximum", iv.maxQuestions);
  if (iv.startedAt) labelValue(doc, "Started", fmtWhen(iv.startedAt));
  if (iv.completedAt) labelValue(doc, "Completed", fmtWhen(iv.completedAt));
  if (iv.substance) {
    labelValue(doc, "Attempted answer segments", iv.substance.totalAnswers);
    labelValue(doc, "Segments meeting word-count check", iv.substance.responsiveCount);
    doc.text("This word-count check does not establish correctness or count unique questions.", { size: 9, color: MUTED, gap: 6 });
  }
  // Rule 5 — uncertainty is visible on the PDF, not only on the screen. A printed score with no
  // indication of how much of the interview it covers is the version most likely to end up in
  // front of someone with no access to the transcript behind it.
  if (iv.substance?.declinedCount > 0) {
    labelValue(
      doc,
      "Declined questions",
      `${iv.substance.declinedCount} (asked, candidate stated they could not answer — excluded from the scores below)`
    );
  }
  if (iv.endedEarly) {
    labelValue(doc, "Ended early", "By the candidate — the interview was not completed and no automated recommendation applies");
  }
  if (iv.abandoned) {
    labelValue(
      doc,
      "Left unfinished",
      "The interview link expired before the candidate returned. Whether they stopped or a technical fault stopped them is not knowable from this record — no automated recommendation applies"
    );
  }
  if (iv.integrityTerminated) {
    labelValue(
      doc,
      "Auto-submitted",
      "Ended automatically after repeated proctoring integrity flags (camera/identity/device signals) — a human must review the transcript and flagged signals before any decision is made"
    );
  }

  // --- Evaluation ---
  heading(doc, "Evaluation");
  if (ev) {
    if (RECOMMENDATION[ev.recommendation]) {
      // Never render the raw "review" enum here — the verdict banner above is the
      // single source of truth for the headline call; this row only ever shows a
      // real hire-signal recommendation.
      labelValue(doc, "Recommendation", RECOMMENDATION[ev.recommendation]);
    }
    const isFallback = ev.generatedBy === "fallback";
    doc.moveDown(2);
    doc.text(ev.overallScore == null ? "Overall score: not available" : `Overall score: ${ev.overallScore}/100${isFallback ? "  (PLACEHOLDER)" : ""}`, {
      size: 14,
      bold: true,
      color: isFallback ? MUTED : INK,
      gap: 8,
    });

    if (iv.competencyTriplet) {
      doc.scoreBar("Communication", iv.competencyTriplet.communication);
      doc.scoreBar("Technical knowledge", iv.competencyTriplet.technicalKnowledge);
      doc.scoreBar("Problem solving", iv.competencyTriplet.problemSolving);
    } else {
      doc.text(
        isFallback
          ? "Communication / Technical knowledge / Problem solving: PLACEHOLDER — not a real evaluation (deterministic fallback)."
          : "Communication / Technical knowledge / Problem solving: not separately measured for this interview.",
        { size: 10, color: MUTED, gap: 8 }
      );
    }

    if (ev.summary) {
      doc.moveDown(4);
      doc.text("Summary", { size: 10, bold: true, color: MUTED, gap: 3 });
      doc.text(ev.summary, { size: 11, color: INK });
    }
    bulletList(doc, "Strengths", ev.strengths);
    bulletList(doc, "Weaknesses", ev.weaknesses);
    bulletList(doc, "Skills to probe", ev.missingSkills);

    spokenCommunicationSection(doc, ev);

    doc.moveDown(6);
    doc.text(
      `Generated by ${ev.generatedBy === "fallback" ? "deterministic fallback (AI provider not configured)" : "AI"}` +
        (ev.generatedAt ? ` · ${fmtWhen(ev.generatedAt)}` : ""),
      { size: 9, color: MUTED }
    );
  } else {
    doc.text("Evaluation not available yet.", { size: 11, color: MUTED });
  }

  // --- Evidence coverage: what the role required vs what was actually tested ---
  coverageSection(doc, report.coverage);

  // --- Answer-by-answer quality (makes a run of dead turns visible) ---
  turnQualitySection(doc, iv.sessionQuality);

  // --- Claim Verification (Phase 8) — "is this résumé true?", at a glance ---
  claimVerificationSection(doc, report.claimVerification);

  // --- Skills Assessment (A3.5) — the pre-interview assessment leg, with the
  // provenance that makes its number defensible ---
  assessmentSection(doc, report.assessment, criterionLabels);

  // --- Integrity / proctoring (secondary — after the competency verdict) ---
  integritySection(doc, report.proctoring, report.evidenceClips);

  // --- Transcript ---
  heading(doc, "Transcript");
  const turns = iv.transcript || [];
  if (turns.length === 0) {
    doc.text("No transcript recorded.", { size: 11, color: MUTED });
  } else {
    for (const t of turns) {
      if (!t.text) continue;
      const metaParts = [];
      if (t.role === "candidate" && t.wordCount != null) {
        const dur = t.durationSec != null ? `${t.durationSec}s` : "duration unknown";
        metaParts.push(`${t.wordCount} word${t.wordCount === 1 ? "" : "s"} · ${dur} · ${t.responsive ? "Responsive" : "Non-responsive"}`);
      }
      // The PDF cannot play audio; it only notes that some exists. Playback (and every play of
      // it) lives in the dashboard — see EvidenceClip's identical note for proctoring footage.
      if (t.hasAudio) metaParts.push("Audio recorded for this answer — play it in the dashboard (audit-logged)");
      doc.bubble(t.role, t.text, t.answerScore, { meta: metaParts.length ? metaParts.join(" · ") : null });
    }
  }

  // §5: recommended next action, stated explicitly, right before the footer.
  recommendedActionLine(doc, iv.recommendedAction);

  footer(doc, report);
  return doc.render();
}

// Spoken communication, printed only when this role's approved rubric declared that it is
// assessed and a human recorded why.
//
// The justification is printed WITH the scores, not linked from them. This is the artefact that
// gets produced in a discrimination claim, and the question it will be asked is "why was this
// candidate assessed on how they explained things?" — an answer that lives on a different screen
// is not on the document.
//
// An earlier version of this section printed "Delivery (voice)" and "Confidence (voice)" derived
// from pace, filler rate and hesitation, under a caveat telling the reader to weigh them lightly.
// That caveat was the tell: a score bar you have to disclaim does not belong here. The inputs are
// now transcript-only (utils/communication.js) and there is nothing left to disclaim.
function spokenCommunicationSection(doc, ev) {
  if (ev.delivery == null && ev.confidence == null) return;
  doc.moveDown(6);
  doc.text("Spoken communication — assessed for this role", { size: 9, bold: true, color: MUTED, gap: 4 });
  if (ev.delivery != null) doc.scoreBar("Clarity", ev.delivery);
  if (ev.confidence != null) doc.scoreBar("Calibration", ev.confidence);
  doc.text(
    "Measured from the transcript only — never from pace, accent, hesitation or filler words. " +
      "Clarity: did the answer address the question, concretely and followably. Calibration: did " +
      "they distinguish what they knew from what they did not — saying so counts in their favour." +
      (ev.spokenCommunication?.answersScored != null
        ? ` Over ${ev.spokenCommunication.answersScored} answer${ev.spokenCommunication.answersScored === 1 ? "" : "s"}.`
        : ""),
    { size: 8, color: MUTED }
  );
  if (ev.spokenCommunication?.justification) {
    doc.text(`Why this role assesses it: ${ev.spokenCommunication.justification}`, { size: 8, color: MUTED });
  }
  doc.text("Not part of the overall score. It cannot decline a candidate on its own.", { size: 8, color: MUTED });
}

// Phase 8.6 — Claim Verification: each probed résumé claim with its verdict,
// the résumé quote and the transcript quote side by side, plus the pre→post
// score delta the verdicts produced. Hidden entirely when the loop didn't run.
const PROBE_VERDICT = {
  verified: { label: "VERIFIED in interview", color: [0.11, 0.6, 0.4] },
  contradicted: { label: "CONTRADICTED in interview", color: [0.86, 0.15, 0.15] },
  inconclusive: { label: "INCONCLUSIVE", color: [0.85, 0.55, 0.06] },
};

function claimVerificationSection(doc, cv) {
  if (!cv || !Array.isArray(cv.probes) || cv.probes.length === 0) return;
  heading(doc, "Claim Verification");

  if (cv.scoreDelta) {
    const d = cv.scoreDelta.delta;
    const sign = d > 0 ? "+" : "";
    doc.text(
      `Screening score ${cv.scoreDelta.pre.overallScore} → ${cv.scoreDelta.post.overallScore} after the interview (${sign}${d} points from claim verdicts).`,
      { size: 11, bold: true, color: INK, gap: 8 }
    );
  }

  for (const p of cv.probes) {
    doc.ensure(48);
    const v = p.verdict ? PROBE_VERDICT[p.verdict] : null;
    doc.text(v ? v.label : p.status === "asked" ? "Asked — verdict pending" : "Not covered in this interview", {
      size: 10,
      bold: true,
      color: v ? v.color : MUTED,
      gap: 2,
    });
    if (p.resumeQuote) doc.text(`Resume: "${p.resumeQuote}"`, { size: 9, color: MUTED, indent: 4, gap: 2 });
    doc.text(`Asked: ${p.question}`, { size: 9, color: INK, indent: 4, gap: 2 });
    if (p.answerQuote) doc.text(`Answer: "${p.answerQuote}"`, { size: 9, color: INK, indent: 4, gap: 2 });
    if (p.verdictReasoning) doc.text(p.verdictReasoning, { size: 8, color: MUTED, indent: 4, gap: 6 });
    else doc.moveDown(4);
  }

  doc.text(
    "A contradicted claim is evidence for a human reviewer, never an automatic rejection — both quotes are shown so you can judge the exchange yourself.",
    { size: 8, color: MUTED }
  );
}

// A3.5 — Skills Assessment: the pre-interview assessment result, or the
// recruiter's explicit skip. Hidden entirely when the engine never touched this
// candidate. Every number ships with its provenance: the difficulty tier and the
// exact basis it was derived from, per-criterion counts against the frozen
// rubric, targeted résumé-claim verdicts, and the scorer version +
// reproducibility hash that let anyone re-derive the score.
// ---------------------------------------------------------------------------
// The role, by what we can prove (screen parity: admin/src/pages/InterviewReport.jsx RoleMap)
// ---------------------------------------------------------------------------
// One row per requirement, heaviest first — coverage.rows arrives from the backend
// already sorted by weight, so the ordering is the rubric's own, not a print choice.
// Bar width = share of the rubric, on the SAME non-normalised scale as the screen: a
// 40% requirement fills 40% of the track, so weight is comparable at a glance instead
// of read one percentage at a time. This used to be grouped by verdict bucket instead
// ("What We Actually Know") — a second, reshuffled read of the same rows the screen's
// role map already showed sorted by weight. Reshaped to match, not just renamed.
const BUCKET_PDF = {
  proven: { label: "PROVEN", accent: [0.02, 0.59, 0.41] },
  failed: { label: "FAILED", accent: [0.86, 0.15, 0.15] },
  insufficient: { label: "NOT TESTED", accent: [0.55, 0.58, 0.63] },
};

// C5 — mirrors UNTESTED_CAUSE_COPY on the screen; screen, API and PDF must agree.
const UNTESTED_CAUSE_PDF = {
  resume_silent: "Why untested: their CV didn't mention it, so there was no claim to test.",
  no_probe_slot: "Why untested: we ran out of interview questions before we got to it.",
  asked_audio_failed: "Why untested: we asked, but the audio broke on the answer.",
  asked_unresolved: "Why untested: we asked, but the answer didn't settle it.",
  anchor_only: "Why untested: it came up when we asked about their CV, but wasn't formally tested.",
};

function coverageRow(doc, r) {
  const meta = BUCKET_PDF[r.bucket] || BUCKET_PDF.insufficient;
  const w = Math.round((r.weight || 0) * 100);
  doc.moveDown(6);
  doc.ensure(50);

  doc.text(sanitize(r.label), { size: 11, bold: true, color: INK, gap: 2 });

  // Weight and verdict share one short line — both fixed-width, safe to align without
  // wrapping, unlike the label above which can run long.
  doc.ensure(13);
  const y = doc.y;
  doc._line(doc.left, y - 9, `${w}% of role`, 9, false, MUTED);
  doc._line(doc.left, y - 9, meta.label, 9, true, meta.accent, "right", doc.contentWidth);
  doc.y -= 13;

  const barH = 6;
  doc.ensure(barH + 8);
  doc._fill(doc.left, doc.y, doc.contentWidth, barH, [0.92, 0.93, 0.95]);
  const barW = (doc.contentWidth * w) / 100;
  if (barW > 0.5) doc._fill(doc.left, doc.y, barW, barH, meta.accent);
  doc.y -= barH + 8;

  doc.text(r.evidence, { size: 9, color: MUTED, lineGap: 1 });
  // C5 — an untested requirement states its cause here too.
  if (r.untestedCause && UNTESTED_CAUSE_PDF[r.untestedCause]) {
    doc.text(UNTESTED_CAUSE_PDF[r.untestedCause], { size: 8, color: MUTED, lineGap: 1 });
  }
  // C4 — the loop, verbatim: what the CV said, what we asked, what they answered.
  if (r.decidingProbe?.answerQuote) {
    if (r.decidingProbe.resumeQuote) {
      doc.text(`CV said: "${r.decidingProbe.resumeQuote}"`, { size: 8, color: MUTED, indent: 6, lineGap: 1 });
    } else if (r.decidingProbe.isGap) {
      doc.text("CV said: nothing about this", { size: 8, color: MUTED, indent: 6, lineGap: 1 });
    }
    if (r.decidingProbe.question) {
      doc.text(`We asked: "${r.decidingProbe.question}"`, { size: 8, color: MUTED, indent: 6, lineGap: 1 });
    }
    doc.text(`They said: "${r.decidingProbe.answerQuote}"`, { size: 8, color: MUTED, indent: 6, lineGap: 1 });
  }
}

function coverageSection(doc, coverage) {
  if (!coverage?.rows?.length) return;
  heading(doc, "The role, by what we can prove");
  doc.text(
    `${coverage.rows.length} requirement${coverage.rows.length === 1 ? "" : "s"} for this role` +
      (coverage.rubricVersion != null ? ` (rubric v${coverage.rubricVersion})` : "") +
      " — heaviest first. Bar width is that requirement's weight in the role.",
    { size: 9, color: MUTED, gap: 4 }
  );

  for (const r of coverage.rows) coverageRow(doc, r);

  // Named as the TOTAL of the rows above rather than a second chart of the same
  // data — screen parity with <EvidenceStack>.
  const b = coverage.buckets || {};
  const summaryParts = ["proven", "failed", "insufficient"]
    // `pct` comes from the coverage engine, which is now the only place it is computed — printing
    // `Math.round(w * 100)` here while the screen printed `w / total` is how the two surfaces
    // started disagreeing about one payload. See interviewReportEngine.bucketPercents.
    .map((k) => ({ key: k, w: b[k]?.weight || 0, pct: b[k]?.pct || 0, n: b[k]?.rows?.length || 0 }))
    .filter((s) => s.w > 0)
    .map((s) => `${BUCKET_PDF[s.key].label} ${s.pct}% (${s.n} req${s.n === 1 ? "" : "s"})`);
  if (summaryParts.length) {
    doc.moveDown(6);
    doc.text(`Summed by verdict — ${summaryParts.join("   ·   ")}`, { size: 9, bold: true, color: MUTED, gap: 4 });
  }

  const t = coverage.totals;

  // The "claimed vs demonstrated" sentence used to print here, from
  // `interviewReportEngine.movementSentence`. It came out when the admin screen
  // dropped its cross-instrument comparison: a PDF that leads with a subtraction
  // the screen does not show is the drift this file's opening note exists to
  // prevent, just pointing the other way. The engine still computes `movement`
  // on every coverage row — nothing was deleted from the payload — so restoring
  // this is one line if the comparison is ever wanted back.

  if (t?.underpoweredCriteria > 0) {
    doc.text(
      `${t.underpoweredCriteria} of ${t.criteria} requirements were tested with fewer than ${t.minItemsForCall} items and never probed in the interview. That is too little to score either way — on a handful of multiple-choice items a wrong answer is indistinguishable from a guess. Widen the paper or probe these live before treating them as weaknesses.`,
      { size: 8, color: MUTED, gap: 6 }
    );
  }

  // C5's hand-off, in print form: the screen offers this as a copy-to-clipboard
  // button (interactive, so it can't travel into a downloaded PDF); here it is
  // simply printed, which is the more useful form for an artefact meant to be
  // handed to the next interviewer.
  if (b.insufficient?.rows?.length > 0) {
    doc.text("Questions for the next round — things this role needs that the interview could not test:", {
      size: 9,
      bold: true,
      color: MUTED,
      gap: 4,
    });
    b.insufficient.rows.forEach((r, i) => {
      doc.ensure(20);
      doc.text(`${i + 1}. ${r.label} — ask what hands-on work they have done here, if any; a specific example is ideal.`, {
        size: 9,
        color: INK,
        indent: 4,
        lineGap: 2,
      });
    });
  }
}

// §3 rule 5 — the degraded-session label travels with the report into print.
function sessionQualitySection(doc, quality) {
  if (!quality?.degraded) return;
  doc.ensure(50);
  doc.moveDown(6);
  const top = doc.y;
  doc._fill(doc.left, top, doc.contentWidth, 3, [0.85, 0.55, 0.06]);
  doc.y -= 8;
  doc.text("DEGRADED SESSION — RECOMMENDATION WITHHELD", { size: 11, bold: true, color: [0.7, 0.45, 0.05], gap: 3 });
  for (const r of quality.reasons) {
    doc.text(`•  ${sanitize(r)}`, { size: 10, color: INK, indent: 4, lineGap: 2 });
  }
  doc.text(
    "On a broken audio signal an unanswered question cannot be told apart from an unheard one. Scores in this report are shown for transparency and are not a measure of this candidate.",
    { size: 9, color: MUTED, gap: 4 }
  );
  doc._fill(doc.left, doc.y + 2, doc.contentWidth, 1, [0.9, 0.91, 0.93]);
  doc.moveDown(6);
}

// Answer-by-answer quality strip — the view that makes a run of near-silent
// answers visible instead of averaging it into one number.
function turnQualitySection(doc, quality) {
  if (!quality?.perTurn?.length) return;
  heading(doc, "Answer-by-Answer Quality");
  doc.text(`${quality.degradedCount} of ${quality.total} answers show a degraded audio signature.`, {
    size: 9,
    color: MUTED,
    gap: 6,
  });

  const barW = 9;
  const gap = 3;
  const maxH = 42;
  const perRow = Math.floor(doc.contentWidth / (barW + gap));
  const rows = [];
  for (let i = 0; i < quality.perTurn.length; i += perRow) rows.push(quality.perTurn.slice(i, i + perRow));

  for (const group of rows) {
    doc.ensure(maxH + 16);
    const baseline = doc.y - maxH;
    group.forEach((t, i) => {
      const x = doc.left + i * (barW + gap);
      doc._fill(x, doc.y, barW, maxH, [0.94, 0.95, 0.96]);
      const h = Math.max(2, Math.min(maxH, ((t.answerScore ?? 0) / 100) * maxH));
      doc._fill(x, baseline + h, barW, h, t.degraded ? [0.86, 0.15, 0.15] : BRAND);
      // Secondary encoding, so the flag survives greyscale printing.
      if (t.degraded) doc._line(x, baseline - 9, "!", 7, true, [0.86, 0.15, 0.15], "center", barW);
    });
    doc.y -= maxH + 14;
  }
  doc.text("Bar height = answer score.  ! = degraded audio signature.", { size: 8, color: MUTED });
}

const ASSESSMENT_VERDICT = {
  verified: { label: "VERIFIED by assessment", color: [0.11, 0.6, 0.4] },
  contradicted: { label: "CONTRADICTED by assessment", color: [0.86, 0.15, 0.15] },
  inconclusive: { label: "INCONCLUSIVE", color: [0.85, 0.55, 0.06] },
};
const TIER_SOURCE = {
  claim_derived: "derived from résumé claims",
  recruiter_override: "set by the recruiter",
  paper_fixed: "fixed for this paper",
};
const SESSION_STATUS = {
  scheduled: "Invitation sent — not started yet",
  in_progress: "In progress",
  paused: "Paused (integrity soft-lock — awaiting human review)",
  completed: "Completed",
  expired: "Window expired",
  cancelled: "Cancelled by the recruiter",
};

function assessmentSection(doc, a, criterionLabels = {}) {
  if (!a) return;
  const labelFor = (id) => criterionLabels[id] || id;
  heading(doc, "Skills Assessment");

  // An explicit skip is a recorded human decision, not a missing assessment.
  if (a.decision?.action === "skipped") {
    doc.text(
      `Skipped by ${a.decision.byName || "a recruiter"} on ${fmtWhen(a.decision.at)} — this candidate was sent directly to the AI interview. This is a recorded human decision, not a gap in the data.`,
      { size: 11, color: INK }
    );
    return;
  }

  if (!a.session) {
    doc.text("An assessment decision was recorded but no session exists yet.", { size: 11, color: MUTED });
    return;
  }

  const t = a.session.difficultyTier;
  if (t) {
    doc.text(
      `Difficulty: ${t.value.toUpperCase()} — ${TIER_SOURCE[t.source] || t.source}${t.basis ? ` (${t.basis})` : ""}`,
      { size: 10, bold: true, color: INK, gap: 6 }
    );
  }

  const r = a.session.result;
  if (!r) {
    // Live-but-unscored renders as its status — never as a placeholder score.
    doc.text(`Status: ${SESSION_STATUS[a.session.status] || a.session.status}. No scored result yet.`, { size: 11, color: MUTED });
    return;
  }

  doc.text(`Score: ${r.totalCorrect}/${r.totalItems} items correct`, { size: 14, bold: true, color: INK, gap: 4 });
  if (r.completedBy === "expiry") {
    warningLine(doc, "PARTIAL — the window closed before the candidate submitted; only the work completed by then is scored. Treat as incomplete evidence.");
  }
  if (r.completedBy === "integrity_violation") {
    warningLine(doc, "AUTO-SUBMITTED — the assessment was ended automatically after repeated integrity-check flags; only the work completed by then is scored. Review the flagged signals before drawing any conclusion.");
  }

  if (Array.isArray(r.perCriterion) && r.perCriterion.length > 0) {
    doc.moveDown(2);
    doc.text("By rubric criterion", { size: 10, bold: true, color: MUTED, gap: 3 });
    for (const c of r.perCriterion) {
      doc.text(`•  ${sanitize(labelFor(c.criterionId))} — ${c.correctCount}/${c.itemCount}`, { size: 11, color: INK, indent: 4, lineGap: 3 });
    }
  }

  if (Array.isArray(r.claimVerdicts) && r.claimVerdicts.length > 0) {
    doc.moveDown(4);
    doc.text("Résumé-claim verdicts (items targeted at unproven claims)", { size: 10, bold: true, color: MUTED, gap: 3 });
    for (const v of r.claimVerdicts) {
      doc.ensure(24);
      const badge = ASSESSMENT_VERDICT[v.verdict] || ASSESSMENT_VERDICT.inconclusive;
      doc.text(badge.label, { size: 10, bold: true, color: badge.color, gap: 1 });
      doc.text(`${sanitize(labelFor(v.criterionId))} — ${v.correctCount}/${v.itemCount} targeted items correct`, {
        size: 9,
        color: MUTED,
        indent: 4,
        gap: 4,
      });
    }
    doc.text(
      "A contradicted claim is evidence for a human reviewer, never an automatic rejection.",
      { size: 8, color: MUTED, gap: 4 }
    );
  }

  doc.moveDown(4);
  doc.text(
    `Scored ${fmtWhen(r.scoredAt)} · scorer ${r.scorerVersion || "—"} · reproducibility ${String(r.reproducibilityHash || "").slice(0, 16) || "—"}…  ` +
      "The score was computed deterministically by code from the frozen answer key — no AI in the scoring path. The hash lets an auditor re-derive this exact score from the archived paper and responses.",
    { size: 8, color: MUTED }
  );
}

// §5: explicit action verb + one-line justification, the last thing before the footer.
function recommendedActionLine(doc, action) {
  if (!action) return;
  doc.ensure(76);
  doc.moveDown(6);
  doc.hr({ gapAfter: 6 });
  // A withheld recommendation is labelled as withheld, not printed as a decision.
  if (action.suppressed) {
    doc.text(`Recommendation withheld — ${action.action}`, { size: 12, bold: true, color: WARN, gap: 2 });
    doc.text(action.justification, { size: 10, color: MUTED });
    return;
  }
  doc.text(`Recommended action: ${action.action}`, { size: 12, bold: true, color: INK, gap: 2 });
  doc.text(action.justification, { size: 10, color: MUTED });
}

// Integrity / proctoring block. Advisory — states plainly that it's for human judgement, not an
// automated decision. Hidden entirely when no proctoring data was recorded. Uses the
// identity-gated display risk (§8) rather than the raw score, and shows a plausible
// benign explanation per flag so recruiters don't over-anchor on "High".
function integritySection(doc, p, evidenceClips) {
  if (!p) return;
  heading(doc, "Integrity & Proctoring");

  if (p.bandWithheld) {
    // B1: no band over a broken recording — the PDF is the artefact a dispute reads, so the
    // withholding (and its reason) must be printed, not just shown on screen.
    labelValue(doc, "Integrity risk", "Band withheld — technical fault on our side");
    if (p.bandWithheldReason) doc.text(p.bandWithheldReason, { size: 8, color: MUTED, gap: 4 });
  } else {
    labelValue(doc, "Integrity risk", `${p.displayRiskScore ?? 0}/100  (${RISK_BAND[p.displayRiskBand] || "Low"})`);
  }
  if (p.collapsedNote) doc.text(p.collapsedNote, { size: 8, color: MUTED, gap: 4 });
  if (p.identityGateNote) {
    doc.text(p.identityGateNote, { size: 9, bold: true, color: WARN, gap: 6 });
  }
  if (p.identityMatch?.status) labelValue(doc, "Identity check", identityStatusLabel(p.identityMatch));
  labelValue(doc, "Camera monitoring", p.visionEnabled ? "On (in-browser face detection)" : "Off (browser signals only)");
  if (p.consent) {
    labelValue(doc, "Candidate consent", p.consent.given ? "Given" : p.consent.declined ? "Declined" : "—");
  }
  labelValue(doc, "Total flags", String(p.totalEvents ?? 0));

  if (Array.isArray(p.breakdown) && p.breakdown.length > 0) {
    doc.moveDown(4);
    doc.text("Flags recorded", { size: 10, bold: true, color: MUTED, gap: 3 });
    for (const row of p.breakdown) {
      // A row that measures OUR camera view rather than the candidate is labelled as such here too.
      // The screen, the API and the PDF have to agree: rendering an unobservable stretch of the
      // session with a severity beside it invites a reader to treat it as a finding.
      const qualifier =
        row.scored === false
          ? "not scored — recording conditions"
          : row.attributedToFault
            ? `${row.severity} — attributed to the technical fault, not the candidate`
            : row.severity;
      doc.text(`•  ${row.label} — ${row.count}× (${qualifier})`, { size: 11, color: INK, indent: 4, lineGap: 3 });
      if (row.benignExplanation) {
        doc.text(row.benignExplanation, { size: 8, color: MUTED, indent: 12, lineGap: 2, gap: 2 });
      }
    }
  }

  // Phase 14.5 — the PDF notes that reviewable evidence exists; the clips
  // themselves play only in the dashboard, where every view is audit-logged.
  if (Array.isArray(evidenceClips) && evidenceClips.length > 0) {
    doc.moveDown(4);
    doc.text(
      `Evidence clips: ${evidenceClips.length} short clip(s) were captured for high-severity flags (consent-gated, event-anchored — never continuous recording). Review them in the dashboard; each view is audit-logged.`,
      { size: 9, bold: true, color: INK }
    );
  }

  doc.moveDown(4);
  doc.text(
    "Integrity flags are advisory signals for a human reviewer — they are not proof of misconduct and never on their own decide an outcome.",
    { size: 9, color: MUTED }
  );
}

function bulletList(doc, title, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  doc.moveDown(4);
  doc.text(title, { size: 10, bold: true, color: MUTED, gap: 3 });
  for (const it of items) {
    if (it == null || it === "") continue;
    doc.text("•  " + it, { size: 11, color: INK, indent: 4, lineGap: 3 });
  }
}

function footer(doc, report) {
  // Page furniture stays inside the reserved bottom margin, never creates an
  // otherwise blank trailing page when flowing content reaches the page edge.
  const current = doc._buf;
  const generated = fmtWhen(new Date());
  doc.pages.forEach((page, index) => {
    doc._buf = page;
    doc._line(doc.left, 32, sanitize(`Confidential - generated ${generated} for internal hiring use.`), 8, false, MUTED);
    doc._line(doc.left, 20, "Handle in line with your data-retention policy.", 8, false, MUTED);
    doc._line(doc.left, 20, `${index + 1} / ${doc.pages.length}`, 8, false, MUTED, "right", doc.contentWidth);
  });
  doc._buf = current;
}

module.exports = { buildReportPdf };
