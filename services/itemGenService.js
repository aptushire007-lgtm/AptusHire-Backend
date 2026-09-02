// Agentic item generation with the blind-solve QA gate (ASSESSMENT-ENGINE-PLAN
// A1.3). The gate is the assessment version of cite-or-abstain: a generated item
// is only trustworthy if N independent solvers — WHO NEVER SEE THE KEY — converge
// on it. Unanimous agreement with the key ⇒ active; any disagreement means the
// item is ambiguous or wrong ⇒ one revision cycle, then `flagged` with the
// solver split stored and shown to the recruiter. Disagreement is a routing
// signal (rule 4), applied to our OWN generated content.
//
// Cost shape (§7): everything here runs ONCE per paper version, at authoring
// time, metered (`item_gen` / `item_solve`) and capped — per-paper call ceiling
// plus the tenant's monthly AI budget. Zero marginal LLM cost per candidate.
// The run is resumable: items persist as they pass.

const AssessmentPaper = require("../models/AssessmentPaper");
const CompanySettings = require("../models/CompanySettings");
const RoleRubric = require("../models/RoleRubric");
const llm = require("./llmService");
const usageService = require("./usageService");
const tenantContext = require("../utils/tenantContext");
const { resolveRole } = require("../config/models");
const {
  ITEM_GEN_PROMPT_VERSION,
  ITEM_GEN_SYSTEM,
  ITEM_GEN_SCHEMA,
  itemGenPrompt,
  SOLVER_PROMPT_VERSION,
  SOLVER_SYSTEM,
  SOLVER_SCHEMA,
  buildSolverPrompt,
} = require("../utils/assessmentPrompts");

const PROVIDER = "openrouter";
const OPTION_IDS = ["a", "b", "c", "d", "e"];
const SOLVER_N = Number(process.env.ASSESSMENT_SOLVER_N) || 3;

// Per-paper hard ceilings (§A1 guardrails). Tiered pools are the one authoring
// cost multiplier — these caps keep the one-time cost bounded.
function maxItemsPerPaper() {
  return Number(process.env.ASSESSMENT_MAX_ITEMS_PER_PAPER) || 60;
}
function maxLlmCallsPerPaper() {
  return Number(process.env.ASSESSMENT_MAX_GEN_CALLS_PER_PAPER) || 400;
}
function poolCapPerTier() {
  return Number(process.env.ASSESSMENT_POOL_CAP_PER_TIER) || 8; // per section per tier
}

// --- Run liveness ------------------------------------------------------------
// A run lives only in the memory of the process that started it. If that process
// goes away mid-run (deploy, crash, nodemon restart, `docker compose restart`),
// nothing ever writes the terminal status, so the paper is left pinned at
// `generationRun.status: "running"` forever. Both guards then fire against a run
// that no longer exists: Resume refuses with 409 "already running" and Approve
// refuses with 409 "still running" — the paper is unrecoverable from the UI.
//
// So a run has to prove it is alive rather than merely claim it. The loop stamps
// `heartbeatAt` every time it persists an item; a run whose heartbeat has gone
// quiet for longer than the window is treated as dead and may be taken over.
//
// Taking over is safe because the run is already resumable by design: items
// persist as they pass the gate, and runGeneration skips specs already covered by
// existing items — a takeover continues the pool instead of duplicating it. The
// window is deliberately generous, because one item can legitimately take minutes
// (1 gen + 3 blind solves, doubled when a disagreement triggers the revision
// cycle) and a false-positive takeover would put two loops on the same document.
function runStaleMs() {
  return Number(process.env.ASSESSMENT_GEN_STALE_MS) || 15 * 60 * 1000;
}

/**
 * Pure: has this run's heartbeat gone quiet long enough to declare its process
 * dead? Exported for unit tests and reused by every caller that gates on
 * "is generation running", so the three call sites cannot drift apart.
 */
function isRunStale(generationRun, now = Date.now()) {
  if (!generationRun || generationRun.status !== "running") return false;
  // Runs that predate heartbeats — or that died before finishing their first
  // item — have no heartbeat to read, so fall back to when the run started.
  const last = generationRun.heartbeatAt || generationRun.startedAt;
  if (!last) return true;
  return now - new Date(last).getTime() > runStaleMs();
}

/** True only when a run is genuinely alive — the predicate the 409 guards want. */
function isRunActive(generationRun, now = Date.now()) {
  return generationRun?.status === "running" && !isRunStale(generationRun, now);
}

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

