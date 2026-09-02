// Deterministic, server-owned integrity scoring for the proctored interview.
//
// The browser is an untrusted reporter: it sends only the event TYPE (+ a little metadata). The
// server owns severity, weight, and the final risk score — a candidate can't inflate or hide their
// own risk by lying about severity, and can't forge a "low risk" score. Mirrors the split used for
// voice: measurements come from the client, the SCORE is computed here (see [[voice-interview-priority]]).
//
// Risk is advisory only. It surfaces to the recruiter alongside the interview; it never auto-rejects
// a candidate — a human makes the call (DPDP / human-in-the-loop, Wave 4).

// Event taxonomy. `weight` = risk points per occurrence; `cap` = the most that type can ever
// contribute (so a flaky webcam firing face_absent 200× can't alone max out the score). Keep the
// keys in sync with the client detectors in user/src/portal/useProctoring.js.
const EVENT_TYPES = {
  tab_switch: { severity: "medium", weight: 8, cap: 40, label: "Switched away from the interview tab" },
  window_blur: { severity: "low", weight: 4, cap: 20, label: "Interview window lost focus" },
  fullscreen_exit: { severity: "medium", weight: 6, cap: 30, label: "Exited fullscreen" },
  copy: { severity: "low", weight: 5, cap: 20, label: "Copied text from the page" },
  paste: { severity: "medium", weight: 8, cap: 24, label: "Pasted text into an answer" },
  context_menu: { severity: "low", weight: 2, cap: 10, label: "Opened the right-click menu" },
  // Confirmed 4s+ of continuous absence, and only when the detector was reading the candidate
  // WELL immediately beforehand. Ambiguous losses are reported as `detector_uncertain` instead.
  face_absent: { severity: "medium", weight: 10, cap: 40, label: "Candidate away from camera (4s+)" },
  multi_face: { severity: "high", weight: 25, cap: 75, label: "More than one person on camera" },
  // Now a confirmed 7s+ continuous episode rather than a per-frame sample, so each occurrence
  // means far more than it used to. Weight stays low on purpose: looking away is weak evidence of
  // anything by itself, and glancing at notes is not misconduct.
  gaze_away: { severity: "low", weight: 2, cap: 24, label: "Looked away from the screen (7s+)" },
  identity_mismatch: { severity: "high", weight: 30, cap: 60, label: "Face did not match the identity photo" },
  // Diarization found a substantial run of words in a spoken answer attributed to someone other
  // than the dominant speaker. Weighted like an identity mismatch because it evidences the same
  // thing more directly: a camera can be dodged by sitting off-frame, but another person speaking
  // the answer is the answer not being the candidate's. Derived SERVER-side from the word counts
  // the browser reports — the client never sends this type.
  second_speaker: { severity: "high", weight: 30, cap: 60, label: "A second voice answered during the interview" },
  camera_lost: { severity: "medium", weight: 12, cap: 24, label: "Camera feed stopped during the interview" },
  phone_cam_lost: { severity: "medium", weight: 12, cap: 24, label: "Secondary phone camera disconnected" },
  // No browser API can observe that the OS/another app is already capturing this screen — there is
  // no getDisplayMedia-equivalent for "am I being watched by something else". These four types are
  // the honest ceiling: proxy signals, each individually weak, that only mean something in
  // combination — see `correlationBonus` below. None of them, alone or together, PROVES a
  // pre-existing screen share; they raise an auditable flag for a human, never an accusation.
  //
  // The one concrete (non-heuristic) signal available: getUserMedia failing with
  // NotReadableError/TrackStartError means the OS already has the camera/mic held exclusively by
  // another application — an actual device conflict, not a guess.
  device_busy: {
    severity: "medium",
    weight: 10,
    cap: 30,
    label: "Camera or microphone was already in use by another application",
  },
  // A second connected display. Extremely common and innocuous alone (a second monitor is not
  // evidence of anything) — weighted lowest on purpose.
  multi_display_detected: { severity: "low", weight: 2, cap: 6, label: "A second display was detected" },
  // Sustained poor LiveKit connection quality with no reconnect. Network variance has many innocent
  // causes (home wifi, ISP congestion), so this stays low-weight and is only a weak correlator.
  bandwidth_anomaly: {
    severity: "low",
    weight: 1,
    cap: 4,
    label: "Sustained poor connection quality during the live interview",
  },
  // Timing-based heuristic (not a hard signal — devtools detection is inherently approximate).
  devtools_open: { severity: "low", weight: 3, cap: 9, label: "Browser developer tools may have been open" },
  // A statement about OUR camera pipeline, not about the candidate — the face was lost while the
  // detector was already reading marginally (dim, distant, or edge-cropped). It is recorded so the
  // session is honest about what could not be observed, and it is deliberately weightless: a
  // detector's failure is not a candidate's behaviour, and scoring it as such is how proctoring
  // tools manufacture suspicion they cannot substantiate.
  detector_uncertain: { severity: "low", weight: 0, cap: 0, label: "Camera view was unclear (not scored)" },
  // The face detector never started at all — assets failed to load, the camera was refused, or the
  // device could not run the model. Weightless for the same reason detector_uncertain is: this is a
  // statement about OUR pipeline, not about the candidate.
  //
  // It exists because the alternative is the worst outcome this file can produce. Without it, an
  // interview where multi-face, face-absent, gaze and identity matching NEVER RAN is reported
  // identically to one where all four ran and found nothing: risk 0, band "low", no flags. A
  // recruiter reads that as "we watched and they were clean". Recording it turns a silent absence
  // of evidence into visible evidence of absence, which is the whole discipline this module already
  // applies to a merely-unclear camera view.
  vision_unavailable: {
    severity: "low",
    weight: 0,
    cap: 0,
    label: "Camera-based checks did not run in this interview (not scored)",
  },
};

