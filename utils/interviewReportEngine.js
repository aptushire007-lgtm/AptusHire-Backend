// Pure, deterministic logic for the recruiter-facing AI interview report. Nothing here
// touches the DB or mutates a candidate's pipeline stage — every function is a display
// computation over data the interview already produced (turns, evaluation, proctoring).
// The verdict/recommended-action are advisory only; a human still moves the candidate
// via the existing stage-transition endpoint (see services/pipelineService.js).

const MIN_RESPONSIVE_WORDS = 6;
// Fixed and independent of Job.atsThreshold, which gates resume screening — a different
// axis (resume completeness) from demonstrated interview competency.
const INTERVIEW_PASS_THRESHOLD = 60;

function wordCount(text) {
  const s = String(text || "").trim();
  if (!s) return 0;
  return s.split(/\s+/).filter(Boolean).length;
}

// Every filler example in the report spec ("hello", "don't know", "two days", "I want
// tell.") is under 6 words, so the word-count threshold alone catches them — no extra
// stoplist needed.
function isResponsive(text, minWords = MIN_RESPONSIVE_WORDS) {
  return wordCount(text) >= minWords;
}

// §2: per-answer word count / spoken duration / responsive tag, plus the aggregate
// recruiters scan first ("Responsive answers: X / N").
// A DECLINED turn ("I don't know") is separated out rather than counted as a non-responsive
// answer, and that distinction decides outcomes — see computeVerdict, which rejects on a
// responsiveness ratio below 50%. Left in the denominator, three honest declines out of four
// questions would produce a CLEAR_REJECT at High confidence: an automated adverse decision whose
// entire evidence is that the candidate said "I don't know" instead of bluffing.
//
// They are still reported — `declinedCount` is returned and surfaced — just not scored as failed
// attempts to answer, because they were not attempts.
function computeAnswerSubstance(turns) {
  const candidateTurns = (turns || []).filter((t) => t.role === "candidate");
  const answers = candidateTurns.map((t) => {
    const text = t.text || "";
    const durationSec = t.audioDurationMs != null ? Math.round(t.audioDurationMs / 1000) : null;
    return {
      text,
      wordCount: wordCount(text),
      durationSec,
      declined: Boolean(t.declined),
      // A decline is neither responsive nor non-responsive — it is outside the question the
      // responsiveness measure asks. Flagged false so nothing downstream counts it as engagement,
      // and excluded from the denominator below so nothing counts it as a failure either.
      responsive: t.declined ? false : isResponsive(text),
    };
  });
  const attempted = answers.filter((a) => !a.declined);
  return {
    answers,
    responsiveCount: attempted.filter((a) => a.responsive).length,
    totalAnswers: attempted.length,
    declinedCount: answers.length - attempted.length,
  };
}

// §4: flags a session that's too short to be a real read on the candidate.
function computeDurationFlag({ startedAt, completedAt, questionCount }) {
  if (!startedAt || !completedAt || !questionCount) {
    return { abnormallyShort: false, secondsPerQuestion: null, totalSeconds: null };
  }
  const totalSeconds = Math.max(0, (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000);
  const secondsPerQuestion = totalSeconds / questionCount;
  return { abnormallyShort: secondsPerQuestion < 60, secondsPerQuestion: Math.round(secondsPerQuestion), totalSeconds: Math.round(totalSeconds) };
}

// §9: heuristic competency classifier (nice-to-have — not a scored ground truth).
// Checked in this order so the more specific categories win over generic "backend" hits.
const COMPETENCY_KEYWORDS = [
  ["system_design", ["architecture", "system design", "trade-off", "tradeoff", "scalability", "scale to", "design data storage", "high traffic"]],
  ["database", ["database", "data storage", "read traffic", "sql", "mongo", "postgres", "mysql", "schema", "query", "nosql"]],
  ["debugging", ["debug", "debugging", "troubleshoot", "bug you", "never seen before"]],
  ["learning", ["learn a new", "learning", "quickly", "upskill"]],
  ["backend", ["api", "endpoint", "backend", "back-end", "server", "microservice", "node", "express"]],
  ["frontend", ["frontend", "front-end", "react", "vue", "angular", "css", "html", "component", "browser", "dom", "ui"]],
];

function mapCompetency(topic, questionText) {
  const haystack = `${topic || ""} ${questionText || ""}`.toLowerCase();
  for (const [label, keywords] of COMPETENCY_KEYWORDS) {
    if (keywords.some((k) => haystack.includes(k))) return label;
  }
  return "general";
}

function truncate(str, max) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Pairs each interviewer question with the candidate's next answer, tags the
// competency it probes, and carries a short quoted snippet as evidence.
function buildCompetencyTable(turns) {
  const list = turns || [];
  const rows = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t.role !== "ai" || t.kind !== "question") continue;
    const answer = list.slice(i + 1).find((x) => x.role === "candidate" || x.role === "ai");
    const answerTurn = answer && answer.role === "candidate" ? answer : null;
    rows.push({
      question: t.text,
      competency: mapCompetency(t.topic, t.text),
      score: answerTurn && typeof answerTurn.answerScore === "number" ? answerTurn.answerScore : null,
      evidence: answerTurn ? truncate(answerTurn.text, 140) : null,
    });
  }
  return rows;
}

