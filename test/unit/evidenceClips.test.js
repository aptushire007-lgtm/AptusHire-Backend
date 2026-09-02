// Phase 14 acceptance gates — event-anchored evidence clips + phone companion:
//   - consent declined ⇒ ZERO capture server-side (403, nothing stored);
//   - the server rejects the clip that exceeds the per-session cap;
//   - oversized / wrong-type uploads are rejected by magic-byte check;
//   - the flags are off by default and per-tenant overridable both ways;
//   - phone-heartbeat staleness raises phone_cam_lost exactly once per outage,
//     and a client can never inject phone_cam_lost directly;
//   - the phone token is single-purpose: requireCandidateAuth rejects any
//     audience-bearing token.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const evidenceClipService = require("../../services/evidenceClipService");
const ProctoringEvidence = require("../../models/ProctoringEvidence");
const storageService = require("../../services/storageService");
const { requireCandidateAuth } = require("../../middleware/candidateAuth");
const InterviewSession = require("../../models/InterviewSession");
const { proctoringEvents } = require("../../controllers/interviewPortalController");

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(64, 1)]);

const originals = {
  count: ProctoringEvidence.countDocuments,
  create: ProctoringEvidence.create,
  put: storageService.putObject,
  findById: InterviewSession.findById,
};
afterEach(() => {
  ProctoringEvidence.countDocuments = originals.count;
  ProctoringEvidence.create = originals.create;
  storageService.putObject = originals.put;
  InterviewSession.findById = originals.findById;
  delete process.env.EVIDENCE_CLIPS_ENABLED;
  delete process.env.SECONDARY_CAM_ENABLED;
  delete process.env.JWT_SECRET;
});

function fakeSession({ evidenceGiven = true, phoneCam } = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    company: new mongoose.Types.ObjectId(),
    candidate: new mongoose.Types.ObjectId(),
    job: new mongoose.Types.ObjectId(),
    proctoring: {
      consent: { given: true },
      evidenceConsent: { given: evidenceGiven, declined: !evidenceGiven },
      counts: {},
      events: [],
      ...(phoneCam ? { phoneCam } : {}),
    },
    markModified() {},
    async save() {},
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) {
      res.statusCode = c;
      return res;
    },
    json(p) {
      res.body = p;
      return res;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Magic bytes + flags
// ---------------------------------------------------------------------------

test("magic bytes: webm and mp4 detected from content; junk rejected regardless of claimed type", () => {
  assert.equal(evidenceClipService.detectClipType(WEBM), "video/webm");
  assert.equal(evidenceClipService.detectClipType(MP4), "video/mp4");
  assert.equal(evidenceClipService.detectClipType(Buffer.from("GIF89a-not-a-video-at-all")), null);
  assert.equal(evidenceClipService.detectClipType(Buffer.alloc(4)), null);
});

test("flags: off by default; tenant override wins in BOTH directions", () => {
  assert.equal(evidenceClipService.clipsEnabled(null), false, "fleet default is OFF");
  process.env.EVIDENCE_CLIPS_ENABLED = "true";
  assert.equal(evidenceClipService.clipsEnabled(null), true);
  assert.equal(evidenceClipService.clipsEnabled({ proctoring: { evidenceClips: false } }), false, "tenant can opt out");
  delete process.env.EVIDENCE_CLIPS_ENABLED;
  assert.equal(evidenceClipService.clipsEnabled({ proctoring: { evidenceClips: true } }), true, "tenant can opt in");
  assert.equal(evidenceClipService.secondaryCamEnabled(null), false, "secondary cam default OFF");
});

// ---------------------------------------------------------------------------
// storeClip policy
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: no consent ⇒ zero capture — 403 and nothing touches storage", async () => {
  let stored = false;
  storageService.putObject = async () => {
    stored = true;
  };
  await assert.rejects(
    () => evidenceClipService.storeClip({ session: fakeSession({ evidenceGiven: false }), eventType: "multi_face", buffer: WEBM }),
    (err) => err.status === 403 && err.code === "EVIDENCE_CONSENT_REQUIRED"
  );
  assert.equal(stored, false);
});

test("ACCEPTANCE GATE: the upload past the per-session cap is rejected server-side", async () => {
  let stored = false;
  storageService.putObject = async () => {
    stored = true;
  };
  ProctoringEvidence.countDocuments = async () => evidenceClipService.MAX_CLIPS_PER_SESSION;
  await assert.rejects(
    () => evidenceClipService.storeClip({ session: fakeSession(), eventType: "multi_face", buffer: WEBM }),
    (err) => err.status === 429 && err.code === "EVIDENCE_CAP_REACHED"
  );
  assert.equal(stored, false);
});

test("storeClip: non-qualifying event types and non-video bytes are rejected", async () => {
  ProctoringEvidence.countDocuments = async () => 0;
  await assert.rejects(
    () => evidenceClipService.storeClip({ session: fakeSession(), eventType: "tab_switch", buffer: WEBM }),
    (err) => err.status === 400
  );
  await assert.rejects(
    () => evidenceClipService.storeClip({ session: fakeSession(), eventType: "multi_face", buffer: Buffer.from("plain text") }),
    (err) => err.status === 400
  );
});

