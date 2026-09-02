// "How many more of these are there?"
//
// Questions about the interview rather than answers to it. A candidate asks two or three of them
// in any real conversation, and until now every one of them was transcribed as that candidate's
// answer to whatever had just been asked — so they lost a question AND had a non-answer recorded
// against them for asking it.
//
// WHY THE ANSWERS LIVE IN CODE. Everything here is a statement about the assessment: how long it
// is, what is recorded, whether typing is penalised. A model composing those sentences live would
// be inventing policy in front of a candidate, and the sentence it invented would be the one they
// quoted back at us. So the phrasing is a fixed, human-approved bank and the only thing that
// varies is the numbers, which come from session state.
//
// THE HARDER RULE, AND THE REASON THE SET IS SO SMALL. Every answer must be TRUE of this
// particular interview and knowable from what we hold. That is a much tighter constraint than it
// looks, and it is what keeps this file from growing into an FAQ:
//
//   - "How am I doing?" is answerable and must NOT be answered. It is an assessment delivered to
//     the candidate mid-interview with no human in the loop, it varies with performance, and it
//     changes what they say next. Same reasoning as the evaluative-word ban in backchannel.js.
//   - "Will I get the job?" / "what's the salary?" are the tenant's to answer, not ours.
//   - "Is a human going to look at this?" depends on tenant configuration we do not hold here.
//
// Anything not in the table gets acknowledged and deferred, which is both honest and what a
// human interviewer says when asked something outside their remit.

// ---------------------------------------------------------------------------
// The answerable set
// ---------------------------------------------------------------------------
//
// `build` receives the interview state and returns the sentence, or null when this particular
// session cannot answer truthfully — in which case the caller falls back to `DEFERRAL`. Returning
// null is not a failure path; it is how a topic that is usually answerable stays honest in the
// session where it is not.

// "Why are you asking me this?"
//
// Exported as a constant because BOTH interview pipelines have to say the identical sentence: the
// turn-based path reads it from this bank, and the realtime agent is handed it verbatim inside its
// instructions (services/voiceAgentService.agentPrompt). One string, so the two can never drift
// into giving different accounts of where the questions come from.
//
// WHAT THIS SENTENCE DELIBERATELY IS NOT: a justification. The temptation is to answer with the
// rubric criterion's `rationale` — it is right there, it is human-approved, and it would be
// perfectly defensible. It is still wrong to say out loud. Explaining WHY a question is
// job-related, mid-interview, to the candidate who just asked, does two bad things at once: it
// sounds like an instrument defending itself rather than a person talking, and it inevitably drifts
// toward what a good answer would contain — which is coaching, delivered only to the candidates who
// thought to ask. Stating where the question CAME FROM carries none of that and is the true answer
// anyway. The rationale stays where it belongs: in the rubric, for a human reviewer.
const WHY_THIS_QUESTION = "That's just what the role asks for — no rush at all.";

const TOPICS = {
  // "How many more?" — the single most common process question there is, and the one the room's
  // own progress display has always been slightly dishonest about (the denominator is a ceiling,
  // not a plan). Said out loud, we can be accurate: a range, because it genuinely is one.
  how_many_left: {
    build: ({ questionCount, minQuestions, maxQuestions }) => {
      if (!Number.isFinite(maxQuestions) || maxQuestions <= 0) return null;
      const asked = Number.isFinite(questionCount) ? questionCount : 0;
      const maxLeft = Math.max(0, maxQuestions - asked);
      if (maxLeft === 0) return "This is the last one.";
      const minLeft = Math.max(0, (Number.isFinite(minQuestions) ? minQuestions : maxQuestions) - asked);
      if (minLeft === maxLeft) {
        return `There ${maxLeft === 1 ? "is" : "are"} ${maxLeft} more to go after this one.`;
      }
      if (minLeft <= 0) {
        return `We're near the end — at most ${maxLeft} more, and possibly fewer.`;
      }
      return `Between ${minLeft} and ${maxLeft} more, depending on how the rest goes.`;
    },
  },

  // "How much longer will this take?" Deliberately phrased as a rough estimate rather than a
  // commitment: the interview closes early when the questions have done their job, and a candidate
  // told "eight minutes" who finishes in four should not feel something went wrong.
  how_long_left: {
    build: ({ questionCount, maxQuestions, minutesPerQuestion = 2 }) => {
      if (!Number.isFinite(maxQuestions) || maxQuestions <= 0) return null;
      const left = Math.max(0, maxQuestions - (Number.isFinite(questionCount) ? questionCount : 0));
      if (left === 0) return "We're at the end now.";
      const mins = Math.max(2, Math.round(left * minutesPerQuestion));
      return `Roughly ${mins} more minutes, though it can finish sooner.`;
    },
  },

  // "Can I type instead?" The answer is yes and it matters enormously that it is said plainly:
  // a candidate who believes speaking is the graded path will keep struggling with a bad
  // microphone rather than switch, and everything about that outcome is worse for both sides.
  can_i_type: {
    build: ({ typedAllowed = true }) =>
      typedAllowed
        ? "You can — there's a typing option in the room, and typed answers are assessed the same way as spoken ones."
        : null,
  },

  // "Am I being recorded?" Answered from what this session actually has on file, never from a
  // general statement about the product. If the state is not loaded, we say nothing rather than
  // risk describing the wrong regime — this is the one topic where a confident wrong answer is a
  // consent problem and not merely an inaccuracy.
  is_recorded: {
    build: ({ proctoringEnabled }) => {
      if (proctoringEnabled === true) {
        return "Your answers are transcribed and saved, and this session is monitored — that's what you agreed to on the check screen before we started.";
      }
      if (proctoringEnabled === false) {
        return "Your answers are transcribed and saved for the hiring team to review. This session isn't being monitored beyond that.";
      }
      return null;
    },
  },

  // "Can I come back to that one?" Honest about the shape of the instrument: questions are asked
  // once, in order, and there is no going back — but skipping is free, and saying that out loud is
  // worth more than the question it costs.
  //
  // The phrasing here was rejected once by the boot check below, and the rejection was correct:
  // it originally read "it won't count as a wrong answer", which puts the idea of a wrong answer
  // into a candidate's head mid-interview even while denying it. What replaced it states the
  // mechanism instead — a skip is recorded as a skip — which is both true (see the `declined` flag
  // on this model, excluded from the answer-score mean) and says nothing about their performance.
  can_i_come_back: {
    build: () =>
      "I'll be moving forward through the questions rather than coming back — but if you'd rather skip this one, just say so, and it's recorded as a skip rather than as an attempt.",
  },

  // "Why are you asking me this?" / "What's this got to do with the job?"
  //
  // Asked most often by the candidates who are most uneasy, and what settles them is the register
  // rather than the content: a recruiter answers this without breaking stride, because to them it
  // genuinely is not a loaded question. A careful, complete, well-structured answer would be worse
  // — it treats the question as an accusation and tells the candidate they were right to be
  // suspicious. Hence "just", and hence the reassurance being about time rather than about them.
  why_this_question: {
    build: () => WHY_THIS_QUESTION,
  },

  // "Can I use notes / look something up?" Answered conservatively and identically for everyone,
  // because the alternative is the interviewer improvising different exam conditions per
  // candidate — which is exactly the sort of variation the frozen rubric exists to prevent.
  can_i_use_notes: {
    build: () =>
      "I'd rather hear it in your own words than have you look it up — and it's completely fine to say you don't remember a specific detail.",
  },

  // "Who's going to see this?" Answerable in general terms that are true of every deployment.
  who_sees_this: {
    build: () =>
      "Your answers and the transcript go to the hiring team at the company you applied to, for them to review.",
  },
};

