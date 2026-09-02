// Spoken communication, scored fairly — or not scored at all.
//
// ---------------------------------------------------------------------------
// WHY THE OLD VERSION HAD TO GO, AND WHAT REPLACED IT
// ---------------------------------------------------------------------------
//
// The previous `delivery` and `confidence` scores were computed from how the candidate SOUNDED:
// words per minute, filler rate, pause ratio. Every one of those is a proxy for something a
// hiring decision may not rest on:
//
//   pace        — non-native speakers of the interview language speak measurably slower in it
//   filler rate — higher for people who think aloud, for anyone nervous, and for several
//                 speech and neurodevelopmental differences
//   pause ratio — higher with a stammer, a slow connection, or simply a considered thinker
//
// Presentation was never the problem. Softening the label, moving the bars lower on the page, or
// adding a caveat would have left the same numbers deciding the same outcomes. The INPUTS were
// the problem, so the inputs changed.
//
// THE FIX: measure communication from the TRANSCRIPT, not from the AUDIO.
//
// A transcript is accent-neutral by construction. The same words are the same words whether they
// were said quickly or slowly, in Lagos or Leeds, fluently or haltingly. What differs between a
// clear answer and an unclear one is what was actually communicated — whether it addressed the
// question, whether it was concrete, whether a listener who was not there could follow it. That
// is what a human interviewer means by "they explained that well", and it is measurable without
// ever touching the sound of someone's voice.
//
// A worked consequence, and the test that pins it: a hesitant speaker who gives a structured,
// specific answer now scores ABOVE a fluent speaker who gives a vague one. Under the old scorer
// it was the exact reverse, and that reversal is the whole reason this file exists.
//
// ---------------------------------------------------------------------------
// `confidence` MEANS SOMETHING DIFFERENT NOW, AND THE DIFFERENCE IS THE POINT
// ---------------------------------------------------------------------------
//
// It used to mean "sounds self-assured" — filler rate times four, plus a hesitation penalty. That
// is a personality read, it correlates with gender and culture, and for almost every role it is
// not job-related.
//
// It now means CALIBRATION: did they distinguish what they knew from what they did not? An
// engineer who says "I'm not certain of the exact figure, but the order of magnitude was
// thousands" is more useful than one who states a wrong number without hesitation — and the first
// is the one the old scorer punished. The bias direction is inverted deliberately: hedging is now
// evidence of good calibration rather than of weakness, and confident overclaiming is what costs.
//
// ---------------------------------------------------------------------------
// THE RULES THIS SCORE LIVES UNDER
// ---------------------------------------------------------------------------
//
// 1. OFF unless the rubric declares it. Assessing spoken communication is legitimate when the job
//    genuinely requires it and indefensible when it does not, and that is not a judgement code can
//    make. A human declares it on the versioned RoleRubric, with a written justification of why
//    this role needs it, and that declaration is frozen with the rubric.
// 2. The model extracts; CODE scores. Every feature below is a yes/no observation with a verbatim
//    span, verified against the transcript. Uncited features are dropped, not trusted.
// 3. It can never produce an adverse action by itself. It is reported alongside the competency
//    scores and may route to a human; it does not enter the overall score and cannot reject.
// 4. The candidate is told, before they start, that it is being assessed and why.
// 5. It is excluded on request, and the exclusion is recorded rather than silently applied.

// ---------------------------------------------------------------------------
// The features the model may observe
// ---------------------------------------------------------------------------
//
// Deliberately yes/no rather than 0-10. A model asked "rate the clarity out of ten" returns its
// overall impression of the candidate wearing a number; asked "did they give a concrete example,
// and quote it", it returns a fact that can be checked against the transcript. The arithmetic is
// this file's job.

const FEATURES = {
  // --- Clarity (feeds `delivery`) -------------------------------------------
  // Did they address what was actually asked, rather than an adjacent thing?
  answersTheQuestion: { weight: 30, dimension: "delivery" },
  // A specific instance — a system, a number, a decision, a moment — rather than a description
  // of how one generally does this kind of work.
  hasConcreteExample: { weight: 25, dimension: "delivery" },
  // Jargon they introduced is explained, or none needed explaining. NOT "used simple words":
  // precise technical language used precisely is good communication, not bad.
  termsAreExplained: { weight: 20, dimension: "delivery" },
  // Could a listener who was not there follow it? Catches dangling "it", "they", "that thing"
  // with no antecedent — the single most common reason a real answer is hard to follow.
  referencesAreResolvable: { weight: 25, dimension: "delivery" },

  // --- Calibration (feeds `confidence`) -------------------------------------
  // They marked the boundary of what they knew. REWARDED, not penalised.
  statedUncertaintyWhereItExisted: { weight: 30, dimension: "confidence" },
  // Specifics asserted flatly that the rest of the answer gives no basis for, or a claim that
  // contradicts something they said earlier. This is what costs.
  overclaimed: { weight: -35, dimension: "confidence" },
  // They distinguished what they did personally from what their team did. The most common way an
  // interview answer misleads, and a genuine communication property rather than a manner one.
  ownContributionIsClear: { weight: 25, dimension: "confidence" },
};

const FEATURE_NAMES = Object.keys(FEATURES);

