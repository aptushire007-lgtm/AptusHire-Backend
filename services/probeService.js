// Claim → Probe → Verdict loop (BUILD-PLAN Phase 8).
//
//   Pre-interview assessment computes unverifiedHighWeightClaims (Phase 6)
//     → generateProbesForSession: each becomes ONE neutral interview question
//       with precomputed verify/contradict conditions (probe_gen, capped)
//     → the interview plan treats probes as REQUIRED COVERAGE (Phase 8.2)
//     → after the interview, assessVerdicts judges each asked probe against
//       its stated conditions, with a code-verified verbatim answer quote
//     → verdicts write back to the ClaimGraph (verificationStatus)
//     → rescoreAfterInterview re-runs the PURE scorer: the verification
//       multiplier moves, so proof changes the number. Stored as a SECOND
//       assessment (stage post_interview) — never a mutation of the first.
//
// Hard rules:
//   - A `contradicted` verdict NEVER auto-rejects; it surfaces to a human
//     with both quotes. No pipeline transition happens here.
//   - Accusatory probe phrasing is dropped in code (probePhrasingIssues).
//   - Any failure anywhere ⇒ the interview runs exactly as today.

const AtsAssessment = require("../models/AtsAssessment");
const ClaimGraph = require("../models/ClaimGraph");
const RoleRubric = require("../models/RoleRubric");
const CompanySettings = require("../models/CompanySettings");
const llm = require("./llmService");
const usageService = require("./usageService");
const questionSimilarity = require("../utils/questionSimilarity");
const { resolveRole } = require("../config/models");
const {
  PROBE_PROMPT_VERSION,
  PROBE_SYSTEM,
  PROBE_SCHEMA,
  probePrompt,
  VERDICT_SYSTEM,
  VERDICT_SCHEMA,
  verdictPrompt,
  probePhrasingIssues,
  claimStatement,
} = require("../utils/probePrompts");
const { computeAssessment, reproducibilityHash, claimsStateHash, SCORER_VERSION } = require("../utils/evidenceScorer");
const { checkInvariants } = require("../utils/assessmentInvariants");

const PROVIDER = "openrouter";
const PROBE_CAP = 4; // probes are capped so the interview stays an interview

// A3 (REPORT-REDESIGN): the coverage budget that replaces the flat cap — OFF by default.
// Set PROBE_COVERAGE_BUDGET to a rubric-weight share (e.g. 0.7) and the cap grows until the
// weightiest criteria sum to that share, bounded by the ceiling so a 20-criterion rubric can
// never produce a 40-minute interview. Flag-gated because this directly lengthens interviews:
// it stays off until one real session run at the new length has been reviewed.
const PROBE_HARD_CEILING = 8;
function probeCapFor(criterionFindings) {
  const budget = Number(process.env.PROBE_COVERAGE_BUDGET || "");
  if (!Number.isFinite(budget) || budget <= 0) return PROBE_CAP;
  const weights = (criterionFindings || [])
    .map((f) => (typeof f?.weight === "number" ? f.weight : 0))
    .sort((a, b) => b - a);
  let cumulative = 0;
  let needed = 0;
  for (const w of weights) {
    if (cumulative >= budget) break;
    cumulative += w;
    needed += 1;
  }
  return Math.max(PROBE_CAP, Math.min(PROBE_HARD_CEILING, needed));
}

// A4: probe the 19%-weight must-have before the 6% nice-to-have. Targets arrive in claim order;
// this ranks them by the WEIGHT of the criterion each one evidences, stable so equal weights keep
// their original order (two candidates with the same rubric are probed in the same order).
function rankTargetsByCriterionWeight(targets, criterionFindings) {
  const weightBy = new Map(
    (criterionFindings || []).map((f) => [f.criterionId, typeof f?.weight === "number" ? f.weight : 0])
  );
  return (targets || [])
    .map((t, order) => ({ t, order, weight: weightBy.get(t.criterionId) || 0 }))
    .sort((a, b) => b.weight - a.weight || a.order - b.order)
    .map((x) => x.t);
}