// --- Spec building (deterministic) -------------------------------------------

// Round-robin item types per criterion so a section isn't 100% mcq_single.
// numeric/ordering appear sparsely — they're harder to generate unambiguously.
const TYPE_CYCLE = ["mcq_single", "mcq_single", "mcq_multi", "mcq_single", "ordering", "mcq_single", "mcq_multi", "numeric"];

const TIERS = ["easy", "medium", "hard"];

/**
 * How many items generation will actually build for ONE section, and how that
 * number is arrived at. Pure — no rubric, no I/O.
 *
 * This exists because the recruiter only ever sets `servedItemCount` ("questions
 * served"), while generation runs off `poolItemCount`, and in claim_tiered mode
 * off poolItemCount × 3 tiers. That gap is intentional (a pool bigger than the
 * served count is what makes every candidate's draw different, and it absorbs
 * items the blind-solve gate flags) but it was invisible: a section serving 5
 * could silently generate 24. buildSpecs is now written in terms of this
 * function and the editor renders it, so the number the recruiter sees before
 * spending is exactly the number that gets built.
 */
function sectionPlan(section, mode) {
  if (mode === "claim_tiered") {
    const perTier = Math.min(section.poolItemCount, poolCapPerTier());
    return {
      sectionId: section.id,
      title: section.title,
      servedItemCount: section.servedItemCount,
      poolItemCount: section.poolItemCount,
      perTier,
      tiers: TIERS.length,
      planned: perTier * TIERS.length,
    };
  }
  const mix = section.difficultyMix || {};
  const total = Math.max(1, (mix.easy || 0) + (mix.medium || 0) + (mix.hard || 0));
  const scale = section.poolItemCount / total;
  const counts = {
    easy: Math.round((mix.easy || 0) * scale),
    medium: Math.round((mix.medium || 0) * scale),
    hard: Math.round((mix.hard || 0) * scale),
  };
  return {
    sectionId: section.id,
    title: section.title,
    servedItemCount: section.servedItemCount,
    poolItemCount: section.poolItemCount,
    perTier: null,
    tiers: 1,
    counts,
    planned: counts.easy + counts.medium + counts.hard,
  };
}

/**
 * The whole paper's generation plan — what a "Generate items" click will cost,
 * before it is clicked. `capped` means the per-paper ceiling will truncate the
 * plan, which the editor must say out loud rather than let the recruiter believe
 * every section got its full pool (rule 5: a degraded outcome is labelled).
 */
function generationPlan(paper) {
  const mode = paper?.difficultyPolicy?.mode || "fixed";
  const sections = (paper?.sections || []).map((s) => sectionPlan(s, mode));
  const uncappedTotal = sections.reduce((n, s) => n + s.planned, 0);
  const paperCap = maxItemsPerPaper();
  return {
    mode,
    sections,
    uncappedTotal,
    total: Math.min(uncappedTotal, paperCap),
    paperCap,
    capped: uncappedTotal > paperCap,
  };
}

/**
 * Expand a paper's sections into concrete item specs.
 * fixed mode        → one pool per section following the section's difficultyMix,
 *                     scaled to poolItemCount.
 * claim_tiered mode → one pool PER TIER per section (all items of that tier's
 *                     difficulty), each capped at poolCapPerTier().
 */
function buildSpecs(paper, rubric) {
  const criteriaById = new Map(rubric.criteria.map((c) => [c.id, c]));
  const specs = [];
  let typeCursor = 0;

  const pushSpec = (section, criterionId, difficulty) => {
    const criterion = criteriaById.get(criterionId);
    if (!criterion) return;
    specs.push({
      sectionId: section.id,
      criterionId,
      criterion,
      difficulty,
      type: TYPE_CYCLE[typeCursor++ % TYPE_CYCLE.length],
      probeHint: criterion.probeHint || "",
    });
  };

  const mode = paper.difficultyPolicy?.mode || "fixed";
  for (const section of paper.sections) {
    const plan = sectionPlan(section, mode);
    if (mode === "claim_tiered") {
      for (const tier of TIERS) {
        for (let i = 0; i < plan.perTier; i++) {
          pushSpec(section, section.criterionIds[i % section.criterionIds.length], tier);
        }
      }
    } else {
      let i = 0;
      for (const difficulty of TIERS) {
        for (let n = 0; n < plan.counts[difficulty]; n++) {
          pushSpec(section, section.criterionIds[i++ % section.criterionIds.length], difficulty);
        }
      }
    }
  }
  return specs.slice(0, maxItemsPerPaper());
}