// The extraction contract handed to the model. Every feature is `{ value, quote }` — the quote is
// verified as a literal substring of the transcript, and a feature that cannot be cited is
// dropped. Same rule the résumé claim graph lives under: cite or abstain.
const FEATURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    FEATURE_NAMES.map((name) => [
      name,
      {
        type: "object",
        additionalProperties: false,
        properties: {
          value: { type: "boolean" },
          quote: { type: "string" },
        },
        required: ["value", "quote"],
      },
    ])
  ),
  required: FEATURE_NAMES,
};

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function normalise(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Keep only the features the model could point at in the transcript.
 *
 * A `false` needs no quote — "they did not give a concrete example" has nothing to cite, and
 * demanding a quote for an absence would push the model to invent one. A `true` must be cited,
 * and an uncitable `true` is dropped rather than trusted, so a hallucinated strength cannot
 * become a point on someone's score.
 */
function verifyFeatures(raw, transcript) {
  const haystack = normalise(transcript);
  const out = {};
  for (const name of FEATURE_NAMES) {
    const f = raw?.[name];
    if (!f || typeof f.value !== "boolean") continue;
    if (f.value === false) {
      out[name] = { value: false, quote: "" };
      continue;
    }
    const quote = normalise(f.quote);
    // Short quotes match by accident. Anything under a few words is not evidence of anything.
    if (!quote || quote.split(" ").length < 3) continue;
    if (!haystack.includes(quote)) continue;
    out[name] = { value: true, quote: String(f.quote || "").trim() };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoring — arithmetic in code, never in the model
// ---------------------------------------------------------------------------

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Score one dimension from verified features.
 *
 * Returns undefined when too few features could be verified to mean anything — an honest gap
 * beats a fabricated number, exactly as with an unscored answer. `available` is reported so the
 * caller can say what the score is actually over.
 */
function scoreDimension(features, dimension) {
  const relevant = FEATURE_NAMES.filter((n) => FEATURES[n].dimension === dimension);
  const present = relevant.filter((n) => features[n] !== undefined);
  // Under half the evidence is not a low score, it is not a measurement.
  if (present.length < Math.ceil(relevant.length / 2)) {
    return { score: undefined, available: present.length, total: relevant.length };
  }

  // Positive weights are what is achievable; a negative weight (overclaiming) is a deduction from
  // it rather than part of the denominator, so being penalised cannot also shrink the scale.
  const positives = present.filter((n) => FEATURES[n].weight > 0);
  const possible = positives.reduce((s, n) => s + FEATURES[n].weight, 0);
  if (!possible) return { score: undefined, available: present.length, total: relevant.length };

  let earned = 0;
  for (const n of positives) if (features[n].value) earned += FEATURES[n].weight;
  let penalty = 0;
  for (const n of present) if (FEATURES[n].weight < 0 && features[n].value) penalty += -FEATURES[n].weight;

  const raw = (earned / possible) * 100 - penalty;
  return { score: Math.round(clamp(raw, 0, 100)), available: present.length, total: relevant.length };
}

/**
 * Score one answer. `transcript` is the candidate's words; `raw` is the model's extraction.
 */
function scoreAnswer(raw, transcript) {
  const features = verifyFeatures(raw, transcript);
  const delivery = scoreDimension(features, "delivery");
  const confidence = scoreDimension(features, "confidence");
  return {
    features,
    delivery: delivery.score,
    confidence: confidence.score,
    // What the numbers are over. Travels with them everywhere, so "72" can never be read as if it
    // rested on more evidence than it did.
    evidence: {
      delivery: { verified: delivery.available, of: delivery.total },
      confidence: { verified: confidence.available, of: confidence.total },
    },
  };
}

function mean(nums) {
  const vals = nums.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (!vals.length) return undefined;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

/**
 * Aggregate across an interview's answers.
 *
 * Note what is NOT an input: `acoustic`. Nothing about how the candidate sounded reaches this
 * function, which is what makes the result accent-neutral by construction rather than by
 * intention — there is no path through this file from a microphone to a score.
 */
function aggregate(turns) {
  const scored = (turns || []).filter(
    (t) => t.role === "candidate" && t.kind === "answer" && !t.declined && t.communication
  );
  if (!scored.length) return null;
  const delivery = mean(scored.map((t) => t.communication.delivery));
  const confidence = mean(scored.map((t) => t.communication.confidence));
  if (delivery === undefined && confidence === undefined) return null;
  return { delivery, confidence, answersScored: scored.length };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Is this role allowed to assess spoken communication at all?
 *
 * Off unless a human declared it on the versioned rubric AND wrote down why the role requires it.
 * The justification is not paperwork: job-relatedness is the entire legal basis for assessing how
 * someone speaks, and a declaration with no stated reason is not one.
 *
 * A candidate-level exclusion (an accommodation) always wins.
 */
function isEnabled(rubric, { excluded = false } = {}) {
  if (excluded) return false;
  const d = rubric?.spokenCommunication;
  if (!d?.enabled) return false;
  return Boolean(String(d.justification || "").trim());
}

module.exports = {
  FEATURES,
  FEATURE_NAMES,
  FEATURE_SCHEMA,
  verifyFeatures,
  scoreDimension,
  scoreAnswer,
  aggregate,
  isEnabled,
};