// §1 + §7: the single source of truth for the headline call. Every branch below is
// stated directly in the report spec — simple and explainable, no black box.
function computeVerdict({
  responsiveCount,
  totalAnswers,
  engineRan,
  overallScore,
  endedEarly,
  halted,
  abandoned,
  integrityTerminated,
  audioUnreliable,
  declinedCount = 0,
}) {
  // WE stopped this interview because the AI interviewer went off-script (utils/agentGuardrail.js).
  // The transcript was not produced under the conditions the instrument specifies, so no automated
  // conclusion may be drawn from it in either direction — and critically, the defect is ours. A
  // candidate must never carry the cost of our agent misbehaving.
  if (halted) {
    return {
      verdict: "REVIEW",
      reason:
        "The interview was stopped automatically because the AI interviewer went outside its approved script. " +
        "This transcript was not produced under valid conditions and is not a measurement of the candidate. " +
        "The fault is on our side — a human must review, and this must not count against them.",
      confidence: "Low",
    };
  }
  // Distinct from `halted` above: THIS interview was ended because of the CANDIDATE's own proctoring
  // signals (camera/identity/device — see AUTO_SUBMIT_TRIGGER_TYPES), not our fault. Still REVIEW,
  // not an automated adverse verdict — the flags are evidence for a human to weigh alongside the
  // partial transcript, never a conclusion this code is entitled to reach on its own — but the
  // wording must not borrow halted's "must not count against them" framing, since this may genuinely
  // be conduct-relevant.
  if (integrityTerminated) {
    return {
      verdict: "REVIEW",
      reason:
        "The interview was ended automatically after repeated proctoring integrity signals, so it did not run " +
        "to completion. A human must review the transcript and the flagged signals before any decision is made.",
      confidence: "Low",
    };
  }
  // RULE 6, AT THE POINT IT ACTUALLY BITES. An interview the candidate ended themselves can never
  // produce an automated adverse verdict here — not CLEAR_REJECT, and not an ADVANCE either.
  // Every branch below reasons from a transcript, and this transcript is short because the
  // candidate exercised an exit, not because they failed. Without this the withdrawal feature
  // would auto-reject the people who used it: no answers recorded is the FIRST branch, at High
  // confidence.
  if (endedEarly) {
    return {
      verdict: "REVIEW",
      reason:
        "The candidate ended the interview before it finished, so most of the instrument was never run. " +
        "A short transcript here is not a measurement of the candidate — a human must review it.",
      confidence: "Low",
    };
  }
  // The link expired with the interview still open (the abandonment sweep closed it). A candidate
  // who gave up and a voice pipeline that failed them produce the identical record, and that is
  // not a distinction this system can make — so, like the two branches above, no automated
  // conclusion is drawn in either direction. Without this branch an abandoned session with no
  // answers would fall through to CLEAR_REJECT at High confidence — an automated adverse verdict
  // whose entire evidence is that somebody stopped showing up, possibly because of our own defect.
  if (abandoned) {
    return {
      verdict: "REVIEW",
      reason:
        "The interview was left unfinished and its link expired, so most of the instrument was never run. " +
        "Whether the candidate stopped or a technical fault stopped them is not knowable from this record — " +
        "a human must review it, and it must not count against them.",
      confidence: "Low",
    };
  }
  // THE FOURTH GUARD, and the same argument as the three above: we could not hear them. A dead
  // microphone, a socket that died, and a person with nothing to say produce the same short
  // transcript, and choosing between those readings is not a judgement this system can make.
  //
  // Without this branch a session whose audio failed falls straight through to
  // `responsiveCount / totalAnswers < 0.5` and returns CLEAR_REJECT at HIGH confidence — an
  // automated adverse verdict whose entire evidence is that OUR audio path stopped working. The
  // caller already suppresses `recommendedAction` on a degraded session, but the verdict itself
  // was passed through untouched, and `services/interviewReportPdf.verdictBanner` prints it
  // full-bleed at the top of page one. That page is the document produced in a discrimination
  // claim, so the fix belongs here, at the decision, rather than at any one place that renders it.
  //
  // DELIBERATELY NARROWER than `computeSessionQuality().degraded`. That flag also rises on
  // "asked to repeat", which is a conduct signal: how often somebody asks for a question again
  // tracks accent, hearing and bandwidth, and it is structurally excluded from every score
  // (invariant 8). It must not move a verdict either — not adversely, and not favourably. See
  // `audioUnreliableFrom` for the signatures that do count.
  if (audioUnreliable) {
    return {
      verdict: "REVIEW",
      reason:
        "The audio failed on enough of this interview that most of what the candidate said was never recorded. " +
        "There is no way to tell 'could not answer' from 'could not hear' in this transcript, so nothing here " +
        "is a measurement of the candidate. The fault is on our side — a human must review, and this must not " +
        "count against them.",
      confidence: "Low",
    };
  }
  if (!totalAnswers) {
    // Declines are excluded from totalAnswers (see computeAnswerSubstance), so an interview
    // consisting entirely of "I don't know" lands here. It is still not a machine's call to
    // reject on: the candidate engaged with every question and told the truth about each one.
    if (declinedCount > 0) {
      return {
        verdict: "REVIEW",
        reason: `The candidate declined all ${declinedCount} question(s) and attempted none. Nothing was measured — a human must review this.`,
        confidence: "Low",
      };
    }
    return { verdict: "CLEAR_REJECT", reason: "No answers were recorded.", confidence: "High" };
  }
  if (responsiveCount === 0) {
    return { verdict: "CLEAR_REJECT", reason: `0/${totalAnswers} answers responsive.`, confidence: "High" };
  }
  if (responsiveCount / totalAnswers < 0.5) {
    return { verdict: "CLEAR_REJECT", reason: `${responsiveCount}/${totalAnswers} answers responsive (below 50%).`, confidence: "High" };
  }
  if (!engineRan) {
    return {
      verdict: "REVIEW",
      reason: "Automated evaluation engine did not run; answers are substantive enough to need human review.",
      confidence: "Medium",
    };
  }
  if (overallScore == null) {
    return { verdict: "REVIEW", reason: "No competency score is available.", confidence: "Low" };
  }
  if (overallScore >= INTERVIEW_PASS_THRESHOLD) {
    return {
      verdict: "ADVANCE",
      reason: `Overall competency score ${overallScore}/100 meets the ${INTERVIEW_PASS_THRESHOLD} threshold.`,
      confidence: overallScore >= INTERVIEW_PASS_THRESHOLD + 15 ? "High" : "Medium",
    };
  }
  if (overallScore <= INTERVIEW_PASS_THRESHOLD - 20) {
    return {
      verdict: "CLEAR_REJECT",
      reason: `Overall competency score ${overallScore}/100 is well below the ${INTERVIEW_PASS_THRESHOLD} threshold.`,
      confidence: "High",
    };
  }
  return {
    verdict: "REVIEW",
    reason: `Overall competency score ${overallScore}/100 is below the ${INTERVIEW_PASS_THRESHOLD} threshold but within human-judgement range.`,
    confidence: "Medium",
  };
}