// --- Shape validation (code, not the model) ----------------------------------

/** Map the model's index-based key onto stable option ids; null = malformed. */
function normaliseGenerated(spec, data) {
  const stem = typeof data.stem === "string" ? data.stem.trim() : "";
  if (!stem) return null;
  const optionTexts = (Array.isArray(data.options) ? data.options : []).map((t) => String(t || "").trim()).filter(Boolean);
  const keyIndexes = Array.isArray(data.keyIndexes) ? data.keyIndexes.filter((n) => Number.isInteger(n)) : [];

  const options = optionTexts.slice(0, OPTION_IDS.length).map((text, i) => ({ id: OPTION_IDS[i], text }));
  const validIndex = (i) => i >= 0 && i < options.length;

  let key;
  switch (spec.type) {
    case "mcq_single":
      if (options.length !== 4 || keyIndexes.length !== 1 || !validIndex(keyIndexes[0])) return null;
      key = { optionIds: [options[keyIndexes[0]].id] };
      break;
    case "mcq_multi": {
      if (options.length < 4 || keyIndexes.length < 2 || keyIndexes.length > 3) return null;
      const unique = [...new Set(keyIndexes)];
      if (unique.length !== keyIndexes.length || !unique.every(validIndex)) return null;
      key = { optionIds: unique.map((i) => options[i].id).sort() };
      break;
    }
    case "numeric": {
      const value = Number(data.keyValue);
      if (!Number.isFinite(value)) return null;
      const tolerance = Number.isFinite(Number(data.keyTolerance)) ? Math.abs(Number(data.keyTolerance)) : 0;
      key = { value, tolerance };
      return { stem, options: [], key };
    }
    case "ordering": {
      if (options.length !== 4 || keyIndexes.length !== 4) return null;
      const unique = [...new Set(keyIndexes)];
      if (unique.length !== 4 || !unique.every(validIndex)) return null;
      key = { order: keyIndexes.map((i) => options[i].id) };
      break;
    }
    default:
      return null;
  }
  return { stem, options, key };
}

/** Compare one blind solver's answer with the key — pure code, exported for tests. */
function solverAgreesWithKey(type, key, answer) {
  const ids = (Array.isArray(answer?.answerOptionIds) ? answer.answerOptionIds : [])
    .map((s) => String(s || "").trim().toLowerCase())
    .filter(Boolean);
  switch (type) {
    case "mcq_single":
      return ids.length === 1 && ids[0] === key.optionIds[0];
    case "mcq_multi": {
      if (ids.length !== key.optionIds.length) return false;
      const set = new Set(ids);
      return key.optionIds.every((id) => set.has(id));
    }
    case "numeric": {
      const value = Number(answer?.answerValue);
      if (!Number.isFinite(value)) return false;
      return Math.abs(value - key.value) <= (key.tolerance || 0);
    }
    case "ordering":
      return ids.length === key.order.length && ids.every((id, i) => id === key.order[i]);
    default:
      return false;
  }
}

// --- LLM calls ---------------------------------------------------------------

async function callGen(spec, settings, companyId, revisionNote, freshNote) {
  const resolved = resolveRole("reasoning", settings);
  const t0 = Date.now();
  const { data, usage, model, cached } = await llm.generateJSON({
    system: ITEM_GEN_SYSTEM,
    prompt: itemGenPrompt({ ...spec, revisionNote, freshNote }),
    schema: ITEM_GEN_SCHEMA,
    maxTokens: 1024,
    model: resolved.model,
    temperature: 0,
    promptVersion: ITEM_GEN_PROMPT_VERSION,
  });
  await usageService.recordUsage({
    company: companyId,
    kind: "item_gen",
    provider: PROVIDER,
    model,
    usage,
    latencyMs: Date.now() - t0,
    engine: "ai",
    promptVersion: ITEM_GEN_PROMPT_VERSION,
    cached,
  });
  return { data, model };
}

