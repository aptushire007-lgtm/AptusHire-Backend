// How hard the next question is, decided by CODE.
//
// THE FAILURE THIS FIXES. The interview claimed to be adaptive and was not. `currentDifficulty`
// was whatever string the model put in its own `difficulty` field, stored on the session, and then
// handed straight back to the same model on the next turn as "Current difficulty: medium". Nothing
// verified it, nothing constrained it, and a model that returned "hard" for eight consecutive
// turns produced an interview indistinguishable from one that returned "easy" eight times — the
// only consumer of the value was the prompt that produced it. It was a number talking to itself.
//
// So this is engineering rule 1 applied to the adaptive control signal rather than to the score:
// the model OBSERVES (it scores the answer it just read), and code DECIDES what that means for the
// next question. The rung a candidate is on becomes a reproducible function of their recorded
// answer scores — re-run the ladder over a stored transcript and it lands on the same rung, every
// time, which is what makes "the interview adapted to them" a checkable claim instead of a story.
//
// WHY A LADDER AND NOT A FORMULA. The thing being chosen is one of three words that go into a
// prompt. A continuous score mapped onto it would imply a precision that does not exist and would
// make the interview jitter — hard, easy, hard, easy — off single-answer noise, which reads to a
// candidate as an interviewer with no memory. Rungs plus a required run of consistent answers give
// the one property that matters: difficulty moves when the evidence is consistent, and holds when
// it is mixed.
//
// WHAT THIS IS NOT. It is not a score, is never shown to the candidate, and never reaches an
// evaluation. Being asked a hard question is not evidence about anyone; it is a consequence of the
// answers already given, and the answers are what get scored. A candidate who is asked three easy
// questions and answers them well must not be marked down for the interview's own choices — which
// is exactly why the rung lives here, visible and testable, rather than inside a prompt.

const RUNGS = ["easy", "medium", "hard"];

// Above this, the last answer was strong enough to count toward moving up.
const RAISE_AT = 75;
// At or below this, it counted toward moving down. The gap between the two is deliberate: scores
// in the middle are evidence of nothing in particular and must not push the rung either way.
const LOWER_AT = 45;

// How many consecutive answers in the same direction it takes to move one rung.
//
// Two, not one. One strong answer is frequently a candidate hitting the one topic they know best,
// and one weak answer is frequently a question that landed badly or a word that was misheard.
// Moving on a single data point produces an interview that lurches, and the lurch falls hardest on
// candidates whose first answer is weakest — people interviewing in a second language, or nervous,
// who then get a visibly easier interview for the rest of the session.
const RUN_TO_MOVE = 2;

function indexOfRung(rung) {
  const i = RUNGS.indexOf(String(rung || "").toLowerCase());
  return i === -1 ? 1 : i; // unknown/absent ⇒ medium
}

/**
 * Which way one answer's score points. Returns +1, -1 or 0 — and 0 for anything unscored, because
 * an answer nobody scored is not evidence in either direction.
 */
function directionOf(score) {
  if (!Number.isFinite(score)) return 0;
  if (score >= RAISE_AT) return 1;
  if (score <= LOWER_AT) return -1;
  return 0;
}

/**
 * The rung the interview should be on, computed from scratch over the scored answers so far.
 *
 * Recomputed rather than incremented on purpose: a stored session must be able to justify the rung
 * it ended on from its own turn list, with no hidden accumulated state, and a bug that dropped one
 * update must not leave the ladder permanently offset.
 *
 * DECLINES ARE SKIPPED, NOT COUNTED AS FAILURES. A candidate who says "I don't know" has told the
 * truth about one topic; treating that as evidence of a lower level would make honesty the
 * strictly worse move, which is the opposite of what a screening interview wants to reward. Same
 * rule the scorer already applies (aiInterviewService.scoreUnscoredAnswers).
 *
 * @param {object} ai   the session's aiInterview subdocument
 * @param {string} startingRung  plan.difficultyEstimate — where the interview opened
 * @returns {{rung: string, run: number, direction: number, moves: number}}
 */
function computeRung(ai, startingRung) {
  let index = indexOfRung(startingRung || ai?.plan?.difficultyEstimate);
  let run = 0;
  let direction = 0;
  let moves = 0;

  for (const turn of ai?.turns || []) {
    if (turn.role !== "candidate") continue;
    // Only real, attempted, scored answers to instrument questions count. The warmup
    // self-introduction and the closing chat are not part of the instrument and must not steer it.
    if (turn.kind !== "answer") continue;
    if (turn.declined) continue;
    const step = directionOf(turn.answerScore);
    if (step === 0) {
      // A middling answer BREAKS the run rather than being ignored. "Strong, middling, strong" is
      // not two consecutive strong answers, and treating it as one would let the ladder climb on
      // evidence that was never consistent.
      run = 0;
      direction = 0;
      continue;
    }
    if (step === direction) {
      run += 1;
    } else {
      direction = step;
      run = 1;
    }
    if (run >= RUN_TO_MOVE) {
      const next = Math.min(RUNGS.length - 1, Math.max(0, index + direction));
      if (next !== index) {
        index = next;
        moves += 1;
      }
      // Consume the run whether or not the rung actually moved — a candidate already on "hard"
      // does not bank credit toward a rung that does not exist.
      run = 0;
      direction = 0;
    }
  }

  return { rung: RUNGS[index], run, direction, moves };
}

/**
 * A short line for the question prompt saying where the interview is and why. The "why" is there
 * so the model calibrates to the candidate's demonstrated level rather than to the label — "hard"
 * alone gets read as "ask a trick question", which is not what a harder rung means.
 */
function briefFor(rung) {
  switch (rung) {
    case "hard":
      return (
        `Current difficulty: hard. Their answers so far have been strong, so ask something that ` +
        `demands specifics — a trade-off they had to make, a failure and what they changed, a ` +
        `decision they would defend. Do not ask trick questions or trivia; depth, not obscurity.`
      );
    case "easy":
      return (
        `Current difficulty: easy. Ask something concrete and answerable from their own direct ` +
        `experience. Do not signal that the difficulty has changed, do not soften your tone, and ` +
        `do not comment on how the interview is going — the question changes, nothing else does.`
      );
    default:
      return (
        `Current difficulty: medium. Ask about real work they have done and what they personally ` +
        `decided or built.`
      );
  }
}

module.exports = {
  RUNGS,
  RAISE_AT,
  LOWER_AT,
  RUN_TO_MOVE,
  indexOfRung,
  directionOf,
  computeRung,
  briefFor,
};