// §5: an explicit action verb + one-line justification. A REVIEW on a session that's
// itself abnormally short points to a broken/rushed session rather than a true read.
function recommendedAction(verdict, durationFlag) {
  if (verdict.verdict === "CLEAR_REJECT") return { action: "Reject", justification: verdict.reason };
  if (verdict.verdict === "ADVANCE") return { action: "Advance", justification: verdict.reason };
  if (durationFlag && durationFlag.abnormallyShort) {
    return {
      action: "Re-interview",
      justification: "Session ran abnormally short — likely a technical or environment issue rather than a true read on the candidate.",
    };
  }
  return { action: "Manual review", justification: verdict.reason };
}

// §3/§6: communication/technicalKnowledge/problemSolving should never be shown when
// they're identical (that's not three measurements, it's one number copied three times)
// or when any of them is missing. Covers both the deterministic fallback and an
// accidental AI tie.
function competencyTripletOrNull(ev) {
  if (!ev) return null;
  const { communication: c, technicalKnowledge: t, problemSolving: p } = ev;
  if (c == null || t == null || p == null) return null;
  if (c === t && t === p) return null;
  return { communication: c, technicalKnowledge: t, problemSolving: p };
}

// ---------------------------------------------------------------------------
// Evidence coverage matrix
// ---------------------------------------------------------------------------
// One row per rubric criterion; one cell per evidence source (résumé / assessment
// / interview). This is the Claim → Probe → Verdict loop rendered as a grid: what
// the ROLE required, what the résumé CLAIMED, whether we TESTED it, and what the
// test SHOWED. Pure joining over already-scored data — no model runs here and no
// number is invented (§3 rule 1). "Not tested" is a first-class state and is
// never dressed up as a measurement (§3 rule 5).

const CELL = { verified: "verified", partial: "partial", contradicted: "contradicted", absent: "absent", untested: "untested" };

// The résumé leg is already scored per criterion by evidenceScorer.computeAssessment.
const RESUME_CELL = { satisfied: CELL.verified, partial: CELL.partial, contradicted: CELL.contradicted, absent: CELL.absent };

// The assessment leg is a ratio of targeted items. Thresholds are deliberately
// coarse — this is a coverage read, not a score, and a 2/4 must not round to "pass".
function assessmentCell(correctCount, itemCount) {
  if (!itemCount) return CELL.untested;
  const ratio = correctCount / itemCount;
  if (ratio >= 0.8) return CELL.verified;
  if (ratio <= 0.34) return CELL.contradicted;
  return CELL.partial;
}

// --- how much evidence is enough to say anything at all --------------------
// A criterion sliced out of a 20-item paper typically gets 2–4 items. On
// 4-option items, 1-of-3 correct IS the chance baseline — indistinguishable
// from a candidate who guessed, and from one who knew it and was unlucky. So a
// per-criterion FAIL is never asserted from a thin assessment slice alone; it
// requires either a probe a human can read, or a slice big enough to mean
// something. Anything else is reported as "too little evidence", which is a
// statement about OUR test, not about the candidate (§3 rule 5).
const MIN_ITEMS_FOR_CALL = 3;
const MIN_ITEMS_FOR_FAIL = 4;
const FAIL_RATIO = 0.25;

const BUCKET = { proven: "proven", failed: "failed", insufficient: "insufficient" };

// Order matters: a live probe verdict is a human-readable exchange and outranks
// any item ratio, in both directions.
function classify({ probeVerdicts, correctCount, itemCount }) {
  if (probeVerdicts.includes("contradicted")) return BUCKET.failed;
  if (probeVerdicts.includes("verified")) return BUCKET.proven;
  if (itemCount >= MIN_ITEMS_FOR_CALL && correctCount === itemCount) return BUCKET.proven;
  if (itemCount >= MIN_ITEMS_FOR_FAIL && correctCount / itemCount <= FAIL_RATIO) return BUCKET.failed;
  return BUCKET.insufficient;
}

// Plain language, because the recruiter reads this and not the thresholds.
function evidenceSummary({ probeVerdicts, correctCount, itemCount, probeCount, anchorCovered }) {
  const parts = [];
  if (itemCount > 0) parts.push(`${correctCount} of ${itemCount} assessment item${itemCount === 1 ? "" : "s"}`);
  if (probeVerdicts.includes("contradicted")) parts.push("contradicted in the interview");
  else if (probeVerdicts.includes("verified")) parts.push("verified in the interview");
  else if (probeCount > 0) parts.push("probed, no verdict reached");
  else if (anchorCovered) parts.push("came up in the interview via their résumé, not formally tested");
  else parts.push("never probed in the interview");
  return parts.join(" · ");
}

