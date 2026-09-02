// Cognitive Insights and Communication Skills — the two rated panels on the report.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS RATHER THAN A PROMPT THAT RETURNS THIRTEEN NUMBERS
// ---------------------------------------------------------------------------
//
// The obvious way to build these panels is to ask a model to rate the candidate
// 1-5 on "Logical Reasoning", "Grammar", "Insightfulness" and so on, and print
// what comes back. Every product in this category does exactly that. It is also
// the pattern utils/communication.js was rewritten to remove, for a reason worth
// restating rather than assuming:
//
//   A model asked "rate their clarity out of five" does not measure clarity. It
//   returns its overall impression of the candidate wearing a number. The number
//   moves with fluency, with name, with how closely the speaker resembles the
//   training distribution — and it moves invisibly, because there is nothing
//   underneath it to inspect. A reviewer who disagrees with a 2 has nothing to
//   disagree WITH.
//
// So the model is never asked for a rating here. It is asked for OBSERVATIONS:
// yes/no questions about the transcript, each answered with a verbatim quote.
// Code verifies every quote is literally present in what the candidate said,
// drops any that is not, and then does the arithmetic. The star rating is a
// function of verified observations, computed here, deterministically.
//
// The consequences are the point:
//   - A hallucinated strength cannot become a point on someone's score, because
//     an uncitable observation is discarded before the arithmetic runs.
//   - Every rating expands to the evidence that produced it. The reference
//     product prints a confident paragraph and asks you to trust it; this prints
//     the spans, and a reviewer can overrule it with the transcript in hand.
//   - Too little evidence yields `undefined`, not a low score. "We could not
//     measure this" and "they did this badly" are different findings, and this
//     file will not conflate them.
//
// ---------------------------------------------------------------------------
// GRAMMAR IS DIFFERENT, AND IS GATED DIFFERENTLY
// ---------------------------------------------------------------------------
//
// Grammar is the one axis where the instrument itself is biased. We do not have
// the candidate's words; we have a speech recogniser's guess at them, and that
// guess degrades measurably on accented speech, on poor connections, and on the
// names and domain terms the recogniser has never seen. Scoring grammar off that
// transcript charges the recogniser's errors to the speaker — and charges them
// hardest to exactly the speakers already disadvantaged by it.
//
// Two guards, both hard:
//   1. An error span counts only where the recogniser's own confidence for that
//      stretch of audio was at or above GRAMMAR_MIN_CONFIDENCE. Below it we
//      cannot tell a candidate's error from a transcription error, so we decline
//      to guess. Excluded spans are COUNTED AND REPORTED, not silently dropped:
//      "we ignored 6 spans we could not trust" is information the reviewer needs.
//   2. If the answer is too short, or the transcript too unreliable, the axis
//      returns undefined rather than a rating over whatever fragments survived.
//
// Normal features of speech are not errors and are never counted: false starts,
// repetition, self-correction, missing punctuation (the recogniser inserts it),
// and contractions. That list is in the prompt, and it is enforced here.

const GRAMMAR_MIN_CONFIDENCE = 0.75;
// An answer shorter than this is not a writing sample. Two clumsy clauses out of
// fifteen words is a 13% error rate that means nothing.
const GRAMMAR_MIN_WORDS = 20;
// And below THIS, no axis is scored at all.
//
// Without this floor a six-word answer scores 0 out of 5 on Vocabulary and
// Coherence, because the model correctly answers "no" to every observable and
// code correctly turns four noes into a zero. Both halves behave exactly as
// designed and the result is still wrong: nobody can demonstrate range of
// vocabulary in six words, so a 0 there is a measurement of the QUESTION — how
// short an answer it invited — wearing the candidate's name.
//
// "They said very little" is a real and often important finding. It belongs in
// the answered/asked count and in the transcript, where it is legible as what it
// is, and not smuggled into thirteen separate ratings.
const MIN_WORDS_TO_OBSERVE = 12;
// A verified quote must be long enough that matching it is not an accident.
const MIN_QUOTE_WORDS = 3;

