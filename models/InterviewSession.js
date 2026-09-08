const mongoose = require("mongoose");

const deviceCheckSchema = new mongoose.Schema(
  {
    camera: { type: Boolean, default: false },
    microphone: { type: Boolean, default: false },
    screenShare: { type: Boolean, default: false },
    fullscreen: { type: Boolean, default: false },
    deviceCompatible: { type: Boolean, default: false },
    browserInfo: { type: String, trim: true },

    // Audio isolation (barge-in prerequisite). Measured, not guessed from device labels: the
    // browser plays a test tone while listening on the microphone, so what gets recorded is the
    // echo path that actually exists AFTER the browser's echo cancellation — the only thing that
    // determines whether the interviewer can safely keep listening while it speaks.
    //   isolated     — the mic does not hear the output. Interruption is safe.
    //   bleeding     — the mic clearly hears the output (laptop speakers). Interruption would make
    //                  the interviewer interrupt ITSELF, so it stays off for this session.
    //   inconclusive — could not measure. Fails closed to "off".
    // NEVER a blocker: a candidate with no headphones simply gets the turn-based interview, which
    // is the same interview everyone got before this existed. Blocking them would be a fairness
    // problem dressed up as a quality bar.
    echoPath: { type: String, enum: ["isolated", "bleeding", "inconclusive"], default: "inconclusive" },
    echoRatio: { type: Number }, // measured tone-to-baseline mic level, for diagnosing complaints
    // Loudest level the microphone actually captured during the pre-check. The check used to
    // verify PERMISSION only — it took the stream, saw the browser say yes, and stopped the
    // tracks — so a muted headset or a wrong default device passed every tick and produced total
    // silence at question one. This is the evidence that they were audible before they started.
    micPeak: { type: Number },
    audioOutputConfirmed: { type: Boolean, default: false }, // the candidate said they heard the tone
    bargeInEligible: { type: Boolean, default: false },

    completedAt: { type: Date },
  },
  { _id: false }
);

const speedTestSchema = new mongoose.Schema(
  {
    downloadMbps: { type: Number },
    testedAt: { type: Date },
  },
  { _id: false }
);

const identityVerificationSchema = new mongoose.Schema(
  {
    photoPath: { type: String },
    status: { type: String, enum: ["pending", "captured"], default: "pending" },
    capturedAt: { type: Date },
  },
  { _id: false }
);

// One recorded integrity event during the interview (a capped recent tail is kept for the admin
// timeline; per-type `counts` on the parent are the authoritative tally). `severity` and the risk
// score are assigned server-side from the type — the client only reports the type + a little meta.
const proctoringEventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    severity: { type: String, enum: ["low", "medium", "high"], default: "low" },
    meta: { type: mongoose.Schema.Types.Mixed },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

// Proctoring / anti-cheat state for the interview. Browser signals (tab-switch, fullscreen exit,
// copy/paste) + in-browser vision (face presence, multi-face, gaze, identity match) stream in as
// events; the derived `riskScore` is deterministic (utils/proctoring.js). Advisory only — never
// auto-rejects. Camera/vision processing runs entirely in the candidate's browser: only event
// metadata reaches the server, never raw video (DPDP-friendly).
const proctoringSchema = new mongoose.Schema(
  {
    consent: {
      given: { type: Boolean, default: false },
      declined: { type: Boolean, default: false },
      at: { type: Date },
    },
    // Phase 14.3 — clip capture is a SEPARATE, explicit consent clause on top of
    // the base proctoring consent. Without `given`, the client rolling buffer
    // never starts AND the server refuses clip uploads (defence in depth).
    // `wordingVersion` records which consent text the candidate accepted;
    // a decline is recorded, not just an absence of consent.
    evidenceConsent: {
      given: { type: Boolean, default: false },
      declined: { type: Boolean, default: false },
      at: { type: Date },
      wordingVersion: { type: String, trim: true },
    },
    // A THIRD consent clause, and the one that is hardest to justify skipping.
    //
    // The base `consent` clause above tells the candidate, in bold, that "raw video is not
    // uploaded"; the `evidenceConsent` clause tells them they are "never recorded continuously".
    // Both sentences are true of the vision pipeline and of clip capture. Neither is true of a
    // full-session recording. So a session recording cannot ride on either of them — it needs its
    // own clause, its own accepted wording version, and its own recorded decline, exactly like
    // clips do. Without `given`, the browser recorder never starts AND the chunk endpoint refuses
    // the upload (defence in depth, same as evidenceConsent).
    //
    // Historical note: the LiveKit Egress path recorded under the base clause alone. That was
    // wrong then and is not carried forward — see services/interviewRecordingService.js.
    recordingConsent: {
      given: { type: Boolean, default: false },
      declined: { type: Boolean, default: false },
      at: { type: Date },
      wordingVersion: { type: String, trim: true },
    },
    // Phase: screen-share risk signals. Browsers cannot detect a PRE-EXISTING third-party screen
    // share (no API exists for "is my screen being captured by someone else") — this is not
    // detection, it is a timestamped, citable record. Its value is that it turns an undetectable
    // act into a broken promise if later contradicted by other evidence (e.g. a face-vision flag),
    // not that the checkbox itself proves anything on its own.
    noConcurrentShareAttestation: {
      attested: { type: Boolean, default: false },
      at: { type: Date },
    },
    // Phase 14.6 — secondary phone camera presence. The phone NEVER streams
    // continuously; it sends a heartbeat, and heartbeat staleness raises a
    // phone_cam_lost event in the risk model (checked on the laptop's flush).
    phoneCam: {
      paired: { type: Boolean, default: false },
      pairedAt: { type: Date },
      lastHeartbeatAt: { type: Date },
      lostFlagged: { type: Boolean, default: false },
    },
    visionEnabled: { type: Boolean, default: false }, // in-browser face detection was active
    riskScore: { type: Number, default: 0 }, // 0-100, derived server-side
    riskBand: { type: String, enum: ["low", "medium", "high"], default: "low" },
    counts: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }, // { [type]: occurrences }
    totalEvents: { type: Number, default: 0 },
    identityMatch: {
      status: { type: String, enum: ["unknown", "match", "mismatch"], default: "unknown" },
      distance: { type: Number }, // face-descriptor euclidean distance (lower = closer match)
      checkedAt: { type: Date },
    },
    events: { type: [proctoringEventSchema], default: () => [] }, // capped recent tail
    lastEventAt: { type: Date },
  },
  { _id: false }
);

// Raw prosody measurements for a spoken answer, computed in-browser during recording.
//
// These are measurements of the RECORDING, not of the candidate, and exactly one thing is
// derived from them: `audioQuality`, which asks "could we hear this answer at all". Nothing here
// may reach a score, a recommendation, or a recruiter-facing number about the person — pace,
// hesitation and filler rate are accent, nervousness and disability proxies, and none of them
// appear in any RoleRubric. See utils/prosody.js for the full argument and for what was removed.
const acousticSchema = new mongoose.Schema(
  {
    wordsPerMinute: { type: Number },
    pauseRatio: { type: Number }, // fraction of the answer that was silence
    fillerRate: { type: Number }, // filler words ("um", "uh") per 100 words — recorded, never scored
    pitchVariance: { type: Number },
    energyVariance: { type: Number },
    // 0-100 usability of the AUDIO. Low = we could not hear them (dead mic, mostly silence), and
    // the turn is flagged degraded so it is not read as a weak answer. Never a merit signal.
    audioQuality: { type: Number },
    // Historical only: the pre-2026-08 name for a number that ALSO scored pace and filler rate
    // and was shown to recruiters as "Delivery: 64/100". Kept readable so old sessions still
    // flag bad audio; never written by current code, never displayed anywhere.
    deliveryScore: { type: Number },
  },
  { _id: false }
);