// What is said when the question is recognised as a process question but this file cannot answer
// it truthfully — either it is outside our remit, or the state needed is not loaded. Acknowledges,
// declines plainly, and hands the floor straight back, which is what a human interviewer does when
// asked something they are not the right person to answer.
const DEFERRAL =
  "That's not something I can answer here, but the hiring team can — shall we carry on?";

// ---------------------------------------------------------------------------
// The non-evaluative guarantee, enforced at boot
// ---------------------------------------------------------------------------
//
// Same check the backchannel bank runs on itself, and for the same reason: these sentences are
// spoken to a candidate mid-interview, so a phrase that rates their performance is an assessment
// delivered with no human in the loop. Checked at require time so it fails on deploy rather than
// in somebody's live interview. Topics whose build() needs state are exercised with a
// representative state — the point is to catch a word smuggled into the PHRASING, and the phrasing
// is what these sample calls return.
const { findEvaluativeWord } = require("./backchannel");

const BOOT_CHECK_STATE = {
  questionCount: 2,
  minQuestions: 5,
  maxQuestions: 8,
  typedAllowed: true,
  proctoringEnabled: true,
};

for (const [topic, def] of Object.entries(TOPICS)) {
  const sample = def.build(BOOT_CHECK_STATE);
  const offender = sample && findEvaluativeWord(sample);
  if (offender) {
    throw new Error(
      `[metaAnswers] the answer for "${topic}" contains evaluative language ("${offender}"). ` +
        "Answers to process questions state facts about the interview; they never rate the candidate."
    );
  }
}
{
  const offender = findEvaluativeWord(DEFERRAL);
  if (offender) throw new Error(`[metaAnswers] DEFERRAL contains evaluative language ("${offender}")`);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const TOPIC_NAMES = Object.keys(TOPICS);

/**
 * The interviewer's spoken answer to a process question.
 *
 * @param {string} topic  one of TOPIC_NAMES, as classified by the semantic tier
 * @param {object} state  { questionCount, minQuestions, maxQuestions, typedAllowed,
 *                          proctoringEnabled, minutesPerQuestion }
 *
 * @returns {{ text: string, topic: string|null, answered: boolean }}
 *
 * `answered: false` means the deferral was spoken — the candidate still gets a reply, and the
 * record still shows that they asked something we chose not to answer, which is the honest
 * account of what happened.
 */
function answerFor(topic, state = {}) {
  const def = TOPICS[topic];
  if (!def) return { text: DEFERRAL, topic: null, answered: false };
  let text = null;
  try {
    text = def.build(state || {});
  } catch {
    // A malformed state must not cost the candidate a reply.
    text = null;
  }
  if (!text) return { text: DEFERRAL, topic, answered: false };
  return { text, topic, answered: true };
}

// The state this file needs, read off a live session. Kept here rather than at the call site so
// the shape stays next to the code that consumes it.
function stateFromSession(session, { job } = {}) {
  const ai = session?.aiInterview || {};
  return {
    questionCount: Number(ai.questionCount) || 0,
    minQuestions: Number(ai.minQuestions) || undefined,
    maxQuestions: Number(ai.maxQuestions) || undefined,
    typedAllowed: true,
    // Tri-state on purpose: `undefined` (not loaded) must not be read as "not monitored".
    proctoringEnabled:
      session?.proctoring?.enabled === undefined ? undefined : Boolean(session.proctoring?.enabled),
    minutesPerQuestion: Number(job?.interviewMinutesPerQuestion) || 2,
  };
}

module.exports = { TOPICS, TOPIC_NAMES, DEFERRAL, WHY_THIS_QUESTION, answerFor, stateFromSession };