// ---------------------------------------------------------------------------
// The observations the model may make
// ---------------------------------------------------------------------------
//
// Each is a yes/no question about the transcript with a citable answer. Negative
// weights are deductions from what was achievable rather than part of the
// denominator, so being marked down cannot also shrink the scale.
//
// A `false` needs no quote — "they did not weigh an alternative" has nothing to
// cite, and demanding a quote for an absence is how you get an invented one.

const AXES = {
  // --- Cognitive ------------------------------------------------------------
  logicalReasoning: {
    panel: "cognitive",
    label: "Logical Reasoning",
    hint: "Do the steps actually lead to the conclusion?",
    indicators: {
      reasonsFromPremiseToConclusion: 30,
      stepsAreOrdered: 25,
      conclusionFollowsFromTheSteps: 25,
      containsANonSequitur: -30,
    },
  },
  criticalThinking: {
    panel: "cognitive",
    label: "Critical Thinking",
    hint: "Did they interrogate the problem rather than accept it as given?",
    indicators: {
      weighedAnAlternative: 30,
      namedATradeoff: 30,
      questionedAnAssumption: 25,
      acceptedThePremiseUncritically: -20,
    },
  },
  problemSolving: {
    panel: "cognitive",
    label: "Problem Solving",
    hint: "Did they get from the problem to something that was actually done?",
    indicators: {
      identifiedARootCause: 30,
      proposedAConcreteAction: 30,
      describedTheOutcome: 25,
      stoppedAtDescribingTheProblem: -25,
    },
  },
  bigPictureThinking: {
    panel: "cognitive",
    label: "Big-picture Thinking",
    hint: "Did they connect the task to anything beyond the task?",
    indicators: {
      connectedItToBusinessImpact: 35,
      consideredDownstreamEffects: 35,
      relatedItToOtherTeamsOrSystems: 30,
    },
  },
  intellectualSelfAwareness: {
    panel: "cognitive",
    label: "Intellectual Self-Awareness",
    hint: "Did they mark the edge of what they knew, and of what they did?",
    indicators: {
      namedWhatTheyDidNotKnow: 30,
      describedAMistakeAndWhatChanged: 30,
      distinguishedTheirWorkFromTheTeams: 25,
      claimedCertaintyWithNoBasis: -30,
    },
  },
  insightfulness: {
    panel: "cognitive",
    label: "Insightfulness",
    hint: "Was there anything here a merely competent answer would not contain?",
    indicators: {
      offeredANonObviousObservation: 40,
      generalisedFromTheSpecificCase: 30,
      reframedTheQuestionUsefully: 30,
    },
  },
  clarity: {
    panel: "cognitive",
    label: "Clarity",
    hint: "Could a listener who was not there follow it?",
    indicators: {
      theAnswerHasAShape: 30,
      technicalTermsAreDefined: 25,
      pronounsHaveAntecedents: 25,
      theAnswerWanders: -25,
    },
  },
  decisionMaking: {
    panel: "cognitive",
    label: "Decision Making",
    hint: "Did they decide, on a stated basis, and own it?",
    indicators: {
      madeAnActualDecision: 35,
      statedTheCriterionTheyDecidedOn: 30,
      ownedTheConsequence: 25,
      deferredWithNoReason: -25,
    },
  },

  // --- Communication --------------------------------------------------------
  // Grammar is scored separately below; it appears here for its label and its
  // position in the panel.
  grammar: {
    panel: "communication",
    label: "Grammar",
    hint: "Counted only where the transcription is reliable enough to attribute.",
    special: "grammar",
  },
  comprehension: {
    panel: "communication",
    label: "Comprehension",
    hint: "Did they understand the question that was asked?",
    indicators: {
      answeredWhatWasActuallyAsked: 40,
      handledTheFollowUpWithoutRepeating: 30,
      askedForClarificationWhenTheQuestionWasUnclear: 30,
      answeredADifferentQuestion: -35,
    },
  },
  fluency: {
    panel: "communication",
    label: "Fluency",
    hint: "Sentences that reach their point — NOT speed, hesitation or accent.",
    indicators: {
      sentencesReachTheirPoint: 40,
      selfCorrectionsResolveCleanly: 30,
      abandonsSentencesMidThought: -35,
    },
  },
  vocabulary: {
    panel: "communication",
    label: "Vocabulary",
    hint: "Range and precision of word choice.",
    indicators: {
      usesTheDomainsOwnTerms: 35,
      choosesPreciseVerbsOverVagueOnes: 35,
      variesWordingRatherThanRepeatingOnePhrase: 30,
    },
  },
  coherence: {
    panel: "communication",
    label: "Coherence",
    hint: "Do the parts hold together, within an answer and across them?",
    indicators: {
      ideasConnectToEachOther: 35,
      theOrderIsFollowable: 30,
      noContradictionWithinTheAnswer: 25,
      contradictsSomethingSaidEarlier: -30,
    },
  },
};