// WHY a requirement went untested — machine-readable, so the report can say the cause instead of
// a flat "never probed" (REPORT-REDESIGN C5). The valence matters: every one of these is a
// statement about OUR instrument or THEIR résumé's silence, never about the candidate's ability.
//   resume_silent      — the CV never mentioned it, so there was no claim to probe
//   no_probe_slot      — the CV claimed it, but the interview ran out of probe slots
//   asked_audio_failed — we asked, and the audio was too broken to assess the answer
//   asked_unresolved   — we asked, but the loop never closed (no verdict)
//   anchor_only        — it came up via a résumé follow-up, which cannot produce a verdict
// null when a probe verdict exists — the requirement WAS tested.
function untestedCauseFor({ probeVerdicts, probeCount, claimed, anchorCovered, audioUnreliable }) {
  if (probeVerdicts.length > 0) return null;
  if (probeCount > 0) return audioUnreliable ? "asked_audio_failed" : "asked_unresolved";
  if (anchorCovered) return "anchor_only";
  return claimed ? "no_probe_slot" : "resume_silent";
}

// A probe with no verdict yet is untested, never "inconclusive" — the loop simply
// has not closed. Multiple probes on one criterion resolve to the worst outcome
// so a single contradiction is never averaged away (§3 rule 4).
const PROBE_CELL = { verified: CELL.verified, contradicted: CELL.contradicted, inconclusive: CELL.partial };
const CELL_SEVERITY = { contradicted: 0, partial: 1, absent: 2, untested: 3, verified: 4 };

function interviewCell(probes) {
  const resolved = probes.map((p) => (p.verdict ? PROBE_CELL[p.verdict] || CELL.partial : CELL.untested));
  if (resolved.length === 0) return CELL.untested;
  return resolved.sort((a, b) => CELL_SEVERITY[a] - CELL_SEVERITY[b])[0];
}

/**
 * @param {object[]} criterionFindings  pre-interview AtsAssessment.criterionFindings
 *                                      (carries id, label, kind, weight, status)
 * @param {object[]} perCriterion       AssessmentSession.result.perCriterion
 * @param {object[]} probes             aiInterview.probes
 * @param {object[]} anchors            aiInterview.resumeAnchors (A1) — a COVERED anchor bound to
 *                                      a criterion moves that cell untested → partial, only.
 * @param {boolean}  audioUnreliable    the verdict-grade audio flag (audioUnreliableFrom) — used
 *                                      solely to name WHY an asked-but-unresolved probe resolved
 *                                      nothing (C5), never to change any cell.
 * @returns {object|null} null when the rubric leg never ran, so older reports render unchanged.
 */