// One conversational turn of the AI interview. `role` is who spoke; `kind`
// classifies the turn so the UI and evaluator can distinguish intro/question/
// answer/closing. `answerScore` is the AI's per-answer 0-100 judgement (only on
// candidate answers).
//
// "warmup" / "warmup_answer" are the opening "tell me a bit about yourself" exchange. They are
// a real turn a reviewer should see, but deliberately NOT a question of the instrument: a
// self-introduction is not scoreable against a role rubric, it is not tied to a claim-probe,
// and it does not consume the question budget. The kind is what keeps it out of the score —
// see aiInterviewService (scoreUnscoredAnswers skips it, and submitAnswer never assigns it an
// answerScore).
//
// "meta_question" / "meta_answer" are the same idea applied to the candidate asking about the
// interview rather than answering it — "how many more of these are there?", "can I type instead?"
// (utils/metaAnswers.js). Before these kinds existed, such an utterance was recorded as the
// candidate's ANSWER to whatever had just been asked: they lost the question and had a non-answer
// scored against them for asking it. It belongs in the transcript, because a reviewer should see
// that they asked and what they were told — and it is emphatically not evidence about them, so
// the kind keeps it out of the score, out of the question budget, and out of askedQuestions.
const interviewTurnSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["ai", "candidate"], required: true },
    kind: {
      type: String,
      enum: [
        "intro", "warmup", "warmup_answer", "question", "answer", "closing",
        "meta_question", "meta_answer",
        // An adaptive question composed from what the candidate just said (utils/followUpPrompts).
        // A DISTINCT kind from "question" on purpose, and the distinction is load-bearing: a
        // follow-up is different for every candidate, so it is evidence about this person and
        // never a basis for comparing them with anyone else. Keeping it out of "question" means
        // a reviewer, the report, and any future cross-candidate analysis can all tell the
        // recruiter's instrument apart from the conversation that grew around it.
        "follow_up",
        // The closing sequence (utils/closingQuestions.js). Authored in code, identical for
        // every candidate, asked only once the approved set and every claim-probe are covered.
        // "closer" carries `difficulty: "easy"` by design — recorded so a reviewer knows the last
        // two questions were easy because the script says so, not because a model decided this
        // candidate needed easier ones.
        "capstone", "capstone_follow", "closer",
        // "How do you say your name?" and the answer to it (utils/namePronunciation.js). A
        // rendering parameter, not part of the instrument: how someone pronounces their own name
        // correlates with national origin and with nothing else, so these kinds are excluded from
        // every scoring path exactly as "meta_question" is.
        "name_check", "name_answer",
        // "Would you like to add anything more to that?" — the one further opportunity offered
        // when a reply comes in under the responsiveness floor. Fired by a CONTENT-BLIND rule
        // (word count, aiInterviewService.NUDGE_MIN_WORDS), never by a judgement of the answer,
        // and offered at most once per question. It is not a question of the instrument: it adds
        // nothing to askedQuestions, consumes no question budget, and is never scored — the reply
        // is merged into the answer it extends (see `nudgeMerged`) so one question still yields
        // exactly one scored answer.
        "nudge",
        // "I already answered that." / the code-authored reply to it (utils/alreadyAnsweredResponder).
        // Added 2026-08-25: these kinds were pushed to `turns` by the browser path since the
        // feature shipped but were never added here, so every occurrence threw a ValidationError
        // out of `session.save()` mid-interview — the claim was never actually recorded, and the
        // candidate got a hard failure instead of the checked reply. Same exclusion reasoning as
        // "meta_question"/"meta_answer": a claim about the record, and the fact-check of it, are
        // not the candidate's answer and must never be scored or counted as one.
        "already_answered_claim", "already_answered_reply",
      ],
      default: "question",
    },
    // The candidate said they could not or would not answer this one ("I don't know", "can we
    // skip this") — utils/dialogueActs.js. It stays kind "answer" and keeps its verbatim text,
    // because a decline IS part of the transcript and a reviewer must see exactly what was said.
    // The flag is what keeps it out of the scoring paths.
    //
    // WHY IT IS NOT SCORED ZERO. A zero is indistinguishable from a wrong answer, and these are
    // different findings about a candidate: one demonstrated a misunderstanding, the other told
    // you plainly they hadn't done it. Scoring the honest answer identically to the wrong one
    // also teaches candidates to bluff, which degrades every measurement the interview makes.
    // So a decline is excluded from the answer-score mean and reported as a decline instead —
    // and the count is surfaced on the evaluation, so "scored 72" can never quietly mean
    // "scored 72 on the two questions they didn't decline". See aiInterviewService.coverageStats.
    declined: { type: Boolean },
    // Which act produced it, for the audit trail: "decline" here, always — recorded rather than
    // assumed so a later act that also ends a turn can be told apart from this one.
    declineAct: { type: String, trim: true },
    // The candidate's own phrase that was read as the decline ("i want to skip this"), recorded so
    // "why was this not scored?" is answerable from the turn itself rather than by re-running the
    // detectors against text that may since have been re-transcribed. Added 2026-08-25 with
    // utils/turnComposition, after seven declines in one session were stored as answers and scored
    // zero — an outcome that was invisible in the record precisely because nothing was written down
    // about how the reading was reached.
    declineTrigger: { type: String, trim: true },
    // Realtime AI turns only, written ONCE at finalization: did this authored line actually reach
    // the room? Reconciled against the agent's own utterance log (voiceAgentService.
    // reconcileDelivery / spokenContains). The 2026-08-18 session recorded a question authored
    // mid-withdrawal — and an opening script the model replaced with its own — as if the candidate
    // had heard them; a reviewer reading `turns` had no way to tell. Absent = never checked
    // (turn-based path, where code speaks every line, or an empty utterance log). `matched: false`
    // is a finding about the TRANSPORT, never about the candidate — it must never reach a score.
    spoken: {
      matched: { type: Boolean },
      at: { type: Date },
    },
    // Realtime only: the agent's own rendering of this answer, kept ONLY when it diverged
    // materially from the verbatim transcript stored in `text`.
    //
    // The evidence is always the raw speech-to-text. A model paraphrasing an answer would quietly
    // turn "verbatim, code-verified" span citation into "what a model remembered", and everything
    // downstream — the answer score, the claim-probe answerQuote a recruiter reads beside a résumé
    // quote — treats `text` as the candidate's own words. This field exists so a reviewer can see
    // the interviewer was summarising rather than reporting: a defect in the agent, never a
    // finding about the candidate. Nothing scores it.
    agentRendering: { type: String, trim: true },
    text: { type: String, required: true },
    topic: { type: String, trim: true },
    difficulty: { type: String, enum: ["easy", "medium", "hard"] },
    answerScore: { type: Number },
    // Which claim-probe this question addresses (Phase 8), when any.
    probeId: { type: String },
    // Which résumé anchor this question addresses (utils/resumeAnchors), when any. Only ever
    // stamped once the question text has been checked to actually name the anchor, so this is a
    // record of coverage rather than an intention to cover.
    anchorId: { type: String },
    // On a QUESTION turn: the interview offered one further opportunity on this question because
    // the first reply was under the responsiveness floor (aiInterviewService.NUDGE_*). Recorded so
    // a reviewer can see who was offered a second chance, since the offer is a condition of the
    // interview rather than part of the instrument, and a condition that varied between candidates
    // has to be visible in the record even when the rule that varied it is content-blind.
    nudged: { type: Boolean },
    // On an ANSWER turn: this answer is the two replies (before and after the nudge) joined. Kept
    // as ONE turn so a single question yields a single scored answer — two turns would put two
    // scores into the mean for one question and flatter whoever happened to be nudged.
    nudgeMerged: { type: Boolean },
    // Which approved must-ask question this turn delivered, when any. Stamped so "which approved
    // question produced this answer" is a lookup rather than a string comparison against text
    // that may since have been superseded by a newer version of the set.
    mustAskId: { type: String },
    // On a QUESTION turn: the approved plain-language rewording of this question, if the set
    // carried one. Stored on the turn so it is both speakable (utils/speechAuthorization allows
    // only bank phrases and text present as an interviewer turn) and part of the permanent
    // record of what this candidate was read.
    restatement: { type: String, trim: true, default: "" },
    // On a candidate ANSWER: the grounded acknowledgement the interviewer spoke after it, before
    // the next question (utils/groundedAck.js).
    //
    // Stored on the ANSWER rather than as its own turn for the same reason backchannels are not
    // turns: it is not part of the instrument and must never be read as an interviewer question or
    // reach askedQuestions. But unlike a backchannel it is model-composed, so what was said has to
    // be recoverable verbatim — "the interviewer said something about your answer" is not an
    // acceptable answer to a candidate who asks what it said.
    //
    // `grounded: false` means every check failed and the uniform bank phrase was spoken instead;
    // `ackRejection` names which check. That pair is the health metric for the whole feature — a
    // rising rejection rate for one reason is a prompt regression, and without it the fallback
    // would be silent and the feature would look like it was working.
    ack: {
      text: { type: String, trim: true },
      grounded: { type: Boolean },
      // The candidate's own words the lead-in was built on — verified as a literal substring of
      // this turn's `text` before anything was spoken.
      term: { type: String, trim: true },
      rejection: { type: String, trim: true },
      // Which frame was used (utils/groundedAck.SHAPES) — "echo", "marker", "silent" and so on.
      // Rotated by turn index, so it is reproducible; stored because "why did it phrase it that
      // way?" should be answerable without re-deriving the rotation.
      shape: { type: String, trim: true },
      // The change-of-subject phrase was fused into this line rather than spoken separately, so the
      // client must NOT play a bridge of its own on top (see publicState.currentQuestionBridges).
      bridged: { type: Boolean },
    },
    // On a FOLLOW_UP question turn: what the hiring team should learn from the answer. Written for
    // a reviewer, never spoken to the candidate, and never scored — it records why an adaptive
    // question was asked, which is the one thing an adaptive question owes an audit.
    followUpRationale: { type: String, trim: true },
    // On a candidate ANSWER: why the turn ended (utils/endpointing.js). "complete" means the
    // answer was classified as finished, "holding"/"ambiguous" that the interviewer waited and
    // eventually moved on, "manual" that the candidate ended it themselves. A condition of the
    // interview, never an input to a score — see the sanitizer in interviewPortalController.
    endOfTurn: {
      state: { type: String, enum: ["complete", "ambiguous", "holding", "manual"] },
      reason: { type: String, trim: true },
    },
    // On a candidate ANSWER: how clearly it was communicated, when the role declares that it
    // assesses spoken communication (RoleRubric.spokenCommunication).
    //
    // Derived from the TRANSCRIPT ONLY — see utils/communication.js. Nothing about how the
    // candidate sounded reaches it, which is what makes it accent-neutral by construction rather
    // than by good intentions. `features` keeps the verbatim quote behind every observation, so a
    // score is answerable with the candidate's own words rather than with an assertion.
    communication: {
      delivery: { type: Number }, // clarity: answered the question, concrete, followable
      confidence: { type: Number }, // calibration: knew what they knew, did not overclaim
      // Yes/no observations with the quote that evidences each. Uncited ones were dropped before
      // scoring, so what is stored is what was actually verifiable.
      features: { type: mongoose.Schema.Types.Mixed },
      // What the two numbers are over. A 72 from three verified features and a 72 from seven are
      // different findings and the number alone cannot tell them apart.
      evidence: { type: mongoose.Schema.Types.Mixed },
    },
    // On a candidate ANSWER: the 13 rated axes behind the report's Cognitive Insights and
    // Communication Skills panels — see utils/interviewInsights.js.
    //
    // Stored as the VERIFIED OBSERVATIONS plus the arithmetic done over them, never as a rating
    // the model handed back. `axes[name].observations` keeps the verbatim quote behind every
    // point, which is what lets the report expand a star rating into the candidate's own words
    // instead of a paragraph asserting the rating was fair. Uncitable observations were dropped
    // before any of this was computed, so what is stored is what was actually checkable.
    insights: {
      axes: { type: mongoose.Schema.Types.Mixed },
      // Word count of the answer, kept because grammar is scored per hundred words and a rate
      // read apart from its denominator is not a measurement.
      words: { type: Number },
    },
    // On a candidate ANSWER: what they said in the GAP before this question was asked.
    //
    // The microphone no longer closes between turns, so this is the "oh — and one more thing"
    // that used to go into a torn-down stream and vanish. It is recorded on the turn that FOLLOWS
    // it and is deliberately not spliced into any answer: it belongs to the previous question, and
    // quietly filing it under the next one would be a worse failure than losing it.
    //
    // Read by no scorer. It exists so a reviewer can see that the candidate said something the
    // instrument did not capture as evidence, and decide for themselves what to do about it.
    spokeBetweenTurns: { type: String, trim: true },
    // On a candidate ANSWER: what the transcription connection did while it was being recorded.
    //
    // A dropped socket means words are MISSING from this transcript. The pipeline reconnects and
    // the answer survives, but the recording has a hole in it, and a hole nobody records is a
    // hole that gets scored as if the candidate simply said less. So it is stored on the turn and
    // read by the report (utils/interviewReportEngine) to mark the turn degraded.
    //
    // Never an input to a score, and never a signal about the candidate: whose connection drops
    // is a fact about their broadband, not about their competence.
    connection: {
      drops: { type: Number }, // how many times the socket died and was re-established
      gapMs: { type: Number }, // roughly how much audio was lost across those gaps
    },
    // How many times the candidate asked to hear THIS question again (set on the question turn).
    //
    // RECORDED, NEVER SCORED — and that exclusion is deliberate, not an oversight. Repeat requests
    // correlate with accent, hearing, whether English is a first language, and connection quality;
    // they correlate weakly at best with ability to do the job. Feeding this into any score would
    // build a disparate-impact machine. It exists so a human reviewing the interview can see the
    // conditions it ran under, and so "the audio was bad" is evidenced rather than argued.
    // The repeat replays the same authored text — the same audio bytes — so a candidate who asks
    // twice hears exactly what everyone else heard once.
    repeatCount: { type: Number },
    // Was this question actually finished before the candidate started answering? On devices where
    // barge-in is enabled they can talk over it, and a question the candidate talked over was not
    // fully asked — so it must not silently count as having covered its claim-probe. Absent on
    // typed interviews and on the turn-based voice path, where delivery is complete by definition.
    deliveredFully: { type: Boolean },
    interruptedAtChar: { type: Number }, // approximate character offset where they cut in
    // Voice metadata — present on spoken candidate answers (inputMode "voice").
    // (A dead `audioPath` field used to sit here — declared, never written. Removed
    // in Phase 9.6: answer audio was not retained; only the transcript was.)
    inputMode: { type: String, enum: ["text", "voice"], default: "text" },
    audioDurationMs: { type: Number },
    transcriptConfidence: { type: Number }, // STT confidence 0-1
    acoustic: { type: acousticSchema },
    // Reintroduced deliberately (post-9.6): the candidate's own recorded answer audio, so a
    // reviewer can hear how the STT and the AI interviewer actually performed — not a
    // surveillance recording of the candidate. Only present when voiceConsent.given was true
    // AND the browser's upload succeeded; a missing key just means no audio was captured, never
    // a placeholder. The key is never returned to any client — playback goes through the
    // company-scoped, audit-logged stream route (interviewSessionController.streamTurnAudio),
    // same posture as evidence clips. Deleted with the candidate (candidatePurgeService).
    audioKey: { type: String },
    audioMimeType: { type: String },
    // How many of the interviewer's own backchannel phrases had to be stripped out of this
    // transcript (utils/backchannel.stripEcho). Normally 0 — the client pauses capture around
    // playback. A non-zero count means echo suppression is not holding on that device, which
    // is worth knowing BEFORE it shows up as a strange-looking answer.
    backchannelEchoRemoved: { type: Number },
    // Per-turn provenance so a mixed AI/fallback interview is auditable turn-by-turn.
    //
    // "approved_set" is a THIRD provenance, not a flavour of the other two: the turn is a
    // recruiter-approved must-ask delivered verbatim by code with no model call at all
    // (aiInterviewService.advance). Recording it as "fallback" would attribute the recruiter's
    // own wording to the deterministic generator and lose the one claim this turn can make —
    // that no model touched it. Unlike the session-level `engine` below, which describes the
    // interview as a whole and stays ai|fallback, this is per-turn and must name all three.
    // Which mechanism authored this turn. "approved_set" = a recruiter-approved must-ask question
    // delivered verbatim by code; "follow_up" = an adaptive question composed from the candidate's
    // own last answer and code-verified (utils/followUpPrompts); "closing_script" = the
    // code-authored capstone/closer sequence (utils/closingQuestions), identical for every
    // candidate. A reviewer reading the transcript can tell the recruiter's instrument apart from
    // the conversation that grew around it without inferring anything from the wording.
    // "authored" = a fixed string written in code and identical for every candidate who meets a
    // deterministic, content-blind condition — currently the one-further-opportunity nudge. Named
    // rather than left blank so a reviewer can see at a glance that no model chose to say it and
    // no model chose to say it to THIS candidate.
    engine: { type: String, enum: ["ai", "fallback", "approved_set", "follow_up", "closing_script", "authored"] },
    model: { type: String, trim: true },
    latencyMs: { type: Number },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