// Presents the options to solver #i in a rotated order — a cheap perturbation so
// three solvers don't share position bias. The struct passed to
// buildSolverPrompt contains stem + options ONLY; the key cannot leak because
// this function never receives it (unit-pinned).
async function callSolver({ type, stem, options }, solverIndex, settings, companyId) {
  const rotated = options.length
    ? options.slice(solverIndex % options.length).concat(options.slice(0, solverIndex % options.length))
    : [];
  const resolved = resolveRole("cheap", settings);
  const t0 = Date.now();
  const { data, usage, model, cached } = await llm.generateJSON({
    system: SOLVER_SYSTEM,
    prompt: buildSolverPrompt({ type, stem, options: rotated }),
    schema: SOLVER_SCHEMA,
    maxTokens: 256,
    model: resolved.model,
    temperature: 0,
    // Solver index in the promptVersion keeps the N calls from collapsing into
    // one cache entry (the deterministic cache keys on the full request shape).
    promptVersion: `${SOLVER_PROMPT_VERSION}#s${solverIndex}`,
  });
  await usageService.recordUsage({
    company: companyId,
    kind: "item_solve",
    provider: PROVIDER,
    model,
    usage,
    latencyMs: Date.now() - t0,
    engine: "ai",
    promptVersion: SOLVER_PROMPT_VERSION,
    cached,
  });
  return data;
}

async function blindSolve(spec, generated, settings, companyId, budget) {
  const answers = [];
  let agreed = 0;
  for (let i = 0; i < SOLVER_N; i++) {
    budget.spendCall();
    const answer = await callSolver({ type: spec.type, stem: generated.stem, options: generated.options }, i, settings, companyId);
    answers.push(answer);
    if (solverAgreesWithKey(spec.type, generated.key, answer)) agreed += 1;
  }
  return { n: SOLVER_N, agreedWithKey: agreed, solverAnswers: answers };
}

function describeDisagreement(spec, generated, solve) {
  const wrong = solve.solverAnswers
    .filter((a) => !solverAgreesWithKey(spec.type, generated.key, a))
    .map((a) => (spec.type === "numeric" ? String(a?.answerValue) : (a?.answerOptionIds || []).join(",")));
  return `${solve.agreedWithKey}/${solve.n} solvers agreed with the key; dissenting answers: [${wrong.join(" | ")}]`;
}

// --- One item through the full gate ------------------------------------------

// `seed` optionally cache-busts and steers the FIRST generation call — used by
// regenerateItem so a deliberate "try again" click can't silently replay the
// same deterministic (temperature-0) cache entry as the item it's replacing.
// { revisionNote } names a specific disagreement to fix; { freshNote } asks
// for a different take with no implication the prior one was wrong.
async function produceItem(spec, itemId, settings, companyId, budget, seed = {}) {
  budget.spendCall();
  let { data, model } = await callGen(spec, settings, companyId, seed.revisionNote, seed.freshNote);
  let generated = normaliseGenerated(spec, data);
  if (!generated) return null; // malformed shape — counted as failed, never kept

  let solve = await blindSolve(spec, generated, settings, companyId, budget);
  let revisions = 0;

  if (solve.agreedWithKey !== solve.n) {
    // One revision cycle with the disagreement fed back, then re-solve.
    revisions = 1;
    budget.spendCall();
    const revision = await callGen(spec, settings, companyId, describeDisagreement(spec, generated, solve));
    const revised = normaliseGenerated(spec, revision.data);
    if (revised) {
      generated = revised;
      model = revision.model;
      solve = await blindSolve(spec, generated, settings, companyId, budget);
    }
  }

  const passed = solve.agreedWithKey === solve.n;
  return {
    id: itemId,
    sectionId: spec.sectionId,
    criterionId: spec.criterionId,
    targetsProbeHint: Boolean(spec.probeHint),
    type: spec.type,
    stem: generated.stem,
    options: generated.options,
    key: generated.key,
    difficulty: spec.difficulty,
    rationale: typeof data.rationale === "string" ? data.rationale : "",
    generation: {
      model,
      promptVersion: ITEM_GEN_PROMPT_VERSION,
      at: new Date(),
      blindSolve: { ...solve, revisions },
    },
    status: passed ? "active" : "flagged",
  };
}

// --- The run (async, resumable, budget-capped) -------------------------------

function makeBudget(alreadySpent = 0) {
  const ceiling = maxLlmCallsPerPaper();
  let calls = alreadySpent;
  return {
    spendCall() {
      calls += 1;
      if (calls > ceiling) {
        throw httpError(429, `Per-paper generation ceiling reached (${ceiling} LLM calls) — the partial pool is kept`, "PAPER_GEN_CEILING");
      }
    },
    get calls() {
      return calls;
    },
  };
}