// ---------------------------------------------------------------------------
// A2 — gap-probes: the requirements the résumé is SILENT on
// ---------------------------------------------------------------------------
//
// Claim-probes test what the CV claims but cannot prove — which means a requirement the CV never
// mentions produces no claim, no probe, and a permanent "untested" row. That selection rule is
// inverted: the requirements we know least about are exactly the ones never asked about. A
// gap-probe is a neutral open question about such a requirement, generated from a TEMPLATE rather
// than a model: there is no claim text to reason over, so a model call here buys hallucination
// risk and nondeterminism for nothing.
//
// TWO HARD RULES, both structural:
//   * The phrasing asks what the candidate has DONE, states plainly that "nothing" is a fine
//     answer, and never references the résumé's silence — checked by the same probePhrasingIssues
//     gate every claim-probe passes.
//   * A gap-probe can return verified or inconclusive but NEVER contradicted — there is no résumé
//     claim to contradict, and "could not answer about something they never claimed" is not
//     evidence of dishonesty. Enforced in sanitiseVerdicts (not the prompt), and doubly so in
//     applyVerdictsToClaims: a gap claimId matches no ClaimGraph claim, so nothing can write back.

const GAP_CLAIM_PREFIX = "gap-";

// "Experience with deep learning frameworks" → "deep learning frameworks": strip the requirement
// framing so the question reads as a topic, not as a recitation of the job spec.
function gapTopicFromLabel(label) {
  let t = String(label || "").trim();
  t = t.replace(/^(?:proven|strong|solid|good|excellent|hands-on|demonstrated|practical|working)\s+/i, "");
  t = t.replace(
    /^(?:experience (?:with|in|of|using)|knowledge of|familiarity with|understanding of|proficiency (?:with|in)|expertise (?:with|in)|exposure to|background in|ability to use|skills? (?:with|in))\s+/i,
    ""
  );
  t = t.replace(/^(?:a|an|the)\s+/i, "");
  return t.trim() || String(label || "").trim();
}

/**
 * Deterministic gap-probes for criteria the résumé never addressed: status "absent" AND zero
 * supporting claims, weightiest first, at most `room` of them. Disqualifiers are excluded — they
 * are gates, not scoreable criteria, and a gate is not something to "explore" in an interview.
 * Pure and exported for tests.
 */
function gapProbesFor(criterionFindings, room) {
  if (!Number.isFinite(room) || room <= 0) return [];
  const gaps = (criterionFindings || [])
    .filter(
      (f) =>
        f &&
        f.criterionId &&
        f.status === "absent" &&
        !(f.supportingClaimIds || []).length &&
        f.kind !== "disqualifier"
    )
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, room);

  const probes = [];
  for (const f of gaps) {
    const topic = gapTopicFromLabel(f.label);
    if (!topic) continue;
    const question =
      `One of the areas this role touches is ${topic}. ` +
      `What work have you done there, if any? A specific example is ideal — ` +
      `and if it's not something you've worked with, that's a completely fine answer.`;
    // The same neutrality gate every claim-probe passes. A template should never trip it, but
    // "should never" is not a control — if it does, the gap simply stays a gap.
    if (probePhrasingIssues(question).length > 0) continue;
    probes.push({
      claimId: `${GAP_CLAIM_PREFIX}${f.criterionId}`,
      criterionId: f.criterionId,
      isGap: true,
      question,
      whatWouldVerify:
        `A specific, first-hand account of real work involving ${topic} — what they did, in what ` +
        `context, with enough concrete detail to be checkable.`,
      whatWouldContradict:
        "Nothing. The résumé makes no claim about this, so no answer can contradict anything — " +
        "'contradicted' is not a permitted verdict for this question.",
      resumeQuote: "",
      status: "pending",
    });
  }
  return probes;
}

function isEnabled() {
  const v = process.env.PROBE_ENGINE_ENABLED;
  return v !== "false" && v !== "0";
}

// ---------------------------------------------------------------------------
// Pure sanitisers (exported for tests) — cite-or-drop for probes and verdicts
// ---------------------------------------------------------------------------

/**
 * Keep only probes that: reference a requested claim (no ghosts), carry a
 * non-empty question that passes the neutrality check, and state both verdict
 * conditions. One probe per claim; order follows the requested list.
 */