// One claim-probe (Phase 8): an interview question generated from a specific
// unverified high-weight resume claim, with its verdict conditions precomputed
// at generation time so the post-interview verdict is judged against stated
// criteria. A `contradicted` verdict NEVER auto-rejects — it surfaces to a
// human with the resume quote and the answer quote side by side.
// One recruiter-approved must-ask question, copied onto the session at start. Coverage state
// mirrors interviewProbeSchema: pending until delivered, and back to pending if the candidate
// talked over it, so a half-heard question never counts as asked.
const interviewMustAskSchema = new mongoose.Schema(
  {
    questionId: { type: String, required: true }, // id within the approved set version
    text: { type: String, required: true },
    // The recruiter-approved plain-language rewording, spoken to a candidate who heard the
    // question and said they did not understand it. Copied here with the question so this session
    // can state what it actually read out even after the set version is superseded. Empty means
    // this question has no approved rewording, and the interviewer repeats it instead of
    // promising a rephrasing it cannot give. See models/QuestionSet.js.
    restatement: { type: String, default: "" },
    topic: { type: String, default: "" },
    status: { type: String, enum: ["pending", "asked"], default: "pending" },
    turnIndex: { type: Number },
    askedAt: { type: Date },
    // This approved question was never READ OUT: an earlier question — usually the model's own
    // version of it, which utils/interviewPrompts hands it as text and asks it not to use — had
    // already covered the same ground, so aiInterviewService.chooseMustAsk retired it rather than
    // ask the candidate the same thing twice. `turnIndex` points at the turn that covered it.
    //
    // Recorded because "asked" and "asked in the recruiter's exact words" are different claims and
    // the report must not silently make the stronger one. Before this existed the approved copy
    // was delivered verbatim a few turns after the model's, and the candidate heard the identical
    // sentence twice — the defect that produced this field.
    preEmpted: { type: Boolean },
  },
  { _id: false }
);