function buildCoverageMatrix({ criterionFindings, perCriterion, probes, anchors, audioUnreliable = false }) {
  const findings = (criterionFindings || []).filter((f) => f && f.criterionId);
  if (findings.length === 0) return null;

  const assessmentBy = new Map((perCriterion || []).map((c) => [c.criterionId, c]));
  const probesBy = new Map();
  for (const p of probes || []) {
    if (!p.criterionId) continue;
    if (!probesBy.has(p.criterionId)) probesBy.set(p.criterionId, []);
    probesBy.get(p.criterionId).push(p);
  }
  // Anchors count only when COVERED — asked-and-answered, not merely sent — and only when bound
  // to a criterion. An anchor is weaker evidence than a probe: it proves the subject came up, not
  // what the answer showed. So it may upgrade untested → partial and do nothing else; verified
  // and contradicted still require a probe verdict with a code-verified quote (A1 cell rule).
  const anchorsBy = new Map();
  for (const a of anchors || []) {
    if (!a || !a.criterionId || a.status !== "covered") continue;
    if (!anchorsBy.has(a.criterionId)) anchorsBy.set(a.criterionId, []);
    anchorsBy.get(a.criterionId).push(a);
  }

  const rows = findings
    .map((f) => {
      const a = assessmentBy.get(f.criterionId);
      const cp = probesBy.get(f.criterionId) || [];
      const coveredAnchors = anchorsBy.get(f.criterionId) || [];
      const anchorCovered = coveredAnchors.length > 0;
      const probeVerdicts = cp.map((p) => p.verdict).filter(Boolean);
      const correctCount = a?.correctCount || 0;
      const itemCount = a?.itemCount || 0;
      // The exchange that drove a failed call, so the row can link to it — a
      // verdict the recruiter cannot read for themselves is not evidence.
      const decidingProbe = cp.find((p) => p.verdict === "contradicted") || cp.find((p) => p.verdict === "verified") || null;
      const claimed = (f.supportingClaimIds || []).length > 0;
      const probedCell = interviewCell(cp);

      return {
        criterionId: f.criterionId,
        // The label is the whole point: a recruiter must never be shown "c5".
        label: f.label || f.criterionId,
        kind: f.kind || "must_have",
        weight: typeof f.weight === "number" ? f.weight : 0,
        claimed,
        resume: RESUME_CELL[f.status] || CELL.absent,
        assessment: a ? assessmentCell(correctCount, itemCount) : CELL.untested,
        assessmentDetail: a ? { correctCount, itemCount } : null,
        interview: probedCell === CELL.untested && anchorCovered ? CELL.partial : probedCell,
        probeCount: cp.length,
        anchorCovered,
        anchorTerms: coveredAnchors.map((x) => x.term),
        bucket: classify({ probeVerdicts, correctCount, itemCount }),
        evidence: evidenceSummary({ probeVerdicts, correctCount, itemCount, probeCount: cp.length, anchorCovered }),
        // WHY this row went untested (C5) — null once any probe verdict exists.
        untestedCause: untestedCauseFor({ probeVerdicts, probeCount: cp.length, claimed, anchorCovered, audioUnreliable }),
        // True when the assessment slice was too thin to support any call on its
        // own — surfaced so the gap reads as OUR test being underpowered.
        underpowered: itemCount > 0 && itemCount < MIN_ITEMS_FOR_FAIL && probeVerdicts.length === 0,
        decidingProbe: decidingProbe
          ? {
              question: decidingProbe.question,
              answerQuote: decidingProbe.answerQuote || "",
              // The résumé's side of the exchange (C4) — empty for a gap-probe, which by
              // definition has no claim behind it.
              resumeQuote: decidingProbe.resumeQuote || "",
              isGap: Boolean(decidingProbe.isGap),
              turnIndex: decidingProbe.turnIndex ?? null,
            }
          : null,
      };
    })
    .sort((a, b) => b.weight - a.weight);

  // What the interview did to the CV's claim, per row — attached here rather
  // than recomputed by each surface that draws it.
  for (const r of rows) r.movement = legMovement(r);

  const weightOf = (bucket) => Math.round(rows.filter((r) => r.bucket === bucket).reduce((s, r) => s + r.weight, 0) * 100) / 100;

  // The displayed percentage, computed HERE so both surfaces print the same number.
  //
  // They did not. The admin screen renormalised (`pctOf(weight / total)`) and the PDF printed the
  // raw weight (`Math.round(w * 100)`), which is the same rounding-to-2dp above resolved two
  // different ways — so one surface could show three buckets totalling 99% or 101% while the other
  // showed 100%, from one payload, behind one button. Both files carried a comment claiming parity
  // with the other.
  //
  // Largest remainder: floor each share, then give the leftover points to the largest fractional
  // parts. Three numbers a reader is invited to add up have to add up.
  const bucketPercents = (weights) => {
    const sum = weights.reduce((s, w) => s + w, 0);
    if (!(sum > 0)) return weights.map(() => 0);
    const exact = weights.map((w) => (w / sum) * 100);
    const out = exact.map(Math.floor);
    let left = 100 - out.reduce((s, v) => s + v, 0);
    const byFraction = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
    for (const { i } of byFraction) {
      if (left <= 0) break;
      out[i] += 1;
      left -= 1;
    }
    return out;
  };

  const bucketOrder = [BUCKET.proven, BUCKET.failed, BUCKET.insufficient];
  const bucketWeights = bucketOrder.map(weightOf);
  const bucketPcts = bucketPercents(bucketWeights);
  const group = (bucket) => {
    const i = bucketOrder.indexOf(bucket);
    return { rows: rows.filter((r) => r.bucket === bucket), weight: bucketWeights[i], pct: bucketPcts[i] };
  };

  return {
    rows,
    buckets: { proven: group(BUCKET.proven), failed: group(BUCKET.failed), insufficient: group(BUCKET.insufficient) },
    totals: {
      criteria: rows.length,
      // How much of what this role says it cares about we cannot speak to. This
      // is the honest headline, and it is a statement about the assessment.
      insufficientWeight: weightOf(BUCKET.insufficient),
      failedWeight: weightOf(BUCKET.failed),
      provenWeight: weightOf(BUCKET.proven),
      neverProbed: rows.filter((r) => r.probeCount === 0).length,
      // Criteria the interview never touched at all — no probe AND no covered anchor. This is
      // the number the report's "we never got to N" headline reads; `neverProbed` stays the
      // stricter instrument metric (anchors are not probes).
      untouched: rows.filter((r) => r.probeCount === 0 && !r.anchorCovered).length,
      underpoweredCriteria: rows.filter((r) => r.underpowered).length,
      minItemsForCall: MIN_ITEMS_FOR_FAIL,
      // Claimed vs. demonstrated, tallied once here so the screen and the PDF
      // cannot print different counts of the same subtraction. See
      // computeEvidenceMovement, defined below this function.
      movement: computeEvidenceMovement(rows),
    },
  };
}

// ---------------------------------------------------------------------------
// Session quality
// ---------------------------------------------------------------------------
// §3 rule 5: a degraded session must be labelled everywhere it surfaces, and must
// never be reported as if it were a clean read. These thresholds detect the
// signature of a broken audio path — long recordings that transcribe to almost
// nothing, near-silent turns, and repeated "can you repeat that".

// Calibrated against real sessions: answers that were genuinely attempted ran
// 111–125 wpm at a 0.56–0.57 pause ratio, while every non-answer sat below 35 wpm
// at 0.79+. These thresholds sit in that gap, so a slow-but-real answer is not
// flagged and an open mic producing nothing is.
const SILENCE_PAUSE_RATIO = 0.8;
// Bottom of the audio-usability range (utils/prosody.audioQuality). Only the very bottom is
// meaningful: this fires on a recording that captured essentially nothing, and its consequence
// is always to REMOVE trust from the turn, never to count against the candidate.
const UNUSABLE_AUDIO = 10;
// A turn that captured real audio but almost no speech is the clearest tell.
// Measured as rate, not raw word count, so a long rambling non-answer
// ("could you repeat… could you repeat…") is caught alongside a silent one.
const STALLED_MIN_AUDIO_MS = 8000;
const STALLED_MAX_WPM = 35;
const REPEAT_RE = /\b(repeat|say (that|it) again|come again|couldn'?t hear|can'?t hear|pardon)\b/i;