const AXIS_NAMES = Object.keys(AXES);
const COGNITIVE_AXES = AXIS_NAMES.filter((a) => AXES[a].panel === "cognitive");
const COMMUNICATION_AXES = AXIS_NAMES.filter((a) => AXES[a].panel === "communication");
const SCORED_AXES = AXIS_NAMES.filter((a) => !AXES[a].special);

// Every indicator, flattened, with the axis it belongs to and its weight.
const INDICATORS = {};
for (const axis of SCORED_AXES) {
  for (const [name, weight] of Object.entries(AXES[axis].indicators)) {
    INDICATORS[name] = { axis, weight };
  }
}
const INDICATOR_NAMES = Object.keys(INDICATORS);

// ---------------------------------------------------------------------------
// The extraction contract handed to the model
// ---------------------------------------------------------------------------
//
// The same shape communication.js uses: every field is `{ value, quote }`, and
// the model returns observations, never numbers. `grammarErrors` is a list
// rather than a boolean because "how many" is the whole measurement there.

const INSIGHT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(
      INDICATOR_NAMES.map((name) => [
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
    grammarErrors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          quote: { type: "string" },
          kind: { type: "string" },
        },
        required: ["quote", "kind"],
      },
    },
  },
  required: [...INDICATOR_NAMES, "grammarErrors"],
};

// ---------------------------------------------------------------------------
// Verification — a quote we cannot find is not evidence of anything
// ---------------------------------------------------------------------------