/**
 * Generate the item pools for a draft paper. Long-running: callers fire this
 * without awaiting and poll paper.generationRun. Items persist as they pass, so
 * a crash or budget stop resumes where it left off (specs already covered by
 * existing items are skipped).
 */
async function runGeneration(paperId, companyId) {
  const paper = await AssessmentPaper.findOne({ _id: paperId, company: companyId });
  if (!paper) throw httpError(404, "Assessment paper not found");
  if (paper.status !== "draft") throw httpError(409, "Items can only be generated on a draft paper");
  if (isRunActive(paper.generationRun)) throw httpError(409, "Generation is already running for this paper");
  if (paper.generationRun?.status === "running") {
    // Stale — the process that owned this run is gone. Take it over rather than
    // refusing forever; the pool built so far is kept and resumed.
    console.warn(
      `[itemGen] taking over a stale run on paper ${paper._id} (last heartbeat ${paper.generationRun.heartbeatAt || paper.generationRun.startedAt})`
    );
  }
  if (!llm.isEnabled()) {
    throw httpError(503, "Assessment generation needs the AI engine (no LLM key configured) — there is no template fallback", "ASSESSMENT_LLM_UNAVAILABLE");
  }

  const settings = await CompanySettings.findOne({ company: companyId }).select("ai assessments");
  if (await usageService.isOverBudget(companyId, settings?.ai)) {
    throw httpError(429, "Monthly AI budget exhausted — item generation blocked", "AI_BUDGET_EXHAUSTED");
  }
  const rubric = await RoleRubric.findById(paper.rubric);
  if (!rubric) throw httpError(409, "The paper's rubric no longer exists — recompile the paper");

  const specs = buildSpecs(paper, rubric);

  // Resume support: count how many items already exist per (section, difficulty)
  // and skip that many specs.
  const have = new Map();
  for (const item of paper.items) {
    const k = `${item.sectionId}|${item.difficulty}`;
    have.set(k, (have.get(k) || 0) + 1);
  }
  const pending = [];
  const consumed = new Map();
  for (const spec of specs) {
    const k = `${spec.sectionId}|${spec.difficulty}`;
    const used = consumed.get(k) || 0;
    if (used < (have.get(k) || 0)) consumed.set(k, used + 1);
    else pending.push(spec);
  }

  paper.generationRun = {
    status: "running",
    startedAt: new Date(),
    heartbeatAt: new Date(),
    generated: paper.items.filter((i) => i.status === "active").length,
    flagged: paper.items.filter((i) => i.status === "flagged").length,
    failed: 0,
    target: specs.length,
    message: "",
  };
  await paper.save();

  const budget = makeBudget();
  let itemSeq = paper.items.length;

  // Stamp liveness and persist. Called on EVERY iteration, including the ones
  // that produce no item — a run grinding through failures is still alive, and
  // without this its heartbeat would go quiet and invite a takeover.
  const beat = async () => {
    paper.generationRun.heartbeatAt = new Date();
    await paper.save();
  };

  try {
    for (const spec of pending) {
      // Re-check the tenant budget between items — a long run must not blow
      // through a cap that filled up while it was running.
      if (await usageService.isOverBudget(companyId, settings?.ai)) {
        paper.generationRun.message = "Stopped: monthly AI budget exhausted mid-run. The partial pool is kept — resume after raising the cap.";
        break;
      }
      let item = null;
      try {
        item = await produceItem(spec, `it${++itemSeq}`, settings, companyId, budget);
      } catch (err) {
        if (err.code === "PAPER_GEN_CEILING") {
          paper.generationRun.message = err.message;
          break;
        }
        console.warn(`[itemGen] item generation failed (${spec.sectionId}/${spec.criterionId}): ${err.code || err.message}`);
        paper.generationRun.failed += 1;
        await beat();
        continue;
      }
      if (!item) {
        paper.generationRun.failed += 1;
        await beat();
        continue;
      }
      paper.items.push(item);
      if (item.status === "active") paper.generationRun.generated += 1;
      else paper.generationRun.flagged += 1;
      paper.markModified("items");
      await beat(); // persist as we go — the run is resumable by design
    }
    paper.generationRun.status = "completed";
  } catch (err) {
    paper.generationRun.status = "failed";
    paper.generationRun.message = err.message;
  }
  paper.generationRun.finishedAt = new Date();
  await paper.save();
  return paper;
}