function analyseTurnQuality(turns) {
  return (turns || [])
    .filter((t) => t.role === "candidate")
    .map((t, index) => {
      const words = wordCount(t.text);
      const audioMs = t.audioDurationMs || 0;
      const pauseRatio = t.acoustic?.pauseRatio ?? null;
      // `deliveryScore` is the pre-2026-08 field name, kept only so sessions recorded before the
      // rename still flag their bad audio. Nothing writes it any more, and neither name is ever
      // shown to a recruiter as a number about the candidate — see utils/prosody.js.
      const audioQuality = t.acoustic?.audioQuality ?? t.acoustic?.deliveryScore ?? null;
      // Prefer the rate the ASR reported; fall back to deriving it so a turn
      // without acoustics is still assessable.
      const wpm = t.acoustic?.wordsPerMinute ?? (audioMs > 0 ? (words / (audioMs / 60000)) : null);
      const flags = [];
      if (audioMs >= STALLED_MIN_AUDIO_MS && wpm != null && wpm < STALLED_MAX_WPM) flags.push("stalled");
      if (pauseRatio != null && pauseRatio >= SILENCE_PAUSE_RATIO) flags.push("mostly_silence");
      if (audioQuality != null && audioQuality <= UNUSABLE_AUDIO) flags.push("unusable_audio");
      if (REPEAT_RE.test(t.text || "")) flags.push("asked_to_repeat");
      // The socket died and recovered part-way through this answer, so the transcript is missing
      // whatever was said during the gap. Without this flag a candidate whose broadband dropped
      // reads as a candidate who had less to say — the same words, a completely different finding.
      if (t.connection?.drops > 0) flags.push("connection_dropped");
      return {
        index,
        words,
        audioMs,
        wpm: wpm == null ? null : Math.round(wpm),
        pauseRatio,
        audioQuality,
        answerScore: t.answerScore ?? null,
        flags,
        degraded: flags.length > 0,
      };
    });
}

/**
 * Whether this interview is a trustworthy read at all. When it is not, the caller
 * must suppress the hire/no-hire recommendation rather than print it with a caveat
 * — an unreliable recommendation shown quietly is still shown.
 */
function computeSessionQuality(turns) {
  const perTurn = analyseTurnQuality(turns);
  const total = perTurn.length;
  if (total === 0) return { degraded: false, perTurn, total: 0, degradedCount: 0, repeatRequests: 0, reasons: [] };

  const degradedCount = perTurn.filter((t) => t.degraded).length;
  const repeatRequests = perTurn.filter((t) => t.flags.includes("asked_to_repeat")).length;
  const stalled = perTurn.filter((t) => t.flags.includes("stalled")).length;
  const droppedTurns = perTurn.filter((t) => t.flags.includes("connection_dropped")).length;
  const degradedRatio = degradedCount / total;

  const reasons = [];
  if (stalled >= 2) reasons.push(`${stalled} answers recorded several seconds of audio but produced almost no words`);
  if (repeatRequests >= 2) reasons.push(`the candidate asked for a question to be repeated ${repeatRequests} times`);
  // Even ONE dropped connection is enough to withhold the recommendation. Every other signature
  // here is a judgement call about ambiguous audio; this one is a known, recorded fact that part
  // of an answer was never captured. There is no honest way to recommend against a candidate on
  // a transcript we know has a hole in it, and no threshold below which that becomes acceptable.
  if (droppedTurns >= 1) {
    reasons.push(
      `the transcription connection dropped during ${droppedTurns} answer${droppedTurns === 1 ? "" : "s"}, ` +
        "so part of what was said was never recorded"
    );
  }
  if (degradedRatio >= 0.4) reasons.push(`${degradedCount} of ${total} answers show a degraded audio signature`);

  return {
    degraded: reasons.length > 0,
    // Suppression is the point: with a broken signal we cannot tell "could not
    // answer" from "could not hear", and guessing between them is exactly the
    // judgement that must go to a human.
    suppressRecommendation: reasons.length > 0,
    // The stricter sibling of `degraded`, and the one `computeVerdict` reads. See
    // `audioUnreliableFrom` for why the two are not the same test.
    audioUnreliable: audioUnreliableFrom(perTurn),
    perTurn,
    total,
    degradedCount,
    repeatRequests,
    stalled,
    droppedTurns,
    reasons,
  };
}

// WHICH SIGNATURES MAY WITHHOLD A VERDICT.
//
// `degraded` above answers "should this report carry a warning", and it is deliberately broad —
// a warning costs a reader two seconds. This answers a different and much sharper question:
// "may this session produce an automated call about a person at all". So it is the narrow set.
//
// IN: the four signatures that mean WE DID NOT HEAR THEM. Each is a statement about the recording,
// never about the candidate — a turn that captured eight seconds of audio and four words, a turn
// that was mostly silence, a turn whose audio was unusable, and a turn the socket died during.
//
// OUT: `asked_to_repeat`. How often somebody asks for a question again tracks accent, hearing,
// and connection quality — it is a conduct signal, structurally excluded from every score
// (invariant 8), and it must not reach a verdict in either direction. A candidate who asked twice
// and answered well must still be able to reach ADVANCE.
//
// The three thresholds are the ones `computeSessionQuality` is already calibrated on, applied to
// the narrower set rather than re-derived — a second set of numbers meaning almost the same thing
// is how two code paths quietly start disagreeing about the same session.
const UNHEARD_FLAGS = ["stalled", "mostly_silence", "unusable_audio", "connection_dropped"];