// Types that describe the RECORDING CONDITIONS rather than the candidate. They are surfaced to the
// recruiter (so "we couldn't see" is never silently rendered as "nothing happened") but contribute
// nothing to the risk score and can never move a candidate between risk bands.
const NON_SCORING_TYPES = new Set(["detector_uncertain", "vision_unavailable"]);

// A plausible benign explanation per flag type, so a recruiter reading the report
// doesn't over-anchor on "High risk" as proof of misconduct — most of these events
// have an innocent everyday cause.
const BENIGN_EXPLANATIONS = {
  tab_switch: "May be checking notes or a brief distraction, not necessarily cheating.",
  window_blur: "May be a notification or another window briefly stealing focus.",
  fullscreen_exit: "May be an accidental key press (Esc) or an OS prompt.",
  copy: "May be copying their own answer to review it, not lifting external content.",
  paste: "Could be pasting their own earlier notes rather than external material.",
  context_menu: "Often accidental (right-click) — low signal on its own.",
  face_absent: "May be webcam angle, lighting, or the candidate looking at notes — not necessarily absence.",
  multi_face: "Could be a reflection, poster, or someone briefly passing behind the candidate.",
  gaze_away: "May be glancing at notes or a second monitor, not disengagement.",
  detector_uncertain:
    "The camera view was too dim, distant, or cropped for the face detector to be reliable. This measures our own view quality, not the candidate — it carries no risk weight and should not be read as a flag.",
  vision_unavailable:
    "The camera-based checks (more than one person on camera, candidate away from camera, gaze, identity match) did not run in this interview — the model assets, the camera permission, or the device prevented it. This is a gap in OUR observation, not a finding about the candidate: read the risk score below as covering the browser signals only, and do not read the absence of camera flags as evidence that nothing happened.",
  identity_mismatch: "Lighting or camera angle can affect the match — treat as a prompt to verify, not a conclusion.",
  second_speaker:
    "Speaker separation is imperfect: a television, a nearby conversation, or a household interruption can be labelled as a second voice. Listen to the answer before concluding anything.",
  camera_lost: "Often a transient webcam/driver hiccup rather than an intentional camera-off.",
  phone_cam_lost: "Phones lock their screen or drop Wi-Fi easily — usually connectivity, not intent.",
  device_busy:
    "A stale browser tab, a closed-but-still-running app, or another call left open in the background can all hold a device — this is not proof of concurrent screen-sharing.",
  multi_display_detected: "A second monitor is common and unremarkable on its own — most candidates with one are not doing anything wrong.",
  bandwidth_anomaly: "Home wifi and ISP variance explain most of this — it is a weak signal on its own.",
  devtools_open: "Developer tools get opened for many innocent reasons (curiosity, a browser extension) — this is approximate and easily false-positive.",
};