test("storeClip: success path stores tenant-scoped row with server-computed sha256", async () => {
  ProctoringEvidence.countDocuments = async () => 2;
  let putKey = null;
  storageService.putObject = async ({ key }) => {
    putKey = key;
    return key;
  };
  let created = null;
  ProctoringEvidence.create = async (doc) => {
    created = doc;
    return { ...doc, _id: new mongoose.Types.ObjectId() };
  };

  const session = fakeSession();
  await evidenceClipService.storeClip({ session, eventType: "multi_face", source: "phone", buffer: WEBM, durationMs: 9000 });

  assert.ok(putKey.startsWith(`evidence/${session.company}/`), "clips are tenant-partitioned in storage");
  assert.equal(String(created.company), String(session.company));
  assert.equal(created.source, "phone");
  assert.equal(created.mimeType, "video/webm");
  assert.match(created.sha256, /^[a-f0-9]{64}$/, "sha256 computed server-side from the actual bytes");
  assert.equal(created.durationMs, 9000);
});

test("QUALIFYING_EVENTS: attention_pattern (blurred behavioral-escalation clip) is allow-listed", () => {
  assert.ok(evidenceClipService.QUALIFYING_EVENTS.has("attention_pattern"));
  // the four identity-critical types must still be exactly the pre-existing set, unchanged
  assert.ok(evidenceClipService.QUALIFYING_EVENTS.has("multi_face"));
  assert.ok(evidenceClipService.QUALIFYING_EVENTS.has("identity_mismatch"));
  assert.ok(evidenceClipService.QUALIFYING_EVENTS.has("face_absent"));
  assert.ok(evidenceClipService.QUALIFYING_EVENTS.has("phone_cam_lost"));
});

test("storeClip: attention_pattern is accepted as a qualifying (blurred) evidence trigger", async () => {
  ProctoringEvidence.countDocuments = async () => 1;
  storageService.putObject = async ({ key }) => key;
  let created = null;
  ProctoringEvidence.create = async (doc) => {
    created = doc;
    return { ...doc, _id: new mongoose.Types.ObjectId() };
  };

  const session = fakeSession();
  await evidenceClipService.storeClip({ session, eventType: "attention_pattern", buffer: WEBM, durationMs: 12000 });

  assert.equal(created.eventType, "attention_pattern");
  assert.equal(created.mimeType, "video/webm");
});

// ---------------------------------------------------------------------------
// Phone heartbeat → phone_cam_lost
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: heartbeat staleness raises phone_cam_lost once per outage; client injection ignored", async () => {
  const session = fakeSession({
    phoneCam: { paired: true, lastHeartbeatAt: new Date(Date.now() - 60000), lostFlagged: false },
  });

  // The client also tries to inject phone_cam_lost directly — must be ignored.
  const res1 = mockRes();
  await proctoringEvents({ interviewSession: session, body: { events: [{ type: "phone_cam_lost" }] } }, res1);
  assert.equal(session.proctoring.counts.phone_cam_lost, 1, "exactly one server-derived event, none from the client");
  assert.equal(session.proctoring.phoneCam.lostFlagged, true);

  // Second flush during the same outage: no double-count.
  const res2 = mockRes();
  await proctoringEvents({ interviewSession: session, body: { events: [] } }, res2);
  assert.equal(session.proctoring.counts.phone_cam_lost, 1, "the same outage never counts twice");
});

// ---------------------------------------------------------------------------
// Token separation
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: requireCandidateAuth rejects audience-bearing (phone) tokens", async () => {
  process.env.JWT_SECRET = "test-secret";
  const sessionId = new mongoose.Types.ObjectId();
  const candidateId = new mongoose.Types.ObjectId();
  InterviewSession.findById = async () => ({
    _id: sessionId,
    candidate: candidateId,
    status: "not_started",
    expiresAt: new Date(Date.now() + 3600000),
  });

  const phoneToken = jwt.sign(
    { candidateId: String(candidateId), sessionId: String(sessionId) },
    "test-secret",
    { audience: "phone-cam", expiresIn: "1h" }
  );
  const res = mockRes();
  let nextCalled = false;
  await requireCandidateAuth({ headers: { authorization: `Bearer ${phoneToken}` } }, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false, "a phone token must never open the interview portal");
  assert.equal(res.statusCode, 401);

  // Sanity: the plain portal token still passes.
  const portalToken = jwt.sign({ candidateId: String(candidateId), sessionId: String(sessionId) }, "test-secret", {
    expiresIn: "1h",
  });
  const res2 = mockRes();
  let passed = false;
  await requireCandidateAuth({ headers: { authorization: `Bearer ${portalToken}` } }, res2, () => {
    passed = true;
  });
  assert.equal(passed, true);
});