function audioUnreliableFrom(perTurn) {
  const total = (perTurn || []).length;
  if (!total) return false;
  const unheard = perTurn.filter((t) => (t.flags || []).some((f) => UNHEARD_FLAGS.includes(f)));
  // A recorded hole in the evidence, not an inference from ambiguous audio: one is enough, for
  // the same reason computeSessionQuality takes one dropped turn as sufficient.
  if (perTurn.some((t) => (t.flags || []).includes("connection_dropped"))) return true;
  // Two stalled turns is the clearest tell of a mic that stopped working part-way through.
  if (perTurn.filter((t) => (t.flags || []).includes("stalled")).length >= 2) return true;
  // And the ratio, matching the existing degraded-share threshold.
  return unheard.length / total >= 0.4;
}

// ---------------------------------------------------------------------------
// Claimed vs. demonstrated — the movement between evidence legs
// ---------------------------------------------------------------------------
//
// Every competitor we have looked at scores the same rubric twice — once off the
// CV, once off the interview — and prints the two numbers on two different pages
// with no link between them. Nobody subtracts them. That subtraction is the most
// decision-relevant fact in the report: a requirement the CV claimed and the
// interview could not support is a different finding from one neither ever
// mentioned, and both are different from one the candidate proved on the spot.
//
// The rows already carry all three legs (see buildCoverageMatrix), so this is a
// join we already paid for. It lives HERE, as a pure function, because the PDF
// prints the same sentence — see interviewReportPdf. A derived value computed in
// JSX is a value the two surfaces will eventually disagree about, and this file
// already carries one scar from exactly that (see bucketPercents above).
//
// Rank order is "how much support does this cell express", NOT severity: absent
// and untested tie at 1 because both mean "no reading here", which is the same
// starting point for a candidate who then demonstrates something.
const LEG_SUPPORT = { contradicted: 0, absent: 1, untested: 1, partial: 2, verified: 3 };

const MOVEMENT = { stronger: "stronger", weaker: "weaker", held: "held", undemonstrated: "undemonstrated" };

/**
 * What the interview did to the CV's claim on one requirement.
 *
 * `undemonstrated` is a first-class answer and by far the most common one. It is
 * NOT "no change" — no change would assert we looked and found the same thing.
 * We did not look. Keeping the two apart is the whole reason the report can say
 * "we never got to it" instead of quietly implying a confirmation.
 */
function legMovement(row) {
  if (!row) return null;
  const to = LEG_SUPPORT[row.interview];
  if (to == null || row.interview === CELL.untested) return MOVEMENT.undemonstrated;
  const from = LEG_SUPPORT[row.resume];
  if (from == null) return MOVEMENT.undemonstrated;
  if (to > from) return MOVEMENT.stronger;
  if (to < from) return MOVEMENT.weaker;
  return MOVEMENT.held;
}

// The tally, weighted as well as counted. A must-have that did not hold up is a
// different size of problem from a nice-to-have that did not, and the weight is
// the only thing on the row that knows the difference.
function computeEvidenceMovement(rows) {
  const list = rows || [];
  const out = { stronger: 0, weaker: 0, held: 0, undemonstrated: 0, demonstrated: 0, criteria: list.length, weakerWeight: 0 };
  for (const r of list) {
    const m = legMovement(r);
    if (!m) continue;
    out[m] += 1;
    if (m === MOVEMENT.weaker) out.weakerWeight += r.weight || 0;
  }
  out.demonstrated = out.stronger + out.weaker + out.held;
  out.weakerWeight = Math.round(out.weakerWeight * 100) / 100;
  return out;
}

/**
 * The tally as one sentence, in the plain register the rest of the report uses.
 *
 * Returns null rather than a sentence when the interview demonstrated nothing at
 * all — "0 of 9 requirements moved" is technically true and reads as a finding
 * about the candidate, which it is not. The untested block says that better.
 */
function movementSentence(m) {
  if (!m || !m.criteria || !m.demonstrated) return null;
  const parts = [];
  if (m.stronger) parts.push(`${m.stronger} held up better in the interview than the CV alone supported`);
  if (m.weaker) parts.push(`${m.weaker} did not hold up`);
  if (m.held) parts.push(`${m.held} came out the same`);
  if (parts.length === 0) return null;
  const tail = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `Of the ${m.demonstrated} requirement${m.demonstrated === 1 ? "" : "s"} the interview actually tested, ${tail}.`;
}

// ---------------------------------------------------------------------------
// The résumé leg, as a readable instrument
// ---------------------------------------------------------------------------
//
// The interview leg has had a narrative summary, a strengths list and a
// weaknesses list since it was built — the model writes them. The résumé leg has
// had neither, because nothing ever asked the model to write them, and the
// report consequently showed a CV score with no sentence attached to it.
//
// THESE ARE COMPOSED IN CODE, NOT GENERATED, AND THAT IS DELIBERATE. Adding a
// model call here would buy fluent prose at the cost of a second thing that can
// hallucinate about a candidate, on a surface that is already legally load-
// bearing. Everything below is counting and quoting what `criterionFindings`
// already contains: the labels are the rubric's own, the reasoning strings were
// written when the criterion was scored, and no sentence asserts anything the
// findings do not already say. The result reads slightly flatter than a model's
// paragraph and is exactly as true as the data behind it.
const STATUS_WORD = { satisfied: "satisfied", partial: "partly supported", absent: "not mentioned", contradicted: "contradicted" };

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The CV's headline sentence, built from the rubric findings alone.
 * Returns null when there is nothing to count — never a filler sentence.
 */