const interviewProbeSchema = new mongoose.Schema(
  {
    claimId: { type: String, required: true },
    criterionId: { type: String, default: "" },
    // A2 (REPORT-REDESIGN): a gap-probe explores a requirement the résumé never addressed —
    // claimId is synthetic ("gap-<criterionId>"), there is no claim behind it, and its verdict
    // can be verified or inconclusive but NEVER contradicted (enforced in
    // probeService.sanitiseVerdicts; the ClaimGraph write-back misses structurally).
    isGap: { type: Boolean, default: false },
    question: { type: String, required: true },
    whatWouldVerify: { type: String, default: "" },
    whatWouldContradict: { type: String, default: "" },
    resumeQuote: { type: String, default: "" }, // the claim's cited span, for side-by-side display
    status: { type: String, enum: ["pending", "asked", "assessed"], default: "pending" },
    turnIndex: { type: Number }, // index of the question turn that asked it
    verdict: { type: String, enum: ["verified", "contradicted", "inconclusive"] },
    verdictReasoning: { type: String },
    answerQuote: { type: String }, // verbatim from the transcript, code-verified
    askedAt: { type: Date },
    assessedAt: { type: Date },
  },
  { _id: false }
);

const resumeAnchorSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    // What kind of résumé claim this is (utils/resumeAnchors.WEIGHTS) — a project, an employer,
    // or a bare skill listing. Recorded because "we asked about a skill they listed and nothing
    // else" and "we asked about three projects they built" are different interviews.
    kind: { type: String, default: "" },
    term: { type: String, required: true },
    focus: { type: String, default: "" },
    // The verbatim span of the résumé this anchor came from, verified as a literal substring
    // before the anchor was kept (utils/resumeAnchors — cite or drop). Stored so a reviewer sees
    // the document text beside the answer, and so the anchor can be re-derived and checked.
    quote: { type: String, default: "" },
    start: { type: Number },
    end: { type: Number },
    weight: { type: Number },
    // Which rubric criterion this anchor evidences (REPORT-REDESIGN A1) — bound deterministically
    // at selection (utils/resumeAnchors.criterionForAnchor), "" when unbound or no rubric ran.
    // Consumer contract: a COVERED anchor may move that criterion's interview cell from untested
    // to partial ONLY — never verified or contradicted, which still require a probe verdict.
    criterionId: { type: String, default: "" },
    // `covered` means a question naming this anchor was actually asked AND answered; `asked`
    // means the question went out. The distinction matters because an interview that ran out of
    // time mid-anchor did not cover it, and reporting otherwise would overstate the instrument.
    status: { type: String, enum: ["pending", "asked", "covered"], default: "pending" },
    turnIndex: { type: Number },
    askedAt: { type: Date },
  },
  { _id: false }
);

const interviewPlanSchema = new mongoose.Schema(
  {
    role: { type: String, trim: true },
    difficultyEstimate: { type: String, enum: ["easy", "medium", "hard"], default: "medium" },
    topics: { type: [String], default: [] },
    focusAreas: { type: [String], default: [] },
    summary: { type: String, trim: true },
  },
  { _id: false }
);