function normalise(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function wordCount(text) {
  const n = normalise(text);
  return n ? n.split(" ").length : 0;
}

/**
 * Keep only the observations the model could point at in the transcript.
 *
 * The same rule the résumé claim graph and communication.js live under: cite or
 * abstain. A `false` is kept without a quote (an absence has nothing to cite); a
 * `true` with no findable quote is DROPPED rather than trusted.
 */
function verifyObservations(raw, transcript) {
  const haystack = normalise(transcript);
  const out = {};
  for (const name of INDICATOR_NAMES) {
    const o = raw?.[name];
    if (!o || typeof o.value !== "boolean") continue;
    if (o.value === false) {
      out[name] = { value: false, quote: "" };
      continue;
    }
    const quote = normalise(o.quote);
    // Short quotes match by accident. Anything under a few words is not evidence.
    if (!quote || quote.split(" ").length < MIN_QUOTE_WORDS) continue;
    if (!haystack.includes(quote)) continue;
    out[name] = { value: true, quote: String(o.quote || "").trim() };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grammar — verified, then confidence-gated
// ---------------------------------------------------------------------------

/**
 * Keep the error spans that are both present in the transcript AND fell in a
 * stretch the recogniser was confident about.
 *
 * When we have no confidence figure at all we do not assume the transcript was
 * good. An unknown confidence is treated as untrustworthy, because the
 * alternative is charging a recogniser's guess to a candidate's accent.
 */
function verifyGrammarErrors(raw, transcript, confidence) {
  const haystack = normalise(transcript);
  const trusted = typeof confidence === "number" && confidence >= GRAMMAR_MIN_CONFIDENCE;
  const errors = [];
  let excluded = 0;
  for (const e of Array.isArray(raw?.grammarErrors) ? raw.grammarErrors : []) {
    const quote = normalise(e?.quote);
    if (!quote || quote.split(" ").length < MIN_QUOTE_WORDS) continue;
    if (!haystack.includes(quote)) continue;
    if (!trusted) {
      excluded += 1;
      continue;
    }
    errors.push({ quote: String(e.quote || "").trim(), kind: String(e.kind || "").trim() });
  }
  return { errors, excluded };
}

// Errors per hundred words, banded to stars. Deliberately coarse: the difference
// between 1.9 and 2.1 errors per hundred words is not one anybody should act on,
// and a finer scale would imply a precision this does not have.
function grammarStars(errorsPer100) {
  if (errorsPer100 <= 0.5) return 5;
  if (errorsPer100 <= 1.5) return 4.5;
  if (errorsPer100 <= 3) return 4;
  if (errorsPer100 <= 5) return 3.5;
  if (errorsPer100 <= 7) return 3;
  if (errorsPer100 <= 10) return 2.5;
  if (errorsPer100 <= 14) return 2;
  if (errorsPer100 <= 19) return 1.5;
  return 1;
}

// ---------------------------------------------------------------------------
// Scoring — arithmetic in code, never in the model
// ---------------------------------------------------------------------------

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// 0-100 to a half-star, which is the resolution the panel actually renders.
function toStars(pct) {
  return Math.round((pct / 100) * 10) / 2;
}

/**
 * Score one axis from verified observations.
 *
 * Returns `score: undefined` when under half its indicators could be verified.
 * That is not a low rating, it is the absence of one, and `available`/`total`
 * travel with the result so the panel can say what it is over.
 */
function scoreAxis(axis, observations) {
  const names = Object.keys(AXES[axis].indicators);
  const present = names.filter((n) => observations[n] !== undefined);
  // Under half the evidence is not a low score, it is not a measurement.
  if (present.length < Math.ceil(names.length / 2)) {
    return { score: undefined, available: present.length, total: names.length, observations: [] };
  }

  const positives = present.filter((n) => INDICATORS[n].weight > 0);
  const possible = positives.reduce((s, n) => s + INDICATORS[n].weight, 0);
  if (!possible) {
    return { score: undefined, available: present.length, total: names.length, observations: [] };
  }

  let earned = 0;
  for (const n of positives) if (observations[n].value) earned += INDICATORS[n].weight;
  let penalty = 0;
  for (const n of present) {
    if (INDICATORS[n].weight < 0 && observations[n].value) penalty += -INDICATORS[n].weight;
  }

  const pct = clamp((earned / possible) * 100 - penalty, 0, 100);
  return {
    score: toStars(pct),
    available: present.length,
    total: names.length,
    // Only observations found to be TRUE carry a quote, so this list is exactly
    // the evidence a reviewer can check. Adverse ones are marked, so the panel
    // can show what cost the candidate points as well as what earned them.
    observations: present
      .filter((n) => observations[n].value)
      .map((n) => ({ indicator: n, quote: observations[n].quote, adverse: INDICATORS[n].weight < 0 })),
  };
}

/**
 * Score one answer across every axis.
 *
 * `transcript` is the candidate's words; `raw` is the model's extraction;
 * `confidence` is the recogniser's confidence for this turn — used only by
 * grammar, and treated as untrustworthy when absent.
 */
function scoreAnswer(raw, transcript, confidence) {
  const words = wordCount(transcript);
  const observations = verifyObservations(raw, transcript);
  const axes = {};
  // Too short to observe anything from: every axis abstains, rather than turning
  // the model's honest run of "no"s into a row of zeroes. See MIN_WORDS_TO_OBSERVE.
  const tooShort = words < MIN_WORDS_TO_OBSERVE;
  for (const axis of SCORED_AXES) {
    axes[axis] = tooShort
      ? { score: undefined, available: 0, total: Object.keys(AXES[axis].indicators).length, observations: [], reason: "answer_too_short" }
      : scoreAxis(axis, observations);
  }

  const g = verifyGrammarErrors(raw, transcript, confidence);
  const trusted = typeof confidence === "number" && confidence >= GRAMMAR_MIN_CONFIDENCE;
  axes.grammar =
    trusted && words >= GRAMMAR_MIN_WORDS
      ? {
          score: grammarStars((g.errors.length / words) * 100),
          available: words,
          total: words,
          errors: g.errors,
          excluded: g.excluded,
          observations: g.errors.map((e) => ({ indicator: e.kind || "error", quote: e.quote, adverse: true })),
        }
      : {
          // NOT "perfect grammar". Not measured — because we could not trust the
          // transcript enough to attribute anything in it to the speaker.
          score: undefined,
          available: 0,
          total: words,
          errors: [],
          excluded: g.excluded + g.errors.length,
          observations: [],
          reason: words < GRAMMAR_MIN_WORDS ? "answer_too_short" : "transcription_unreliable",
        };

  return { axes, words };
}

function mean(nums) {
  const vals = nums.filter((n) => typeof n === "number" && Number.isFinite(n));
  if (!vals.length) return undefined;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 2) / 2;
}

/**
 * Aggregate the per-answer readings into the two panels the report renders.
 *
 * Note what is NOT an input, here as in communication.js: nothing acoustic. No
 * pace, no pause ratio, no filler rate. There is no path through this file from
 * a microphone to a rating.
 */
function aggregate(turns) {
  const scored = (turns || []).filter(
    (t) => t.role === "candidate" && t.kind === "answer" && !t.declined && t.insights
  );
  if (!scored.length) return null;

  const build = (axis) => {
    const readings = scored.map((t) => t.insights.axes?.[axis]).filter(Boolean);
    const score = mean(readings.map((r) => r.score));
    // Every verified quote across every answer, so expanding a row shows the
    // evidence itself rather than a summary of it.
    const observations = readings.flatMap((r) => r.observations || []);
    const excluded = readings.reduce((s, r) => s + (r.excluded || 0), 0);
    return {
      axis,
      label: AXES[axis].label,
      hint: AXES[axis].hint,
      score,
      answersScored: readings.filter((r) => r.score !== undefined).length,
      answersTotal: scored.length,
      observations,
      ...(excluded ? { excluded } : {}),
      // Why it produced nothing, when it produced nothing. Grammar has two
      // possible reasons and the rest have one, but all of them are statements
      // about our instrument rather than about the candidate, and the panel
      // prints them as such.
      ...(score === undefined && readings.some((r) => r.reason)
        ? { reason: readings.find((r) => r.reason).reason }
        : {}),
    };
  };

  const cognitive = COGNITIVE_AXES.map(build);
  const communication = COMMUNICATION_AXES.map(build);
  // A panel where nothing could be measured is not rendered as a row of zeroes.
  const any = (list) => (list.some((a) => a.score !== undefined) ? list : null);
  const out = { cognitive: any(cognitive), communication: any(communication), answersScored: scored.length };
  if (!out.cognitive && !out.communication) return null;
  return out;
}

/**
 * Is this role allowed to rate the communication axes at all?
 *
 * The communication panel rides on the SAME declaration the spoken-communication
 * score does: a human declared on the versioned rubric that this role assesses
 * how someone communicates, and wrote down why. Job-relatedness is the entire
 * legal basis for assessing it, and a declaration with no stated reason is not
 * one. A candidate-level exclusion always wins.
 *
 * The cognitive panel is not gated this way. Reasoning about the work is what
 * the interview is FOR, and every cognitive axis is scored from what they said
 * about the job rather than from how they said it.
 */
function communicationEnabled(rubric, { excluded = false } = {}) {
  if (excluded) return false;
  const d = rubric?.spokenCommunication;
  if (!d?.enabled) return false;
  return Boolean(String(d.justification || "").trim());
}

module.exports = {
  AXES,
  AXIS_NAMES,
  COGNITIVE_AXES,
  COMMUNICATION_AXES,
  SCORED_AXES,
  INDICATORS,
  INDICATOR_NAMES,
  INSIGHT_SCHEMA,
  GRAMMAR_MIN_CONFIDENCE,
  GRAMMAR_MIN_WORDS,
  MIN_WORDS_TO_OBSERVE,
  MIN_QUOTE_WORDS,
  verifyObservations,
  verifyGrammarErrors,
  grammarStars,
  scoreAxis,
  scoreAnswer,
  aggregate,
  communicationEnabled,
};