function composeResumeNarrative(findings) {
  const list = (findings || []).filter(Boolean);
  if (list.length === 0) return null;
  const by = (s) => list.filter((f) => f.status === s);
  const satisfied = by("satisfied");
  const partial = by("partial");
  const absent = by("absent");
  const contradicted = by("contradicted");

  const parts = [];
  if (satisfied.length) parts.push(`${plural(satisfied.length, "requirement", "requirements")} outright`);
  if (partial.length) parts.push(`${partial.length} in part`);
  const opening = parts.length
    ? `Against the ${list.length} requirements on this role's rubric, the CV supports ${parts.join(" and ")}.`
    : `The CV does not support any of the ${list.length} requirements on this role's rubric.`;

  const tail = [];
  if (absent.length) {
    // Named, not just counted: "3 not mentioned" sends the reader back to the
    // table to find out which three, and the whole point of a summary is to
    // save that trip.
    const names = absent
      .slice()
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .slice(0, 3)
      .map((f) => f.label);
    tail.push(`It says nothing about ${names.join(", ")}${absent.length > names.length ? ` and ${absent.length - names.length} more` : ""}.`);
  }
  if (contradicted.length) {
    tail.push(`${plural(contradicted.length, "requirement is", "requirements are")} contradicted by what the CV itself states.`);
  }
  // The honest closer: a CV is a claim, and screening it never verified anything.
  tail.push("A CV is a claim — none of this is verified until it is probed.");
  return [opening, ...tail].join(" ");
}

/**
 * Strengths / gaps / next-round probes for the résumé leg.
 *
 * The recommendations are deliberately FORWARD-LOOKING and named: not "explore
 * further" but "ask for a specific example of X", one per high-weight
 * requirement the CV left unproven. That is the shape a recruiter can hand to
 * whoever runs the next round, and it is the natural consumer of the same gaps
 * the coverage matrix already identified.
 */
function resumeFindingLists(findings) {
  const list = (findings || []).filter(Boolean);
  const byWeight = (a, b) => (b.weight || 0) - (a.weight || 0);
  const say = (f) => {
    const reason = String(f.reasoning || "").trim();
    return reason ? `${f.label} — ${reason}` : `${f.label} — ${STATUS_WORD[f.status] || f.status} by the CV.`;
  };
  return {
    strengths: list.filter((f) => f.status === "satisfied").sort(byWeight).map(say),
    gaps: list.filter((f) => f.status === "absent" || f.status === "contradicted").sort(byWeight).map(say),
    recommendations: list
      .filter((f) => f.status !== "satisfied" && f.kind !== "nice_to_have")
      .sort(byWeight)
      .slice(0, 5)
      .map((f) =>
        f.status === "contradicted"
          ? `Ask about ${f.label} directly — the CV contradicts itself here.`
          : `Ask for one specific example of ${f.label}; the CV ${f.status === "partial" ? "hints at it without evidence" : "never mentions it"}.`
      ),
  };
}

// ---------------------------------------------------------------------------
// The verdict chip
// ---------------------------------------------------------------------------
//
// A gauge reading 80% does not tell a recruiter whether 80% is good. The chip
// answers that, and it is the same word on the screen and in the PDF because it
// comes from here.
//
// `assessment` deliberately has NO chip. There is no approved pass mark on a
// skills paper — inventing one would be a global cutoff for "good", which is the
// exact thing this product refuses to assert (nothing is scored against an
// abstract standard, only against this role's approved rubric). The item count
// prints instead, which is a measurement rather than a judgement.
const VERDICT_CHIP = {
  ADVANCE: { label: "Advance", tone: "positive" },
  REVIEW: { label: "Needs review", tone: "pending" },
  CLEAR_REJECT: { label: "Clear reject", tone: "negative" },
  WITHHELD: { label: "Withheld", tone: "neutral" },
};

const RESUME_BAND_VERDICT = { advance: "ADVANCE", review: "REVIEW", decline: "CLEAR_REJECT" };

/**
 * @param {"interview"|"resume"|"assessment"} instrument
 * @param {object} [verdict]  computeVerdict()'s output — the interview leg
 * @param {string} [band]     AtsAssessment.band — the résumé leg
 * @param {boolean} [measurable]  false when the session was degraded/fallback
 * @returns {{key:string,label:string,tone:string}|null} null = print no chip
 */
function verdictFor({ instrument, verdict, band, measurable = true }) {
  // The Honest Reading Rule, at the point it is decided rather than at each of
  // the places it is drawn: an unmeasurable session never wears a confident word.
  if (!measurable) return { key: "WITHHELD", ...VERDICT_CHIP.WITHHELD };
  if (instrument === "interview") {
    const key = verdict?.verdict;
    return VERDICT_CHIP[key] ? { key, ...VERDICT_CHIP[key] } : null;
  }
  if (instrument === "resume") {
    const key = RESUME_BAND_VERDICT[band];
    return key ? { key, ...VERDICT_CHIP[key] } : null;
  }
  return null;
}

module.exports = {
  audioUnreliableFrom,
  MIN_RESPONSIVE_WORDS,
  INTERVIEW_PASS_THRESHOLD,
  wordCount,
  isResponsive,
  computeAnswerSubstance,
  computeDurationFlag,
  mapCompetency,
  buildCompetencyTable,
  computeVerdict,
  recommendedAction,
  competencyTripletOrNull,
  CELL,
  BUCKET,
  MIN_ITEMS_FOR_CALL,
  MIN_ITEMS_FOR_FAIL,
  untestedCauseFor,
  buildCoverageMatrix,
  analyseTurnQuality,
  computeSessionQuality,
  MOVEMENT,
  legMovement,
  computeEvidenceMovement,
  movementSentence,
  VERDICT_CHIP,
  verdictFor,
  composeResumeNarrative,
  resumeFindingLists,
};