const interviewEvaluationSchema = new mongoose.Schema(
  {
    overallScore: { type: Number },
    communication: { type: Number },
    technicalKnowledge: { type: Number },
    problemSolving: { type: Number },
    // Spoken communication, present ONLY when the role's approved rubric declares that it is
    // assessed and a human wrote down why (RoleRubric.spokenCommunication).
    //
    // These field names existed before and meant something indefensible: they were computed from
    // pace, filler rate and hesitation — accent, nervousness and speech-difference proxies —
    // against a criterion no rubric declared and no candidate was told about. The names survived;
    // the inputs did not. Both are now derived from the TRANSCRIPT only (utils/communication.js),
    // which is accent-neutral by construction because text carries no accent.
    //
    //   delivery   — clarity: did they answer what was asked, concretely, followably
    //   confidence — CALIBRATION, not self-assurance: did they mark the boundary of what they
    //                knew. Hedging now counts FOR a candidate; unhedged overclaiming counts
    //                against. The old scorer did the exact reverse.
    //
    // Reported beside the competency scores; never part of overallScore; can route to a human and
    // can never, on its own, reject anyone.
    delivery: { type: Number },
    confidence: { type: Number },
    spokenCommunication: {
      answersScored: { type: Number },
      // The recorded job-relatedness reason, carried here so it appears on the same screen as the
      // number rather than a rubric page away.
      justification: { type: String, trim: true },
    },
    // The two rated panels on the report — Cognitive Insights and Communication Skills.
    //
    // Aggregated from per-turn `insights` by utils/interviewInsights.aggregate. Every star here
    // was computed in code from observations the model had to quote and that were then checked
    // against the transcript; nothing in this object was a number a model returned.
    //
    // `communication` is null unless the same rubric declaration that gates `delivery` above is
    // present, and `communicationReason` records which of "the role never declared it" and "the
    // candidate asked to be excluded" was the cause.
    //
    // Not part of overallScore, and cannot reject anyone. Same standing as delivery/confidence.
    insights: {
      cognitive: { type: mongoose.Schema.Types.Mixed },
      communication: { type: mongoose.Schema.Types.Mixed },
      answersScored: { type: Number },
      communicationReason: { type: String, trim: true },
    },
    strengths: { type: [String], default: [] },
    weaknesses: { type: [String], default: [] },
    missingSkills: { type: [String], default: [] },
    // "review" = no automated recommendation; requires human judgement. The deterministic
    // fallback ALWAYS emits "review" — it must never produce an adverse hiring decision. So does
    // any interview the candidate ended early, and any interview where they declined more than
    // half of what was asked: see aiInterviewService.reviewRequiredReason, which is CODE
    // overruling the model, not a prompt asking it nicely.
    recommendation: { type: String, enum: ["strong_hire", "hire", "maybe", "no_hire", "review"] },
    summary: { type: String, trim: true },
    // How much of the instrument actually produced evidence. Without these, "72" is unreadable:
    // a 72 over eight answered questions and a 72 over two answered and six declined are wildly
    // different findings, and the number alone cannot tell them apart. Computed in code from the
    // turns (aiInterviewService.coverageStats), never by the model.
    questionsAsked: { type: Number },
    questionsAnswered: { type: Number },
    questionsDeclined: { type: Number },
    // Why the automated recommendation was withheld, when it was. Null on an ordinary interview.
    reviewReason: { type: String, trim: true },
    // Realtime interviews: how many approved questions the agent did NOT ask in the approved
    // wording (services/voiceAgentService.verifyQuestionsAsked). 0 on a clean run, and absent
    // entirely on turn-based interviews, where questions are delivered by code and cannot drift.
    questionsNotAskedVerbatim: { type: Number },
    // Realtime interviews: the approved opening script never reached the candidate (its turn's
    // `spoken.matched` is false at finalization). Not a stylistic nicety — the opening states the
    // interview's length and the right to ask for repeats, and a candidate who never heard their
    // affordances sat a different interview from one who did. Routes to review.
    introNotDelivered: { type: Boolean },
    generatedBy: { type: String, enum: ["ai", "fallback"], default: "ai" },
    generatedAt: { type: Date },
    // Provenance for reproducibility / legal defensibility of an automated decision (W4).
    model: { type: String, trim: true },
    provider: { type: String, trim: true },
    promptVersion: { type: String, trim: true },
    temperature: { type: Number },
    promptTokens: { type: Number },
    completionTokens: { type: Number },
    latencyMs: { type: Number },
  },
  { _id: false }
);

// One non-evaluative interviewer utterance: "take your time — I'm here", an acknowledgement, a
// repeat preamble. Drawn from a fixed human-approved bank (utils/backchannel.js) and recorded
// here — deliberately OUTSIDE `turns` — because a backchannel is not part of the test
// instrument. Recorded so the real conditions of the interview are reconstructible; never
// scored, never counted as a question, never shown to a reviewer as one.
const backchannelSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["reassure", "repeat", "acknowledge", "confirm", "bridge", "decline", "withdraw_confirm", "withdraw_cancel", "pause", "clarify", "technical"],
      required: true,
    },
    phrase: { type: String, required: true },
    turnIndex: { type: Number }, // index in `turns` of the answer this happened during
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

