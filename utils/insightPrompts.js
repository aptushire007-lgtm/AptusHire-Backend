// The extraction prompt behind Cognitive Insights and Communication Skills.
//
// Read utils/interviewInsights.js first — it explains why this asks for
// observations instead of ratings. The short version: a model asked to rate
// someone out of five returns its impression of them wearing a number, and there
// is nothing underneath it for a reviewer to disagree with. So this prompt asks
// 44 yes/no questions about the transcript, each of which must be answered with
// a quote, and code turns the verified ones into the star ratings.
//
// Two things this prompt refuses to ask for, deliberately:
//   - Any number. Not one field in the schema is numeric.
//   - Anything about how the candidate SOUNDED. Pace, hesitation, accent and
//     filler rate are not in the transcript and never reach the model, which is
//     precisely what makes these axes assessable at all.

const { fenceUntrusted } = require("./promptSafety");
const { AXES, SCORED_AXES } = require("./interviewInsights");

const INSIGHTS_SYSTEM =
  "You observe what a candidate's answer demonstrates, from a transcript of what they said. " +
  "You report only what you can quote from that transcript, verbatim. " +
  "You never rate the person, never score anything, and never return a number. " +
  "You never comment on the candidate's identity, background, or the way they speak. " +
  "Every observation you make is checked against the transcript and discarded if the quote is " +
  "not literally there, so an observation you cannot quote is worth less than no observation.";

// The wording each indicator is asked in. Kept beside the definitions rather than
// generated from the field names, because the phrasing is what determines what
// comes back — "did they weigh an alternative" and "were they open-minded" are
// the same field name away from each other and produce entirely different data.
const ASKS = {
  // --- Cognitive ------------------------------------------------------------
  reasonsFromPremiseToConclusion: "did they reason from something they stated to something they concluded, rather than asserting the conclusion?",
  stepsAreOrdered: "are the steps in an order that makes sense — first this, then that — rather than a pile of facts?",
  conclusionFollowsFromTheSteps: "does the conclusion they reach actually follow from the steps they described?",
  containsANonSequitur: "is there a step that does NOT follow from what came before it? Only mark true if you can quote the jump.",

  weighedAnAlternative: "did they consider a different option and say why they did not take it?",
  namedATradeoff: "did they name something they gave up to get something else?",
  questionedAnAssumption: "did they challenge a premise — of the question, or of the situation they were in?",
  acceptedThePremiseUncritically: "did they accept a false or loaded premise in the question without noticing it? Only true if the premise really was loaded.",

  identifiedARootCause: "did they get past the symptom to a cause?",
  proposedAConcreteAction: "did they say what was actually DONE or should be done — a specific action, not a principle?",
  describedTheOutcome: "did they say what happened as a result?",
  stoppedAtDescribingTheProblem: "did the answer describe a situation and never reach an action? Only true when a solution was clearly what was asked for.",

  connectedItToBusinessImpact: "did they link the work to a business consequence — cost, revenue, risk, a customer?",
  consideredDownstreamEffects: "did they mention what their decision would affect later or elsewhere?",
  relatedItToOtherTeamsOrSystems: "did they place the work in relation to another team, system or dependency?",

  namedWhatTheyDidNotKnow: "did they mark the edge of their knowledge? This is a STRENGTH — hedging is good calibration, not weakness.",
  describedAMistakeAndWhatChanged: "did they describe something that went wrong AND what they changed because of it?",
  distinguishedTheirWorkFromTheTeams: "is it clear what THEY did as opposed to what their team did?",
  claimedCertaintyWithNoBasis: "did they state a specific fact flatly that the rest of the answer gives no basis for? Ordinary confidence is not this.",

  offeredANonObviousObservation: "did they say something a competent-but-unremarkable answer would not contain?",
  generalisedFromTheSpecificCase: "did they draw a general lesson out of the specific example?",
  reframedTheQuestionUsefully: "did they recast the question in a way that made it more answerable? Only true if the reframing was genuinely useful, not evasive.",

  theAnswerHasAShape: "does the answer have a discernible structure a listener could follow?",
  technicalTermsAreDefined: "is the jargon they introduced explained, or did none need explaining? Precise technical language used precisely is GOOD — never mark it down for being technical.",
  pronounsHaveAntecedents: "could a listener who was not there tell what 'it', 'they' and 'that' refer to?",
  theAnswerWanders: "does it drift away from the question and not come back?",

  madeAnActualDecision: "did they describe making a decision, rather than describing a process?",
  statedTheCriterionTheyDecidedOn: "did they say what they decided ON — the basis, the threshold, the priority?",
  ownedTheConsequence: "did they take responsibility for how it turned out, good or bad?",
  deferredWithNoReason: "did they push the decision to someone else without giving a reason? Escalating for a stated, sound reason is NOT this.",

  // --- Communication --------------------------------------------------------
  answeredWhatWasActuallyAsked: "did they address the question that was asked, rather than an adjacent one?",
  handledTheFollowUpWithoutRepeating: "if this was a follow-up, did they add something rather than restate the previous answer?",
  askedForClarificationWhenTheQuestionWasUnclear: "did they ask what was meant when the question was genuinely ambiguous? This is a STRENGTH.",
  answeredADifferentQuestion: "did they answer a question that was not asked? Only true if you can quote the mismatch.",

  sentencesReachTheirPoint: "do their sentences get where they were going?",
  selfCorrectionsResolveCleanly: "when they restarted a sentence, did the restart land? Restarting is NORMAL SPEECH and is never itself a problem.",
  abandonsSentencesMidThought: "are there thoughts started and dropped such that the meaning is lost? A false start they immediately recover from is NOT this.",

  usesTheDomainsOwnTerms: "do they use the vocabulary of the field correctly?",
  choosesPreciseVerbsOverVagueOnes: "do they say what was done specifically ('renegotiated', 'partitioned') rather than vaguely ('handled', 'dealt with')?",
  variesWordingRatherThanRepeatingOnePhrase: "is there range in the wording, rather than one phrase carrying the whole answer?",

  ideasConnectToEachOther: "do the parts of the answer relate to each other, rather than sitting side by side?",
  theOrderIsFollowable: "can a listener follow the order without rewinding?",
  noContradictionWithinTheAnswer: "is the answer internally consistent?",
  contradictsSomethingSaidEarlier: "does this contradict something they said earlier in the interview? Only true if you were given the earlier text and can quote both.",
};