function sanitiseProbes(rawProbes, requestedClaims, cap = PROBE_CAP) {
  const byId = new Map(requestedClaims.map((c) => [c.id, c]));
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const p of rawProbes || []) {
    const claim = byId.get(p?.claimId);
    if (!claim || seen.has(p.claimId)) {
      dropped.push({ claimId: p?.claimId, reason: "unknown_or_duplicate_claim" });
      continue;
    }
    const question = String(p.question || "").trim();
    const verify = String(p.whatWouldVerify || "").trim();
    const contradict = String(p.whatWouldContradict || "").trim();
    if (!question || !verify || !contradict) {
      dropped.push({ claimId: p.claimId, reason: "missing_fields" });
      continue;
    }
    const issues = probePhrasingIssues(question);
    if (issues.length > 0) {
      dropped.push({ claimId: p.claimId, reason: `accusatory_phrasing:${issues.join(",")}` });
      continue;
    }
    // §3.5: two DIFFERENT claims can still produce near-duplicate question text — the check above
    // only catches the same claim proposed twice. Reuses the identical Jaccard/containment check
    // (utils/questionSimilarity) that already governs ask-time repeat detection during the live
    // interview, just applied one stage earlier so a duplicate is never seeded in the first place.
    const dup = questionSimilarity.findDuplicate(question, kept.map((k) => k.question));
    if (dup.duplicate) {
      dropped.push({ claimId: p.claimId, reason: `duplicate_question:${dup.reason}` });
      continue;
    }
    seen.add(p.claimId);
    kept.push({
      claimId: p.claimId,
      question: question.slice(0, 600),
      whatWouldVerify: verify.slice(0, 800),
      whatWouldContradict: contradict.slice(0, 800),
      resumeQuote: claim.spans?.[0]?.quote || "",
      status: "pending",
    });
  }
  return { probes: kept.slice(0, cap), dropped };
}

/**
 * Keep only verdicts that reference an assessed item; a verified/contradicted
 * verdict whose answerQuote is not a verbatim substring of the candidate's
 * answer is DOWNGRADED to inconclusive (cite-or-abstain — the same rule the
 * extractor lives under). Missing verdicts default to inconclusive.
 */
function sanitiseVerdicts(rawVerdicts, items) {
  const byId = new Map(items.map((it) => [it.claimId, it]));
  const out = new Map();
  for (const v of rawVerdicts || []) {
    const item = byId.get(v?.claimId);
    if (!item || out.has(v.claimId)) continue;
    let verdict = ["verified", "contradicted", "inconclusive"].includes(v.verdict) ? v.verdict : "inconclusive";
    let answerQuote = String(v.answerQuote || "").trim();
    let reasoning = String(v.reasoning || "").slice(0, 1200);
    // A2's hard rule, enforced where the model cannot argue with it: a gap-probe has no résumé
    // claim behind it, so there is nothing an answer could contradict. "Could not answer a
    // question about something they never claimed" is an absence of evidence, not evidence of
    // dishonesty — the verdict for that is inconclusive.
    if (item.isGap && verdict === "contradicted") {
      verdict = "inconclusive";
      answerQuote = "";
      reasoning =
        `Downgraded to inconclusive: this question explored a requirement the résumé does not address, ` +
        `so 'contradicted' is not a permitted verdict — there is no claim to contradict. Original reasoning: ${reasoning}`.slice(0, 1200);
    }
    if (verdict !== "inconclusive") {
      if (!answerQuote || !String(item.answerText || "").includes(answerQuote)) {
        verdict = "inconclusive";
        answerQuote = "";
        reasoning = `Downgraded to inconclusive: the cited answer quote was not a verbatim part of the answer. Original reasoning: ${reasoning}`.slice(0, 1200);
      }
    } else {
      answerQuote = "";
    }
    out.set(v.claimId, { claimId: v.claimId, verdict, reasoning, answerQuote: answerQuote.slice(0, 600) });
  }
  // Every asked probe gets a verdict row — unanswered by the model ⇒ inconclusive.
  return items.map(
    (it) =>
      out.get(it.claimId) || {
        claimId: it.claimId,
        verdict: "inconclusive",
        reasoning: "No verdict returned by the assessor for this probe.",
        answerQuote: "",
      }
  );
}