// One reading of what the candidate wanted. See `intents` below for why these are stored and why
// nothing that scores a candidate may read them.
const intentSchema = new mongoose.Schema(
  {
    // Verbatim, and truncated rather than summarised: the whole value of this row is that it lets
    // a human re-run the judgement on the actual words.
    utterance: { type: String, required: true, maxlength: 500 },
    action: { type: String, required: true },
    // 0 = the deterministic matchers (a stated rule, reproducible forever).
    // 1 = the semantic classifier (a model call, reproducible from model + promptVersion).
    tier: { type: Number, enum: [0, 1], required: true },
    confidence: { type: Number },
    // The trigger phrase (tier 0) or the model's stated reading (tier 1).
    reason: { type: String, maxlength: 300 },
    // Present only for tier 1, and required to reproduce the call months later.
    model: { type: String, trim: true },
    promptVersion: { type: String, trim: true },
    latencyMs: { type: Number },
    // True when the classifier was unavailable or unsure and the utterance was therefore treated
    // as part of the answer. Surfaced so "the interviewer ignored me" can be distinguished from
    // "the interviewer never got the chance to understand me".
    degraded: { type: Boolean, default: false },
    turnIndex: { type: Number },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

// The text-first AI interview state embedded on the session (1:1 with the
// candidate). See services/aiInterviewService.js for the orchestration.
const aiInterviewSchema = new mongoose.Schema(
  {
    // "ended_early" is the exit that did not exist. Before it, a candidate who wanted to stop had
    // no way to: the only route out of in_progress was answering every remaining question. It is
    // a DISTINCT state rather than a flag on "completed" because everything downstream has to be
    // able to tell them apart — a partial transcript must never be evaluated as if the candidate
    // had simply performed badly on the questions they never heard.
    // "halted" is distinct from "ended_early" and the distinction is the whole point: ended_early
    // is the CANDIDATE choosing to stop, halted is US stopping because the AI interviewer went
    // outside its approved script (utils/agentGuardrail.js). A report that cannot tell those apart
    // will eventually be read as if the candidate quit, which would turn our defect into their
    // adverse outcome.
    // "abandoned" is the exit nobody took: the candidate stopped answering, never withdrew, and
    // the link expired with the interview still open (jobs/interviewReminderJob.sweepAbandoned).
    // Distinct from ended_early because there is no recorded confirmation — claiming the
    // candidate "chose to stop" would assert evidence that does not exist — and distinct from
    // completed because most of the instrument never ran. It is knowingly ambiguous: a candidate
    // who gave up and a voice pipeline that failed them produce the identical record, so nothing
    // downstream may treat abandonment as adverse (see reviewRequiredReason / computeVerdict).
    // "integrity_terminated": the candidate's OWN proctoring signals (camera/identity/device — see
    // AUTO_SUBMIT_TRIGGER_TYPES in utils/proctoring.js) crossed a hard threshold and the session was
    // ended with no human step. Kept distinct from "halted", which exists specifically for the
    // opposite fault — the INTERVIEWER going off-script, where the candidate did nothing wrong and no
    // automated conclusion may ever be drawn. This status is about candidate-side signals, so it is
    // NOT given halted's "must not count against them" treatment downstream — see
    // reviewRequiredReason / computeVerdict, which still withhold any automated verdict, but for the
    // ordinary reason that a partial transcript can't support one, not because it was our fault.
    status: {
      type: String,
      enum: ["not_started", "in_progress", "completed", "ended_early", "halted", "abandoned", "integrity_terminated"],
      default: "not_started",
    },
    engine: { type: String, enum: ["ai", "fallback"], default: "ai" },
    // How the candidate answered — set to "voice" once any spoken answer is received.
    modality: { type: String, enum: ["text", "voice"], default: "text" },
    // The candidate's first name, resolved once when the interview starts.
    //
    // Stored rather than looked up because it is part of the closed set of things this session is
    // allowed to SAY: the approved phrase bank contains name-bearing phrases ("Thank you,
    // Priya."), and utils/speechAuthorization has to be able to decide whether a given sentence
    // is one of them without loading the candidate. Empty when the application carries no usable
    // first name, in which case those phrases simply do not exist for this session.
    // No new personal data — the same name is already in the stored intro turn.
    candidateFirstName: { type: String, trim: true, default: "" },
    // How to SAY that name, as the candidate themselves gave it (utils/namePronunciation.js).
    //
    // A rendering parameter and nothing else. It is applied between the approved text and the
    // speech engine, exactly as utils/speakable.js expands "K8s" — the authored name stays the
    // record. It is structurally excluded from every scoring path, because how a person pronounces
    // their own name is a proxy for national origin and for nothing that predicts job performance.
    // Empty `respelling` means we asked and could not verify an answer, so the name is spoken as
    // written — which is exactly what happened before this field existed.
    namePronunciation: {
      // The candidate's respelling ("vih-JEN-dra"), adopted only after isPlausibleFor confirmed it
      // could be the same name. Never a model's guess at a name it was not given.
      respelling: { type: String, trim: true, default: "" },
      // "explicit" = they respelled it themselves; "asr" = the transcriber's spelling of the sounds
      // they made. Recorded because the two are different strengths of evidence about the same
      // thing, and a reviewer asking "why did it say it that way?" deserves the real answer.
      source: { type: String, enum: ["explicit", "asr"] },
      // How many times we asked. Capped at namePronunciation.MAX_ATTEMPTS — a candidate is never
      // made to repeat their own name a third time to a machine that cannot hear it.
      attempts: { type: Number, default: 0 },
      // The phonetic-skeleton edit distance and the bound it had to clear. Kept so an adopted
      // respelling is explainable rather than magic.
      distance: { type: Number },
      allowed: { type: Number },
    },
    // Whether this interview assessed how clearly the candidate communicated, and if not, why not.
    //
    // Recorded rather than left as an absence, because "this role does not assess it" and "this
    // candidate asked to be excluded" are different facts — and the second is one a candidate may
    // later ask us to confirm we honoured. An absent field would answer neither.
    spokenCommunication: {
      assessed: { type: Boolean },
      reason: { type: String, trim: true }, // when not assessed
      justification: { type: String, trim: true }, // when assessed: the role's stated reason
    },
    plan: { type: interviewPlanSchema, default: () => ({}) },
    currentDifficulty: { type: String, enum: ["easy", "medium", "hard"], default: "medium" },
    turns: { type: [interviewTurnSchema], default: () => [] },
    askedQuestions: { type: [String], default: () => [] },
    questionCount: { type: Number, default: 0 },
    // Adaptive follow-ups asked so far (utils/followUpPrompts.MAX_FOLLOW_UPS).
    //
    // COUNTED SEPARATELY FROM questionCount, and that separation is a correctness requirement, not
    // bookkeeping. `questionCount >= maxQuestions` is the hard ceiling that ends the interview; if
    // follow-ups incremented it, a talkative candidate could exhaust the budget before the
    // recruiter's approved questions had all been asked, and the interview would end having failed
    // to run the instrument it exists to run. A follow-up delays the approved set by one turn and
    // can never displace it.
    followUpCount: { type: Number, default: 0 },
    // How far through the code-authored closing sequence this interview has got
    // (utils/closingQuestions.js) — the capstone pair, then the easy closers. Entered only once
    // every approved question and every claim-probe is covered.
    closingIndex: { type: Number, default: 0 },
    // Deterministic seed for which closers this session asks, so replaying the session yields the
    // same two questions rather than a fresh pair.
    closingSeed: { type: Number, default: 0 },
    // Length bounds (Phase 8.3): the interview may end early once ALL probes
    // are covered AND minQuestions is reached; maxQuestions is the hard ceiling.
    minQuestions: { type: Number, default: 5 },
    maxQuestions: { type: Number, default: 8 },
    // Non-evaluative interviewer speech, kept out of `turns` on purpose. See backchannelSchema.
    backchannels: { type: [backchannelSchema], default: () => [] },
    // What the interviewer UNDERSTOOD the candidate to want, each time it had to decide
    // (utils/conversationIntent.js). Distinct from `backchannels`, which record what was SAID:
    // this is the reading that produced it.
    //
    // Recorded because the semantic tier is a model call, and the standard this codebase holds
    // model calls to is that the decision must be reconstructible afterwards from stored data
    // rather than from what the model felt at the time. {utterance, action, tier, model,
    // promptVersion} is that record. It is also the only way to answer the complaint this whole
    // path invites — "it stopped me mid-answer" / "it ignored me" — with evidence.
    //
    // NEVER READ BY ANY SCORING PATH. An intent is a fact about the conversation, not about the
    // candidate: how often someone asks for a repeat correlates with their accent, their hearing
    // and their connection, and barely at all with whether they can do the job. Same structural
    // exclusion as the repeat count (utils/repeatIntent.js) and for the same reason.
    intents: { type: [intentSchema], default: () => [] },
    // Every attempt to make the interviewer say something that was NOT authored by the
    // rubric-bound engine and was NOT in the approved phrase bank (utils/speechAuthorization.js).
    // Normally empty, permanently: the allowed set is exactly what this server produced, so an
    // entry here means a bug or tampering. It is recorded verbatim rather than counted, because
    // "what did the interviewer say to this candidate?" is the question a discrimination claim
    // turns on, and a count cannot answer it.
    speechDivergences: {
      type: [
        new mongoose.Schema(
          {
            spoken: { type: String, required: true },
            enforced: { type: Boolean, default: true }, // was it refused, or only recorded?
            at: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: () => [],
    },
    // Everything the REALTIME agent said, when the interview ran in speech-to-speech mode
    // (services/voiceAgentService.js). Empty on every turn-based interview.
    //
    // This is the audit record that replaces exact-match speech authorization. Once the
    // interviewer is allowed to improvise the connective tissue between questions,
    // utils/speechAuthorization.js can no longer prove every word was authored — so what it
    // proved is replaced by two weaker-but-real guarantees: the QUESTIONS are verified verbatim
    // against this log (voiceAgentService.verifyQuestionsAsked), and everything else the
    // interviewer said is here, verbatim, to be read.
    //
    // That is still strictly more than any unconstrained speech-to-speech competitor can produce:
    // when a candidate says "the AI asked me about my kids", this is the record that answers it.
    agentUtterances: {
      type: [
        new mongoose.Schema(
          {
            text: { type: String, required: true },
            at: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: () => [],
    },
    // The candidate's half of the same conversation — everything they said, as the STT heard it,
    // in the order they said it. Empty on every turn-based interview.
    //
    // `turns` records the ANSWERS: what was said in reply to a question, segmented by the engine,
    // scored against the rubric. That is deliberately not everything a person says in an
    // interview. "Sorry, can you repeat that?", "is my mic working?", "hang on, my dog" — none of
    // it is an answer, and until this field existed none of it was kept, which meant a candidate
    // spending two minutes asking whether they had been heard left a record showing two minutes of
    // nothing. That is the exact failure this platform is supposed to make impossible: the record
    // has to be able to show the interview going wrong, not just the candidate doing badly.
    //
    // TWO HARD RULES, both structural rather than conventional:
    //   1. NEVER READ BY ANY SCORING PATH. Not as a feature, not as a tie-breaker, not as
    //      "context". How often someone asks for a repeat tracks their accent, their hearing and
    //      their bandwidth, not their ability — same exclusion as `intents` above, same reason.
    //      test/unit/livekitPipeline.test.js asserts scoring inputs never carry it.
    //   2. NEVER GUARDRAILED. utils/agentGuardrail scans for the INTERVIEWER going off-script.
    //      Running it over the candidate would turn a control on the machine into surveillance of
    //      the person, which is a different product and not one worth building.
    candidateUtterances: {
      type: [
        new mongoose.Schema(
          {
            text: { type: String, required: true },
            at: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: () => [],
    },
    // Every time the realtime interviewer said something it was not allowed to say
    // (utils/agentGuardrail.js). Normally empty — a hit means the prompt did not hold, which is
    // exactly the thing you cannot find out by asking the model whether it behaved.
    //
    // The offending UTTERANCE is stored verbatim alongside the rule it broke, not just a rule name
    // and a count. "The AI asked me about my kids" is answered by producing the sentence; it is
    // not answered by "1 × protected_characteristic".
    guardrailHits: {
      type: [
        new mongoose.Schema(
          {
            ruleId: { type: String, required: true },
            severity: { type: String, enum: ["critical", "high"], default: "high" },
            label: { type: String, trim: true },
            matched: { type: String, trim: true }, // the pattern that fired
            utterance: { type: String, trim: true }, // what was actually said
            at: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: () => [],
    },
    // Realtime session billing window. Voice Agent charges per session-MINUTE and its model calls
    // never pass through llmService, so without closing this out the tenant's budget cap is
    // bypassed by construction. `realtimeMeteredAt` makes the close-out idempotent — a candidate
    // closing the tab twice must not be billed twice.
    realtimeStartedAt: { type: Date },
    realtimeMeteredAt: { type: Date },
    realtimeDurationMs: { type: Number },
    // Candidate video recording, gated behind CompanySettings.ai.sessionRecording /
    // CLIENT_RECORDING_ENABLED plus the candidate's own recordingConsent — off by default on
    // every axis. Playback is via a Cloudinary secure URL (storageService
    // .getSignedDownloadUrl), never buffered through this process — a full interview recording is
    // a different size class than the existing 6MB evidence-clip cap.
    //
    // TWO PRODUCERS have written these fields, and `recordingSource` is how a reader tells them
    // apart. It is not bookkeeping: what the statuses MEAN differs between them.
    //
    //   "egress" (historical) — LiveKit Cloud recorded server-side and the row was only ever
    //     completed by an `egress_ended` webhook we do not control. A recording that started and
    //     was never confirmed sits at "recording" forever; that stuck state is the defect this
    //     path was replaced to fix, and those rows are still out there.
    //   "client" (current) — the candidate's browser captures and uploads chunks; our own
    //     endpoints move the status. No external webhook is in the loop, so "recording" means a
    //     session that is genuinely still in progress or whose tab died mid-interview.
    //
    // Statuses: pending → recording (first chunk landed) → completed (chunks stitched into
    // `recordingKey`) | partial (chunks landed, assembly failed — the footage EXISTS and is
    // retryable, which is why this is not "failed") | failed (finalize saw zero chunks).
    recordingStatus: { type: String, enum: ["pending", "recording", "completed", "partial", "failed"] },
    recordingKey: { type: String, trim: true },
    recordingDurationMs: { type: Number },
    recordingSource: { type: String, enum: ["egress", "client"] },
    // When capture actually began, stamped by the browser on the first chunk.
    //
    // This exists because the admin player has to map a transcript turn's wall-clock `at` onto an
    // offset into the video, and `startedAt` (when the INTERVIEW began) is the wrong origin:
    // recording starts later than the interview whenever the camera permission, the recorder, or
    // a reconnect lags. Without this the report can only guess, and it currently degrades its
    // timestamps to plain labels rather than seek somewhere confidently wrong. Egress rows have
    // no value here and never will — the honest answer for them is the degraded one.
    recordingStartedAt: { type: Date },
    // The uploaded chunks, in sequence. Kept AFTER a successful stitch is deleted, so a populated
    // array on a "completed" row means the cleanup pass did not finish, not that playback is
    // chunked. Ordering is by `seq` (client-assigned, server-validated as monotonic), never by
    // insertion — chunk uploads are fire-and-forget and can land out of order.
    recordingChunks: {
      type: [
        new mongoose.Schema(
          {
            key: { type: String, required: true, trim: true },
            seq: { type: Number, required: true },
            durationMs: { type: Number },
            bytes: { type: Number },
            at: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: () => [],
    },
    egressId: { type: String, trim: true },
    // Which AGENT_PROMPT_VERSION the realtime interviewer ran under
    // (services/voiceAgentService.AGENT_PROMPT_VERSION, bumped whenever the instructions change).
    // Without storing it, a bump silently makes every earlier session unattributable — "which
    // interviewer did this candidate sit?" stops having an answer at exactly the moment the answer
    // starts to differ, which is also the moment two candidates stop being comparable. Same
    // contract as `promptVersion` on the turn-based path.
    agentPromptVersion: { type: String, trim: true },
    // Set when status is "halted". Why the interview was stopped, and how much of it had run.
    // Read by reviewRequiredReason, which withholds the automated recommendation entirely — a
    // transcript produced outside the approved script cannot support a conclusion either way.
    haltedBy: {
      reason: { type: String, enum: ["guardrail"] },
      ruleId: { type: String, trim: true },
      severity: { type: String, trim: true },
      label: { type: String, trim: true },
      utterance: { type: String, trim: true },
      questionsAsked: { type: Number },
      questionsAnswered: { type: Number },
      at: { type: Date },
    },
    // Set when status is "integrity_terminated" — a sibling of haltedBy, deliberately not the same
    // field: haltedBy's `reason` enum and downstream readers assume "our fault, never adverse", which
    // does not apply here. `types` is the accepted proctoring event types that tripped the threshold.
    integrityTerminated: {
      triggerCount: { type: Number },
      threshold: { type: Number },
      types: { type: [String], default: [] },
      questionsAsked: { type: Number },
      questionsAnswered: { type: Number },
      at: { type: Date },
    },
    // Which interviewer persona this session ran under (models/PersonaProfile.js). Interviewer
    // warmth, voice and patience change how candidly candidates answer, so they are part of the
    // test conditions: comparing two candidates is only legitimate if both were interviewed under
    // the same ones, and defending a decision means being able to say what they were.
    // `source: "default"` means the tenant had approved no persona and the deployment fallback
    // was used — surfaced as such, never passed off as a tenant choice.
    persona: {
      key: { type: String, trim: true },
      version: { type: Number },
      name: { type: String, trim: true },
      voiceProvider: { type: String, trim: true },
      voiceModel: { type: String, trim: true },
      source: { type: String, enum: ["tenant", "default"] },
      at: { type: Date },
    },
    // The recruiter-approved must-ask questions for this job (models/QuestionSet.js), copied
    // onto the session at start. Copied rather than referenced on purpose: the set is frozen
    // once approved, but a session must be able to state exactly what it asked even if the set
    // is later archived — and coverage is per-session state, not per-set.
    //
    // Required coverage in the same sense as `probes`: the interview cannot close while any of
    // these is still pending. Unlike probes, they are asked VERBATIM and selected by code — a
    // reworded approved question is a different question, and "we asked everyone the same thing"
    // stops being true the moment a model paraphrases for one candidate and not another.
    mustAsk: { type: [interviewMustAskSchema], default: () => [] },
    // Which approved set this session ran under. `source: "none"` means the job had no approved
    // set and the interview ran on claim-probes plus adaptive questions — surfaced as such,
    // never passed off as a recruiter's choice.
    questionSet: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: "QuestionSet" },
      version: { type: Number },
      source: { type: String, enum: ["approved_set", "none", "lookup_failed"] },
      at: { type: Date },
    },
    // Claim-probes this interview must cover (Phase 8.2 — required coverage).
    probes: { type: [interviewProbeSchema], default: () => [] },
    probeEngine: { type: String, enum: ["ai", "none"], default: "none" },
    probePromptVersion: { type: String },
    // WHY there are no claim-probes, when there are none. Rule 5: a degraded path must be
    // labelled wherever it surfaces, never rendered as if it were the full instrument. An
    // interview with no probes because the job has no approved rubric and an interview with no
    // probes because the candidate's résumé claims were all already verified are very different
    // things, and until this field existed both looked like `probeEngine: "none"`.
    probeEngineReason: {
      type: String,
      enum: ["", "ok", "engine_disabled", "no_assessment", "no_unverified_claims", "generation_failed"],
      default: "",
    },
    // Résumé topics this interview is required to cover (utils/resumeAnchors). Derived in code
    // from the candidate's own document, with no rubric and no model — so an interview asks about
    // the résumé even on a job that never had a rubric approved, which is the configuration most
    // jobs are actually in.
    resumeAnchors: { type: [resumeAnchorSchema], default: () => [] },
    anchorSelectionVersion: { type: String },
    // WHO WAS IN THE ROOM, AND WHEN THEY WERE NOT.
    //
    // Realtime only. The worker used to treat `participant_disconnected` as the end of the
    // interview and delete the room on the spot — so on a phone, a lock screen, an incoming call,
    // or the browser being backgrounded for a few seconds ended the interview permanently, mid
    // answer, with no way back in. That is the commonest thing that happens on a mobile device and
    // it was unrecoverable.
    //
    // The worker now waits (AGENT_REJOIN_GRACE_SECONDS) and the candidate can rejoin the same
    // session. What that changes is that "the candidate left" is no longer self-evident from the
    // room having closed, so it has to be recorded — both because a reviewer needs to know an
    // interview had a four-minute hole in it, and because a candidate who leaves deliberately and
    // one whose train went into a tunnel produce exactly the same events.
    //
    // WHICH IS WHY NOTHING HERE IS SCORED. This system cannot tell those two apart, and guessing
    // would mean penalising people for their network — which correlates with income, region and
    // device far more strongly than with anything about their work. A long or repeated absence
    // routes the session to a HUMAN (aiInterviewService.reviewRequiredReason); it never adjusts a
    // number and never triggers an adverse action on its own.
    presence: {
      type: [
        new mongoose.Schema(
          {
            event: { type: String, enum: ["left", "rejoined", "abandoned"], required: true },
            at: { type: Date, default: Date.now },
            // How long they had been gone, on a "rejoined"/"abandoned" row. Measured by the
            // worker, which is the only party that can see it.
            awayMs: { type: Number },
            // Which question was open when it happened, so a reviewer can see whether the gap
            // interrupted an answer or fell between turns.
            turnIndex: { type: Number },
          },
          { _id: false }
        ),
      ],
      default: () => [],
    },
    // Realtime only (services/voiceAgentService.submitAnswer). When the transcript offered to
    // submit_answer looks unfinished (utils/endpointing.classify() returns anything but
    // "complete"), the engine does not record it as an answer — it tells the agent to keep
    // listening instead, exactly like the text-first path already waits on the same signal. This
    // is the one bit of state that decision needs to avoid stalling forever: which turn was held,
    // so a second submission for that same turn is accepted regardless of how it classifies
    // rather than held indefinitely. Cleared the moment an answer for the turn is actually
    // recorded.
    endpointHold: {
      turnIndex: { type: Number },
      at: { type: Date },
    },
    evaluation: { type: interviewEvaluationSchema, default: () => ({}) },
    // Set when status is "ended_early". Records who ended it and on what evidence, because
    // "the candidate chose to stop" is a claim this system will one day have to substantiate —
    // to the candidate, or to a regulator asking whether the interview was really voluntary.
    //
    // `confirmedBy` is the point. A withdrawal is never taken on one utterance: the interviewer
    // asks, and this records the reply that actually ended it (utils/dialogueActs.js). An
    // interview that ended without a recorded confirmation is a bug, and this is where it shows.
    endedEarly: {
      by: { type: String, enum: ["candidate"] },
      // The verbatim utterance that triggered the request, and the trigger it matched.
      requestText: { type: String, trim: true },
      matchedTrigger: { type: String, trim: true },
      // How it was confirmed: "spoken" (they said yes) or "explicit" (they pressed the button,
      // which needs no confirmation because a button press is already unambiguous).
      confirmedBy: { type: String, enum: ["spoken", "explicit"] },
      confirmText: { type: String, trim: true },
      questionsAsked: { type: Number },
      questionsAnswered: { type: Number },
      at: { type: Date },
    },
    // Set when status is "abandoned" (the sweep closed an in-progress interview whose link had
    // expired — jobs/interviewReminderJob.sweepAbandoned). Pure bookkeeping so "when and on how
    // much evidence was this closed?" is answerable. `reopenedAt` is set if a recruiter re-issued
    // the link and the candidate came back: the score-what-exists snapshot evaluation is cleared
    // at that moment (beginInterview) and the live attempt finalizes fresh — this record is what
    // remains of the swept run.
    abandoned: {
      at: { type: Date },
      // updatedAt of the session when the sweep judged it dead — the last observed activity.
      lastActivityAt: { type: Date },
      questionsAsked: { type: Number },
      questionsAnswered: { type: Number },
      reopenedAt: { type: Date },
    },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { _id: false }
);

const interviewSessionSchema = new mongoose.Schema(
  {
    // §3.1: a candidate can be interviewed more than once (a second round, a redo after a
    // technical failure). `candidate` alone used to be `unique: true`, which meant a second
    // interview literally could not exist as its own document — createInterviewSessionIfNeeded
    // would return the first one and the second attempt overwrote `aiInterview` in place,
    // destroying the first report. `attempt` + the compound unique index below replace that: one
    // document per (candidate, attempt), attempt 1 is the default so every existing call site that
    // doesn't yet think in terms of attempts keeps behaving exactly as it did before this field
    // existed.
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate", required: true },
    attempt: { type: Number, default: 1 },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },

    tokenHash: { type: String, required: true, unique: true, index: true },
    // Bumped every time a new link is issued (resend/reschedule). Embedded in the portal
    // JWT at sign time and re-checked on every authenticated request (candidateAuth.js) so
    // that issuing a new link doesn't just make the OLD raw link 404 on login — it also
    // kills any portal session already opened from it, even one mid-interview.
    sessionEpoch: { type: Number, default: 0 },
    interviewAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    instructions: { type: String, trim: true },

    status: { type: String, enum: ["scheduled", "in_progress", "completed", "expired", "cancelled"], default: "scheduled" },
    accessedAt: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },

    deviceCheck: { type: deviceCheckSchema, default: () => ({}) },
    speedTest: { type: speedTestSchema, default: () => ({}) },
    identityVerification: { type: identityVerificationSchema, default: () => ({}) },
    proctoring: { type: proctoringSchema, default: () => ({}) },

    // Voice consent (Phase 9.5) — recorded BEFORE any mic capture, mirroring the
    // proctoring consent gate. Without `given`, the server refuses to mint a
    // streaming token; declining leaves the type-to-answer path fully available.
    voiceConsent: {
      given: { type: Boolean, default: false },
      declined: { type: Boolean, default: false },
      at: { type: Date },
    },

    // The exact speech-to-text keyterm vocabulary this session's transcripts were biased with
    // (utils/keyterms.js). Recorded, NEVER scored: it exists so a candidate who disputes a
    // transcript can have it reconstructed instead of argued about, and so a bias audit can
    // confirm every candidate for a role was given the same role-derived vocabulary.
    voiceAsr: {
      keyterms: { type: [String], default: [] },
      model: { type: String, trim: true },
      at: { type: Date },
    },

    aiInterview: { type: aiInterviewSchema, default: () => ({}) },

    reminder24hSent: { type: Boolean, default: false },
    reminder1hSent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Reminder cron scans scheduled sessions due within a time window, across tenants
// (jobs/interviewReminderJob). tokenHash is already uniquely indexed on its own field.
interviewSessionSchema.index({ status: 1, interviewAt: 1 });

// §3.1: replaces the old single-field `unique: true` on `candidate` — one session per
// (candidate, attempt) instead of one session per candidate, ever. A migration
// (scripts/backfillInterviewAttempt.js) must backfill `attempt: 1` on every existing document
// before `npm run sync:indexes` drops the old index and creates this one, or the old unique
// constraint and this one briefly disagree on live data.
interviewSessionSchema.index({ candidate: 1, attempt: 1 }, { unique: true });

// Analytics evidence report scans a tenant's sessions by last-touched time
// (superset-prefixes the standalone `company` index, which stays for the
// completedAt count path).
interviewSessionSchema.index({ company: 1, updatedAt: -1 });

interviewSessionSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("InterviewSession", interviewSessionSchema);