/**
 * Regenerate ONE item on a draft (recruiter reviewed it and wants a fresh take).
 * The old item is replaced in place; provenance and the blind-solve result are
 * fresh. Draft-only — post-freeze regeneration means a new paper version.
 */
async function regenerateItem(paperId, companyId, itemId) {
  const paper = await AssessmentPaper.findOne({ _id: paperId, company: companyId });
  if (!paper) throw httpError(404, "Assessment paper not found");
  if (paper.status !== "draft") throw httpError(409, "Items can only be regenerated on a draft paper — approve creates a frozen version");
  const idx = paper.items.findIndex((i) => i.id === itemId);
  if (idx === -1) throw httpError(404, "Item not found on this paper");
  if (!llm.isEnabled()) throw httpError(503, "Assessment generation needs the AI engine (no LLM key configured)", "ASSESSMENT_LLM_UNAVAILABLE");

  const settings = await CompanySettings.findOne({ company: companyId }).select("ai");
  if (await usageService.isOverBudget(companyId, settings?.ai)) {
    throw httpError(429, "Monthly AI budget exhausted — regeneration blocked", "AI_BUDGET_EXHAUSTED");
  }
  const rubric = await RoleRubric.findById(paper.rubric);
  const old = paper.items[idx];
  const criterion = rubric?.criteria.find((c) => c.id === old.criterionId);
  if (!criterion) throw httpError(409, "The item's criterion no longer exists on the rubric");

  const spec = {
    sectionId: old.sectionId,
    criterionId: old.criterionId,
    criterion,
    difficulty: old.difficulty,
    type: old.type,
    probeHint: criterion.probeHint || "",
  };
  // Same spec as the original generation ⇒ same prompt ⇒ a same-day regenerate
  // would otherwise hit the temperature-0 cache and hand back the identical
  // flagged item. Seed the call with something that changes the prompt text
  // itself: the recorded disagreement for a flagged item (which also steers
  // the model away from the exact ambiguity that got it rejected), or a
  // generic "different take" note for a recruiter regenerating an active one.
  const oldSolve = old.generation?.blindSolve;
  const seed =
    old.status === "flagged" && oldSolve
      ? { revisionNote: describeDisagreement(spec, { stem: old.stem, options: old.options, key: old.key }, oldSolve) }
      : {
          freshNote:
            "The recruiter asked for a different take on this criterion — write a genuinely different question " +
            "(different scenario, numbers, or phrasing) than a typical version, not a reword of the same one.",
        };
  const budget = makeBudget();
  const fresh = await produceItem(spec, old.id, settings, companyId, budget, seed);
  if (!fresh) throw httpError(502, "Regeneration produced a malformed item — try again");

  paper.items[idx] = fresh;
  paper.markModified("items");
  await paper.save();
  return paper;
}

/**
 * Boot-time cleanup (called from server.js after the DB connects). A run whose
 * heartbeat went quiet belongs to a process that no longer exists, so nothing
 * will ever write its terminal status. Flip it to `failed` with an honest,
 * actionable message instead of leaving the paper pinned at `running` — rule 5:
 * a degraded state must be labelled, never rendered as if it were still working.
 *
 * Heartbeat-gated rather than reclaiming every `running` run on sight, because
 * with more than one API instance a peer's genuinely LIVE run must not be killed
 * just because this instance restarted.
 */
async function reconcileInterruptedRuns() {
  return tenantContext.runAsSystem(async () => {
    const papers = await AssessmentPaper.find({ "generationRun.status": "running" });
    let reclaimed = 0;
    for (const paper of papers) {
      if (!isRunStale(paper.generationRun)) continue; // a live run elsewhere — leave it alone
      const done = paper.items.filter((i) => i.status !== "retired").length;
      paper.generationRun.status = "failed";
      paper.generationRun.finishedAt = new Date();
      paper.generationRun.message =
        `Generation was interrupted before it finished (the server restarted or the run was killed). ` +
        `The ${done} item(s) already through the blind-solve gate were kept — click "Resume / top-up generation" to continue from there.`;
      await paper.save();
      reclaimed += 1;
    }
    if (reclaimed) console.warn(`[itemGen] reconciled ${reclaimed} interrupted generation run(s) on startup`);
    return reclaimed;
  });
}

module.exports = {
  runGeneration,
  regenerateItem,
  buildSpecs,
  sectionPlan,
  generationPlan,
  normaliseGenerated,
  solverAgreesWithKey,
  isRunStale,
  isRunActive,
  reconcileInterruptedRuns,
};