/**
 * Apply verdicts to claim verificationStatus (pure; mutates the passed array
 * items). verified → verified_in_interview, contradicted →
 * contradicted_in_interview, inconclusive → unchanged. Returns changed count.
 */
function applyVerdictsToClaims(claims, verdicts) {
  const byId = new Map((claims || []).map((c) => [c.id, c]));
  let changed = 0;
  for (const v of verdicts || []) {
    const claim = byId.get(v.claimId);
    if (!claim) continue;
    const next =
      v.verdict === "verified" ? "verified_in_interview" : v.verdict === "contradicted" ? "contradicted_in_interview" : null;
    if (next && claim.verificationStatus !== next) {
      claim.verificationStatus = next;
      changed += 1;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// 8.1 — probe generation (at interview start; failure ⇒ no probes, no error)
// ---------------------------------------------------------------------------

async function generateProbesForSession(session, candidate) {
  // Every early return says WHY. "No probes" used to be a single indistinguishable state, which
  // meant the commonest cause by far — the job has no approved RoleRubric, so no pre_interview
  // assessment was ever written, so there are no unverified claims to probe — was invisible. An
  // interview that verified nothing about the résumé must not look like one that had nothing left
  // to verify (rule 5: uncertainty must be visible).
  if (!isEnabled() || !llm.isEnabled()) return { probes: [], engine: "none", reason: "engine_disabled" };
  try {
    const assessment = await AtsAssessment.findOne({
      candidate: candidate._id,
      company: session.company,
      stage: "pre_interview",
    }).sort({ createdAt: -1 });
    if (!assessment) return { probes: [], engine: "none", reason: "no_assessment" };
    if (!(assessment.unverifiedHighWeightClaims || []).length) {
      return { probes: [], engine: "none", reason: "no_unverified_claims" };
    }

    const graph = await ClaimGraph.findById(assessment.claimGraph);
    if (!graph) return { probes: [], engine: "none", reason: "no_assessment" };
    const claimsById = new Map(graph.claims.map((c) => [c.id, c]));
    const cap = probeCapFor(assessment.criterionFindings);
    // Probe dedup (ASSESSMENT-ENGINE-PLAN A3.4): a claim the skills assessment
    // already VERIFIED needs no interview time — the interview gets shorter and
    // sharper. Contradicted claims STAY probed: the interview is the candidate's
    // chance to explain (procedural fairness).
    // Ranked by the WEIGHT of the criterion each claim evidences (A4), so the probe slots go to
    // what the rubric says matters most, not to whatever order the claims arrived in.
    const targets = rankTargetsByCriterionWeight(
      assessment.unverifiedHighWeightClaims
        .map((u) => ({ claim: claimsById.get(u.claimId), criterionId: u.criterionId }))
        .filter((t) => t.claim && t.claim.verificationStatus !== "verified_in_assessment"),
      assessment.criterionFindings
    ).slice(0, cap);
    if (!targets.length) {
      // No unverified claims to probe — but requirements the résumé is SILENT on may still exist,
      // and those get gap-probes below whether or not any claim-probe was possible.
      const gapsOnly = gapProbesFor(assessment.criterionFindings, cap);
      if (gapsOnly.length) return { probes: gapsOnly, engine: "template", reason: "gap_probes_only" };
      return { probes: [], engine: "none", reason: "no_unverified_claims" };
    }

    const settings = await CompanySettings.findOne({ company: session.company }).select("ai");
    const resolved = resolveRole("reasoning", settings);
    const t0 = Date.now();
    const { data, usage, model, cached } = await llm.generateJSON({
      system: PROBE_SYSTEM,
      prompt: probePrompt(targets.map((t) => t.claim)),
      schema: PROBE_SCHEMA,
      maxTokens: 1200,
      model: resolved.model,
      temperature: 0,
      promptVersion: PROBE_PROMPT_VERSION,
    });
    await usageService.recordUsage({
      company: session.company,
      session: session._id,
      candidate: candidate._id,
      kind: "probe_gen",
      provider: PROVIDER,
      model,
      usage,
      latencyMs: Date.now() - t0,
      engine: "ai",
      promptVersion: PROBE_PROMPT_VERSION,
      cached,
    });

    const { probes, dropped } = sanitiseProbes(data.probes, targets.map((t) => t.claim), cap);
    if (dropped.length) {
      console.warn(`[probes] dropped ${dropped.length} probe(s) for session ${session._id}: ${dropped.map((d) => d.reason).join("; ")}`);
    }
    const criterionByClaim = new Map(targets.map((t) => [t.claim.id, t.criterionId]));
    for (const p of probes) p.criterionId = criterionByClaim.get(p.claimId) || "";
    // A2: whatever probe slots the claims did not use go to the requirements the résumé never
    // addressed — the inverted-selection fix. A criterion that already has a claim-probe is not
    // gap-probed too (one subject, one required question).
    const probedCriteria = new Set(probes.map((p) => p.criterionId).filter(Boolean));
    const gaps = gapProbesFor(
      (assessment.criterionFindings || []).filter((f) => !probedCriteria.has(f.criterionId)),
      cap - probes.length
    );
    // §3.5, second pass: a gap-probe is templated independently of the claim-probes above, so it
    // can still land on near-identical wording (a claim-probe already asks about the gap's topic
    // in different words). Same dedup, applied across the two probe sources before they merge.
    const claimQuestions = probes.map((p) => p.question);
    const dedupedGaps = gaps.filter((g) => !questionSimilarity.findDuplicate(g.question, claimQuestions).duplicate);
    if (dedupedGaps.length < gaps.length) {
      console.warn(
        `[probes] dropped ${gaps.length - dedupedGaps.length} gap-probe(s) for session ${session._id} — duplicate of an existing claim-probe`
      );
    }
    const all = [...probes, ...dedupedGaps];
    return { probes: all, engine: "ai", model, reason: all.length ? "ok" : "generation_failed" };
  } catch (err) {
    // Guardrail: probe-generation failure means the interview runs exactly as today.
    console.error("[probes] generation failed — interview proceeds without probes:", err.message);
    return { probes: [], engine: "none", reason: "generation_failed" };
  }
}

// ---------------------------------------------------------------------------
// 8.4 — verdict assessment (at finalisation, off the candidate request path)
// ---------------------------------------------------------------------------

// The answer that responded to this probe's question — or "", explicitly, when the candidate
// declined it.
//
// THE DECLINE MUST NOT REACH THE VERDICT MODEL. A probe asks the candidate to substantiate a
// specific résumé claim, and the model is asked to judge the answer against precomputed
// verify/contradict conditions. Hand it "I don't know" and it will reach for `contradicted` —
// which would turn *declining to elaborate* into evidence that the candidate's résumé was false,
// write that back to the ClaimGraph, and rescore them on it. That is a serious adverse finding
// manufactured out of an absence of evidence.
//
// The correct verdict for a declined probe is `inconclusive`, and it is assigned in code (see
// declinedProbeClaimIds) rather than asked for, because "no evidence either way" is exactly the
// judgement a model under schema pressure is least reliable at returning.
function answerTextForProbe(turns, probe) {
  if (probe.turnIndex == null) return "";
  for (let i = probe.turnIndex + 1; i < turns.length; i += 1) {
    if (turns[i].role === "candidate") return turns[i].declined ? "" : turns[i].text || "";
  }
  return "";
}

// Probes whose question the candidate answered with a decline. Marked inconclusive without any
// model call at all — there is nothing to assess, and the honest verdict is knowable from the
// turn flag alone.
function declinedProbeClaimIds(turns, probes) {
  const ids = [];
  for (const p of probes || []) {
    if (p.turnIndex == null) continue;
    for (let i = p.turnIndex + 1; i < turns.length; i += 1) {
      if (turns[i].role !== "candidate") continue;
      if (turns[i].declined) ids.push(p.claimId);
      break;
    }
  }
  return ids;
}

/**
 * Assess all asked probes on a completed session, write verdicts to the
 * session AND back to the ClaimGraph. Returns the verdict rows (empty when
 * nothing to assess or the LLM is unavailable).
 */
async function assessVerdicts(session, candidate) {
  const ai = session.aiInterview;

  // Declined probes are settled first, in code, before anything reaches a model — and before the
  // LLM-availability early-return below, because "the candidate declined this one" is knowable
  // with no provider at all and must be recorded either way. `inconclusive` is the honest verdict
  // and it carries no adverse consequence: applyVerdictsToClaims leaves an inconclusive claim
  // unverified rather than contradicted, so the rescore treats it as evidence never gathered
  // (which it is), not as a claim disproved (which it emphatically is not).
  const declinedIds = new Set(declinedProbeClaimIds(ai.turns || [], (ai.probes || []).filter((p) => p.status === "asked")));
  if (declinedIds.size) {
    for (const p of ai.probes) {
      if (p.status !== "asked" || !declinedIds.has(p.claimId)) continue;
      p.status = "assessed";
      p.verdict = "inconclusive";
      p.verdictReasoning =
        "The candidate was asked this question and stated they could not answer it. Declining to " +
        "elaborate is not evidence for or against the claim, so it remains unverified.";
      p.answerQuote = "";
      p.assessedAt = new Date();
    }
    await session.save();
  }

  const asked = (ai.probes || []).filter((p) => p.status === "asked");
  if (!asked.length) return [];
  if (!isEnabled() || !llm.isEnabled()) return [];

  const graph = await ClaimGraph.findOne({
    candidate: candidate._id,
    company: session.company,
  }).sort({ createdAt: -1 });
  const claimsById = new Map((graph?.claims || []).map((c) => [c.id, c]));

  const items = asked
    .map((p) => {
      const claim = claimsById.get(p.claimId);
      return {
        claimId: p.claimId,
        isGap: Boolean(p.isGap),
        statement: claim
          ? claimStatement(claim)
          : p.isGap
            ? "The résumé does not address this requirement; the question asked what, if anything, the candidate has done with it."
            : p.resumeQuote || p.claimId,
        question: p.question,
        whatWouldVerify: p.whatWouldVerify,
        whatWouldContradict: p.whatWouldContradict,
        answerText: answerTextForProbe(ai.turns, p),
      };
    })
    .filter((it) => it.answerText.trim());
  if (!items.length) return [];

  try {
    const settings = await CompanySettings.findOne({ company: session.company }).select("ai");
    const resolved = resolveRole("reasoning", settings);
    const t0 = Date.now();
    const { data, usage, model, cached } = await llm.generateJSON({
      system: VERDICT_SYSTEM,
      prompt: verdictPrompt(items),
      schema: VERDICT_SCHEMA,
      maxTokens: 1600,
      model: resolved.model,
      temperature: 0,
      promptVersion: PROBE_PROMPT_VERSION,
    });
    await usageService.recordUsage({
      company: session.company,
      session: session._id,
      candidate: candidate._id,
      kind: "verdict",
      provider: PROVIDER,
      model,
      usage,
      latencyMs: Date.now() - t0,
      engine: "ai",
      promptVersion: PROBE_PROMPT_VERSION,
      cached,
    });

    const verdicts = sanitiseVerdicts(data.verdicts, items);

    // Write verdicts onto the session's probes…
    const byId = new Map(verdicts.map((v) => [v.claimId, v]));
    for (const p of ai.probes) {
      const v = byId.get(p.claimId);
      if (!v || p.status !== "asked") continue;
      p.status = "assessed";
      p.verdict = v.verdict;
      p.verdictReasoning = v.reasoning;
      p.answerQuote = v.answerQuote;
      p.assessedAt = new Date();
    }
    await session.save();

    // …and back into the ClaimGraph (the write-back that makes rescoring real).
    if (graph) {
      const changed = applyVerdictsToClaims(graph.claims, verdicts);
      if (changed > 0) {
        graph.markModified("claims");
        await graph.save();
      }
    }
    return verdicts;
  } catch (err) {
    console.error("[probes] verdict assessment failed — claims stay unverified:", err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 8.5 — post-interview rescore (pure scorer re-run; a SECOND assessment)
// ---------------------------------------------------------------------------

/**
 * Re-run the deterministic scorer over the (now verdict-updated) ClaimGraph
 * using the pre-interview assessment's own matcher findings. Zero LLM spend:
 * only the verification multipliers move. Persists stage "post_interview";
 * never overwrites anything. Returns { pre, post } or null when no rescore
 * is possible.
 */
async function rescoreAfterInterview(candidate, { session } = {}) {
  const pre = await AtsAssessment.findOne({
    candidate: candidate._id,
    company: candidate.company,
    stage: "pre_interview",
    engine: "evidence",
  }).sort({ createdAt: -1 });
  if (!pre) return null;

  const graph = await ClaimGraph.findById(pre.claimGraph);
  const rubric = await RoleRubric.findById(pre.rubric);
  if (!graph || !rubric) return null;

  const claims = graph.claims.map((c) => (c.toObject ? c.toObject() : c));
  const stateHash = claimsStateHash(claims);

  // Idempotent: if the latest post_interview assessment already reflects this
  // exact claim-verification state, don't append a duplicate.
  const existingPost = await AtsAssessment.findOne({
    candidate: candidate._id,
    company: candidate.company,
    stage: "post_interview",
  }).sort({ createdAt: -1 });

  const findings = pre.criterionFindings.map((f) => ({
    criterionId: f.criterionId,
    status: f.status,
    supportingClaimIds: f.supportingClaimIds,
    reasoning: f.reasoning,
    confidence: f.confidence,
  }));

  const computed = computeAssessment({ rubric, claims, findings });

  const violations = checkInvariants({ assessment: computed, rubric, claims, canonicalText: candidate.resumeText || "" });
  if (violations.length > 0) {
    console.error(`[probes] post-interview rescore FAILED invariants for candidate ${candidate._id}: ${violations.join(" · ")}`);
    return null;
  }

  const hash = reproducibilityHash({
    rubricId: String(rubric._id),
    rubricVersion: rubric.version,
    resumeHash: pre.resumeHash,
    promptVersions: pre.promptVersions,
    modelId: pre.model,
    claimsStateHash: stateHash,
  });
  if (existingPost && existingPost.reproducibilityHash === hash) return { pre, post: existingPost };

  const post = await AtsAssessment.create({
    candidate: candidate._id,
    job: pre.job,
    company: candidate.company,
    rubric: rubric._id,
    rubricVersion: rubric.version,
    claimGraph: graph._id,
    resumeHash: pre.resumeHash,
    stage: "post_interview",
    mode: pre.mode,
    thresholds: pre.thresholds,
    overallScore: computed.overallScore,
    band: computed.band,
    decision: computed.decision,
    reviewReason: computed.reviewReason,
    criterionFindings: computed.criterionFindings,
    topEvidence: computed.topEvidence,
    unverifiedHighWeightClaims: computed.unverifiedHighWeightClaims,
    qa: { mode: "off", outcome: "passed", reasons: [], counterfactual: { ran: false } },
    engine: "evidence",
    model: pre.model,
    promptVersions: pre.promptVersions,
    scorerVersion: SCORER_VERSION,
    reproducibilityHash: hash,
    scoredAt: new Date(),
  });
  if (session) console.log(`[probes] post-interview rescore for candidate ${candidate._id}: ${pre.overallScore} → ${post.overallScore}`);
  return { pre, post };
}

/**
 * The whole post-interview leg in one call (used by interview finalisation):
 * verdicts → write-back → rescore. Never throws — a failure here must never
 * block interview completion.
 */
async function finalizeProbes(session, candidate) {
  try {
    const verdicts = await assessVerdicts(session, candidate);
    const rescore = await rescoreAfterInterview(candidate, { session });
    return { verdicts, rescore };
  } catch (err) {
    console.error("[probes] finalisation failed:", err.message);
    return { verdicts: [], rescore: null };
  }
}

module.exports = {
  isEnabled,
  PROBE_CAP,
  generateProbesForSession,
  assessVerdicts,
  rescoreAfterInterview,
  finalizeProbes,
  // pure, for tests
  sanitiseProbes,
  sanitiseVerdicts,
  applyVerdictsToClaims,
  answerTextForProbe,
  declinedProbeClaimIds,
  probeCapFor,
  rankTargetsByCriterionWeight,
  gapProbesFor,
  gapTopicFromLabel,
  PROBE_HARD_CEILING,
  GAP_CLAIM_PREFIX,
};