// Grouped by axis so the model reads related questions together — the answers
// are more consistent when the four Logical Reasoning questions are adjacent
// than when all 44 are in one undifferentiated list.
function indicatorBlock() {
  const lines = [];
  for (const axis of SCORED_AXES) {
    lines.push(`\n[${AXES[axis].label}]`);
    for (const name of Object.keys(AXES[axis].indicators)) {
      lines.push(`- ${name} — ${ASKS[name] || ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * @param {object} args
 * @param {string} args.question  the question this answer responds to
 * @param {string} args.answer    the candidate's transcribed answer
 * @param {string} [args.earlier] previously transcribed answers, for the two
 *                                cross-answer indicators only. Absent on the
 *                                first answer, and the prompt says so — a model
 *                                asked to check consistency against nothing will
 *                                invent something to check.
 */
function insightsPrompt({ question, answer, earlier }) {
  return (
    `QUESTION THEY WERE ASKED:\n${question}\n\n` +
    `WHAT THEY SAID (a transcript of SPEECH — punctuation was inserted by a speech recogniser and ` +
    `is not theirs, and false starts, repetition and self-correction are normal in speech and are ` +
    `NOT faults):\n${fenceUntrusted(answer)}\n\n` +
    (earlier
      ? `WHAT THEY SAID EARLIER IN THIS INTERVIEW (for consistency checks only — do not re-score it):\n${fenceUntrusted(earlier)}\n\n`
      : `They have not answered anything earlier in this interview, so any indicator about ` +
        `contradicting an earlier answer must be false.\n\n`) +
    `For each field below, answer true or false and give a SHORT VERBATIM QUOTE from the ` +
    `transcript above that shows it. If a field is false, leave the quote empty. If you cannot ` +
    `find a real quote, answer false rather than inventing one — every quote is checked against ` +
    `the transcript and a quote that is not literally there is discarded along with the ` +
    `observation it was supporting.\n` +
    indicatorBlock() +
    `\n\n[grammarErrors]\n` +
    `A list of specific grammatical errors, each with the verbatim span and a short kind ` +
    `("tense", "agreement", "article", "plural", "preposition", "word order"). ` +
    `Return an empty list if there are none.\n` +
    `DO NOT list any of the following, none of which are grammatical errors: false starts; ` +
    `repetition; self-correction; missing or odd punctuation (the recogniser added it, not the ` +
    `speaker); contractions; sentence fragments that are normal in speech; regional or dialectal ` +
    `usage that is standard in the speaker's variety of English; or a word that looks wrong but ` +
    `is more likely to be a transcription error than something a person said. ` +
    `When you are unsure whether a span is the speaker's error or the recogniser's, leave it out.\n\n` +
    `Return JSON.`
  );
}

module.exports = {
  INSIGHTS_SYSTEM,
  ASKS,
  insightsPrompt,
};