function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(EVENT_TYPES, type);
}

function severityOf(type) {
  return EVENT_TYPES[type]?.severity || "low";
}

function labelOf(type) {
  return EVENT_TYPES[type]?.label || type;
}

function benignExplanationOf(type) {
  return BENIGN_EXPLANATIONS[type] || null;
}

// Only a short, numeric allow-list of metadata survives — never free-form client strings (they'd
// land in the admin report and the PDF). faceCount for multi_face, distance for identity checks.
function sanitizeMeta(type, meta) {
  if (!meta || typeof meta !== "object") return undefined;
  const out = {};
  if (type === "multi_face" && Number.isFinite(Number(meta.faceCount))) {
    out.faceCount = Math.max(0, Math.min(10, Math.round(Number(meta.faceCount))));
  }
  if (type === "identity_mismatch" && Number.isFinite(Number(meta.distance))) {
    out.distance = Math.round(Number(meta.distance) * 1000) / 1000;
  }
  // Which way they looked. "down" (notes, a phone, a keyboard) and "side" (a second monitor,
  // another person) are different findings for a reviewer, so the axis survives — but only as one
  // of two fixed enum values, never as a client-supplied string.
  if (type === "gaze_away" && (meta.direction === "down" || meta.direction === "side")) {
    out.direction = meta.direction;
  }
  if (type === "second_speaker") {
    if (Number.isFinite(Number(meta.secondaryWords))) {
      out.secondaryWords = Math.max(0, Math.min(9999, Math.round(Number(meta.secondaryWords))));
    }
    if (Number.isFinite(Number(meta.distinctSpeakers))) {
      out.distinctSpeakers = Math.max(0, Math.min(10, Math.round(Number(meta.distinctSpeakers))));
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// How much non-dominant speech in a single spoken answer counts as a second voice rather than a
// stray diarization label. Diarization mislabels the odd word routinely, so a handful of scattered
// words must never raise a high-severity flag against someone.
const SECOND_SPEAKER_MIN_WORDS = Number(process.env.SECOND_SPEAKER_MIN_WORDS || 8);

// Decide, server-side, whether a diarization report from one answer amounts to a second speaker.
// The browser reports word counts (a measurement); this decides what they MEAN (a judgement) —
// the same split used everywhere else in this file.
function detectSecondSpeaker(speakers) {
  if (!speakers || typeof speakers !== "object") return null;
  const secondaryWords = Number(speakers.secondaryWords);
  const distinctSpeakers = Number(speakers.distinctSpeakers);
  if (!Number.isFinite(secondaryWords) || !Number.isFinite(distinctSpeakers)) return null;
  if (distinctSpeakers < 2 || secondaryWords < SECOND_SPEAKER_MIN_WORDS) return null;
  return { secondaryWords, distinctSpeakers };
}

// Independent weak-signal "families" that individually prove nothing about a pre-existing screen
// share or outside help, but whose CONVERGENCE — several unrelated signals landing in the same
// session — is the only honest way to raise confidence without a ground-truth detector (none
// exists in a browser sandbox; see the event-type comments above). Capped low and added once,
// never compounded per-occurrence, so this can never become the dominant term in the score.
const CORRELATION_FAMILIES = ["device_busy", "multi_display_detected", "bandwidth_anomaly", "gaze_away", "multi_face"];
const CORRELATION_BONUS = { 2: 10, 3: 18 }; // family count -> bonus; 3+ all map to the 3+ cap
const CORRELATION_BONUS_CAP = 20;

function correlationBonus(counts) {
  const familiesPresent = CORRELATION_FAMILIES.filter((type) => Number(counts?.[type]) > 0).length;
  if (familiesPresent < 2) return 0;
  return Math.min(CORRELATION_BONUS_CAP, CORRELATION_BONUS[Math.min(familiesPresent, 3)]);
}

// §3.7: pure browser-chrome events — no camera/vision evidence, no identity signal, nothing from
// outside the browser tab itself. Three OS notifications and a brief fullscreen exit can fire all
// four of these with zero evidence the candidate did anything at all. Kept as its own set (rather
// than reusing CORRELATION_FAMILIES, which is about a different thing — convergence of weak
// proxies) because what it gates is a band CEILING, not a bonus.
const BROWSER_TIER_TYPES = new Set(["tab_switch", "window_blur", "fullscreen_exit", "context_menu"]);

function hasCorroboratingSignal(counts) {
  return Object.entries(counts || {}).some(
    ([type, n]) => isKnownType(type) && !NON_SCORING_TYPES.has(type) && !BROWSER_TIER_TYPES.has(type) && Number(n) > 0
  );
}

// Anti-cheating hard stop: the types strong enough to justify ending a session with no human step,
// counted toward a hard threshold that auto-submits instead of just scoring risk. Deliberately NOT
// every high-severity type — `second_speaker` is excluded even though it's weighted just as heavily
// above, because unlike `multi_face`/`identity_mismatch` (which fire once per confirmed episode) it
// can re-fire on every qualifying answer, and its own BENIGN_EXPLANATIONS entry above says a
// television or a nearby conversation can trigger it — too weak a signal to end a real candidate's
// session irreversibly on. `device_busy` is the one non-heuristic signal in this whole file (the
// camera/mic already held by another app is a real device conflict, not a guess) and is the closest
// honest proxy available for "something else is capturing this session" — see the event-type comment
// above for why a browser can never observe pre-existing screen-sharing directly.
const AUTO_SUBMIT_TRIGGER_TYPES = new Set(["multi_face", "identity_mismatch", "device_busy"]);

// counts: { [type]: occurrences }. Each type's contribution is still weighted + capped
// (as before), but the roll-up is severity-tier-dampened rather than a plain sum: a
// pile of routine medium/low-severity events (tab-switches, blur, gaze) can no longer
// alone reach the "High" band the way one real high-severity flag (multi_face,
// identity_mismatch) should. This fixes raw event counts hitting 100/100 from nothing
// but everyday tab-switching noise.
function computeRisk(counts) {
  const tier = { low: 0, medium: 0, high: 0 };
  for (const [type, n] of Object.entries(counts || {})) {
    const def = EVENT_TYPES[type];
    if (!def || !Number.isFinite(Number(n))) continue;
    // Recording-condition types are excluded structurally, not just given a zero weight, so a
    // later edit to the table cannot accidentally start scoring our own camera trouble as the
    // candidate's conduct.
    if (NON_SCORING_TYPES.has(type)) continue;
    tier[def.severity] += Math.min(def.cap, Math.max(0, Number(n)) * def.weight);
  }
  // Convergence of independently-caused weak signals (§ CORRELATION_FAMILIES above) — this
  // reflects several unrelated proxies lining up in one session, never detection of screen-sharing
  // itself. Added after the tier dampening, before the final clamp.
  const raw = tier.high + tier.medium * 0.55 + tier.low * 0.25 + correlationBonus(counts);
  const riskScore = Math.round(Math.max(0, Math.min(100, raw)));
  const corroborated = hasCorroboratingSignal(counts);
  // §3.7: require corroboration — a session with EVERY point of risk coming from browser-chrome
  // events alone is capped at "low" no matter how many of them fired. The raw score is left
  // untouched (still fully visible/auditable); only the band, which is what a recruiter actually
  // reads as a verdict, is capped.
  const riskBand = corroborated ? bandFor(riskScore) : "low";
  return { riskScore, riskBand, corroborated };
}

function bandFor(riskScore) {
  if (riskScore >= 50) return "high";
  if (riskScore >= 20) return "medium";
  return "low";
}

// Report-ready breakdown: one row per type that actually occurred, heaviest first. `scored: false`
// rows still appear — a recruiter must be able to see that the camera view was poor, because the
// alternative is rendering "we could not observe this" as "nothing happened".
function breakdown(counts) {
  return Object.entries(counts || {})
    .filter(([type, n]) => isKnownType(type) && Number(n) > 0)
    .map(([type, n]) => ({
      type,
      label: labelOf(type),
      severity: severityOf(type),
      count: Number(n),
      points: NON_SCORING_TYPES.has(type)
        ? 0
        : Math.min(EVENT_TYPES[type].cap, Number(n) * EVENT_TYPES[type].weight),
      scored: !NON_SCORING_TYPES.has(type),
      benignExplanation: benignExplanationOf(type),
    }))
    .sort((a, b) => b.points - a.points);
}

// B1 (REPORT-REDESIGN): the display roll-up — distinct findings, not raw event counts.
//
// 67 raw events on a session whose camera pipeline was struggling is almost always a handful of
// causes counted many times, and a recruiter reading "67 flags" has already concluded something
// no one measured. `breakdown` above is already the collapse (one row per type, weighted and
// capped); what this adds is the LABELLING of that collapse — §10.4: a count that silently
// shrinks between two viewings of the same session reads as tampering in an audit, so the
// roll-up states what it did, and the raw events stay reachable underneath it.
//
// `technicalFault: true` marks a session with a known recording fault (broken audio path,
// degraded signal). Camera/feed-loss events on such a session are ATTRIBUTED to the fault —
// still listed, but flagged `attributedToFault` and the risk BAND is withheld rather than
// printed: an integrity band computed while our own pipeline was failing is not a measurement
// of the candidate (rule 5).
const FAULT_ATTRIBUTABLE_TYPES = new Set(["camera_lost", "phone_cam_lost", "face_absent", "gaze_away"]);

function collapseForDisplay(counts, { technicalFault = false } = {}) {
  const findings = breakdown(counts).map((row) => ({
    ...row,
    attributedToFault: technicalFault && FAULT_ATTRIBUTABLE_TYPES.has(row.type),
  }));
  const totalEvents = Object.entries(counts || {})
    .filter(([type]) => isKnownType(type))
    .reduce((sum, [, n]) => sum + (Number(n) || 0), 0);
  return {
    findings,
    distinctFindings: findings.length,
    totalEvents,
    // The label §10.4 requires — shown beside the findings whenever the collapse hid a number.
    collapsedNote:
      totalEvents > findings.length
        ? `${totalEvents} raw event${totalEvents === 1 ? "" : "s"} collapsed to ${findings.length} distinct finding${findings.length === 1 ? "" : "s"} — every event remains listed in the detail below`
        : null,
    // Whether the band may be shown at all. Withheld ≠ hidden: the UI states WHY there is no band.
    bandWithheld: Boolean(technicalFault),
    bandWithheldReason: technicalFault
      ? "This session had a technical fault on our side, so the integrity band is withheld — camera and feed events during a faulty recording describe the fault, not the candidate."
      : null,
  };
}

module.exports = {
  EVENT_TYPES,
  NON_SCORING_TYPES,
  FAULT_ATTRIBUTABLE_TYPES,
  CORRELATION_FAMILIES,
  BROWSER_TIER_TYPES,
  AUTO_SUBMIT_TRIGGER_TYPES,
  collapseForDisplay,
  SECOND_SPEAKER_MIN_WORDS,
  detectSecondSpeaker,
  isKnownType,
  severityOf,
  labelOf,
  benignExplanationOf,
  sanitizeMeta,
  computeRisk,
  correlationBonus,
  bandFor,
  breakdown,
};
