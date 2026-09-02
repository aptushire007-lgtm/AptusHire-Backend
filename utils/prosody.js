// Audio-quality measurement for a spoken answer. NOT a measure of the candidate.
//
// ---------------------------------------------------------------------------
// WHAT THIS FILE USED TO DO, AND WHY IT NO LONGER DOES IT
// ---------------------------------------------------------------------------
//
// This module used to derive two 0-100 scores from a candidate's prosody — `delivery` and
// `confidence` — and both were written onto the interview evaluation next to overallScore,
// communication and technicalKnowledge, and rendered to recruiters as score bars.
//
// That was a defect, and a serious one. It scored people on HOW THEY SOUND:
//
//   - Pace (words per minute) is lower for non-native speakers of the interview language.
//   - Filler rate is higher for people who think aloud, and for anyone nervous.
//   - Pause ratio is higher for people with a stammer, a speech difference, a slow connection,
//     or a cheap microphone with aggressive noise gating.
//   - "Sounds confident" is, straightforwardly, an accent and demeanour proxy.
//
// None of those axes appear in any RoleRubric. No recruiter approved them. No candidate was
// told they were measured. That combination — an unapproved criterion, correlated with national
// origin and disability, attached to a hiring decision — is precisely the ground HireVue was
// forced to abandon, and it violates rule 3 of the product thesis (no evaluation outside an
// explicit, versioned, human-approved rubric for this role).
//
// Labelling it "secondary — not competency" on the report did not fix it. A number on a hiring
// report is read as a judgement regardless of its caption, and "we showed it but told them not
// to count it" is not a defence anyone has ever won with.
//
// ---------------------------------------------------------------------------
// WHAT SURVIVES, AND WHY IT IS DIFFERENT
// ---------------------------------------------------------------------------
//
// One use of these measurements is legitimate and PROTECTIVE of the candidate: detecting that
// an answer's AUDIO was bad, so the turn can be flagged as unreliable rather than scored as if
// it were clean. Three words transcribed over nineteen seconds is not a weak candidate, it is a
// broken microphone — and the report needs to say so instead of quietly scoring the fragment.
//
// So `audioQuality` stays. The distinction that makes it acceptable:
//
//   - It never reaches the evaluation, the recommendation, or any score bar.
//   - It can only ever REMOVE confidence from a turn (marking it degraded), never add or
//     subtract merit from a candidate.
//   - A low value is a statement about the recording, and is reported in those words.
//
// If you are about to surface this number to a recruiter as a property of the person, stop:
// that is the exact thing this file was rewritten to prevent.

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// How usable this answer's audio was, 0-100. Low means "we could not hear them properly", never
// "they spoke poorly". Read only by interviewReportEngine, to flag a turn as degraded.
//
// The thresholds are deliberately loose. A number in the 60s here means nothing at all and must
// not be interpreted; only the bottom of the range (a near-silent or near-empty recording) is
// meaningful, and that is the only place it is acted on.
function audioQuality(a) {
  if (!a || typeof a !== "object") return undefined;
  let s = 100;
  if (a.wordsPerMinute != null) {
    const w = a.wordsPerMinute;
    // Only a pathologically low rate counts — that is the signature of a microphone that
    // captured almost nothing, not of someone speaking deliberately. The old version penalised
    // anything under 90 wpm, which is an ordinary considered speaking pace.
    if (w < 40) s -= (40 - w) * 1.5;
  }
  // Mostly-silence is the other signature of a failed recording.
  if (a.pauseRatio != null) s -= Math.max(0, a.pauseRatio - 0.6) * 150;
  // NOTE: filler rate is deliberately NOT an input. It says nothing about whether the audio was
  // captured; it only says the person said "um", which is not ours to measure.
  const out = Math.round(clamp(s, 0, 100));
  return Number.isFinite(out) ? out : undefined;
}

module.exports = { audioQuality };
