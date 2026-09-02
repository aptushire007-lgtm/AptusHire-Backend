// Browser-captured interview recording (docs/INTERVIEW-RECORDING-MEDIARECORDER-PLAN.md).
//
// The tests that matter most are the ones about what this path REFUSES to do, because each is one
// careless edit away from becoming the thing it was built to avoid: recording someone under a
// consent clause that promises the opposite, calling a stitch failure "failed" so the footage
// looks lost, letting a valid portal token fill a bucket, and — the pre-existing bug this work
// also closes — leaving a video of a candidate in storage after they exercised their right to
// erasure.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const recording = require("../../services/interviewRecordingService");
const storageService = require("../../services/storageService");
const InterviewSession = require("../../models/InterviewSession");

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(64, 1)]);
const NOT_VIDEO = Buffer.from("%PDF-1.7 this is a resume, not a chunk", "ascii");

const originals = {
  put: storageService.putObject,
  get: storageService.getObjectBuffer,
  del: storageService.deleteObject,
  enabled: storageService.isEnabled,
};
afterEach(() => {
  storageService.putObject = originals.put;
  storageService.getObjectBuffer = originals.get;
  storageService.deleteObject = originals.del;
  storageService.isEnabled = originals.enabled;
  delete process.env.CLIENT_RECORDING_ENABLED;
});

function fakeSession({ consented = true, chunks = [], status, startedAt } = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    company: new mongoose.Types.ObjectId(),
    candidate: new mongoose.Types.ObjectId(),
    startedAt: startedAt || new Date(Date.now() - 60_000),
    proctoring: {
      consent: { given: true },
      recordingConsent: { given: consented, declined: !consented },
    },
    aiInterview: { recordingChunks: chunks, ...(status ? { recordingStatus: status } : {}) },
    markModified() {},
    async save() {},
  };
}

// A storage double that behaves like the real one: what goes in comes back out by key.
function fakeStorage() {
  const objects = new Map();
  storageService.putObject = async ({ buffer, key }) => {
    objects.set(key, buffer);
    return key;
  };
  storageService.getObjectBuffer = async (key) => {
    if (!objects.has(key)) throw new Error(`no such object: ${key}`);
    return objects.get(key);
  };
  storageService.deleteObject = async (key) => {
    objects.delete(key);
  };
  return objects;
}

// ---------------------------------------------------------------------------
// Consent — the reason this feature has a third clause at all
// ---------------------------------------------------------------------------

test("no recording consent means no stored chunk, ever", async () => {
  // The base proctoring clause tells the candidate "raw video is not uploaded" and the clip clause
  // tells them they are "never recorded continuously". Neither can carry a full-session recording,
  // so consent for it is its own field — and the server refuses without it even if the browser
  // somehow started capturing.
  fakeStorage();
  const session = fakeSession({ consented: false });
  await assert.rejects(
    () => recording.storeChunk({ session, buffer: WEBM, seq: 0 }),
    (err) => err.status === 403 && err.code === "RECORDING_CONSENT_REQUIRED"
  );
  assert.equal(session.aiInterview.recordingChunks.length, 0);
});

test("base proctoring consent alone is not enough", async () => {
  fakeStorage();
  const session = fakeSession({ consented: false });
  session.proctoring.evidenceConsent = { given: true }; // clips consented, recording not
  await assert.rejects(
    () => recording.storeChunk({ session, buffer: WEBM, seq: 0 }),
    (err) => err.status === 403
  );
});

// ---------------------------------------------------------------------------
// Hostile input — the same posture evidence clips already live under
// ---------------------------------------------------------------------------

test("the bytes decide the type, not the client's claim", async () => {
  fakeStorage();
  const session = fakeSession();
  await assert.rejects(
    () => recording.storeChunk({ session, buffer: NOT_VIDEO, seq: 0 }),
    (err) => err.status === 400
  );
  assert.equal(recording.detectChunkType(WEBM), "video/webm");
  assert.equal(recording.detectChunkType(MP4), "video/mp4");
  assert.equal(recording.detectChunkType(NOT_VIDEO), null);
});

test("an oversized chunk is refused server-side, not merely by multer", async () => {
  fakeStorage();
  const session = fakeSession();
  const huge = Buffer.concat([WEBM, Buffer.alloc(recording.MAX_CHUNK_BYTES, 2)]);
  await assert.rejects(
    () => recording.storeChunk({ session, buffer: huge, seq: 0 }),
    (err) => err.status === 413
  );
});

test("a replayed sequence number is refused rather than allowed to overwrite", async () => {
  // Uploads are fire-and-forget, so a retry after a request that actually succeeded is normal.
  // Accepting it would leave two objects claiming the same position in the interview.
  fakeStorage();
  const session = fakeSession();
  await recording.storeChunk({ session, buffer: WEBM, seq: 0 });
  await assert.rejects(
    () => recording.storeChunk({ session, buffer: WEBM, seq: 0 }),
    (err) => err.status === 409 && err.code === "RECORDING_CHUNK_DUPLICATE"
  );
  assert.equal(session.aiInterview.recordingChunks.length, 1);
});

test("the per-session chunk cap is enforced by the server", async () => {
  fakeStorage();
  const chunks = Array.from({ length: recording.MAX_CHUNKS_PER_SESSION }, (_, i) => ({
    key: `k${i}`,
    seq: i,
    bytes: 10,
  }));
  const session = fakeSession({ chunks });
  await assert.rejects(
    () => recording.storeChunk({ session, buffer: WEBM, seq: 0 }),
    (err) => err.status === 429 && err.code === "RECORDING_CAP_REACHED"
  );
});

test("the total-bytes cap is enforced even when the chunk count is fine", async () => {
  fakeStorage();
  const session = fakeSession({ chunks: [{ key: "k0", seq: 0, bytes: recording.MAX_TOTAL_BYTES }] });
  await assert.rejects(
    () => recording.storeChunk({ session, buffer: WEBM, seq: 1 }),
    (err) => err.status === 429
  );
});

// ---------------------------------------------------------------------------
// The capture clock — what makes the report's timestamps exact instead of guessed
// ---------------------------------------------------------------------------

test("recordingStartedAt is taken from the first chunk and cannot be moved later", async () => {
  fakeStorage();
  const session = fakeSession();
  const first = new Date(Date.now() - 30_000);
  await recording.storeChunk({ session, buffer: WEBM, seq: 0, startedAt: first.toISOString() });
  assert.equal(session.aiInterview.recordingStartedAt.getTime(), first.getTime());

  // A later chunk claiming a different origin must not shift every timestamp in the recording.
  await recording.storeChunk({ session, buffer: WEBM, seq: 1, startedAt: new Date().toISOString() });
  assert.equal(session.aiInterview.recordingStartedAt.getTime(), first.getTime());
});

test("a capture clock outside the session's own window is discarded, not stored", async () => {
  fakeStorage();
  const session = fakeSession({ startedAt: new Date(Date.now() - 60_000) });
  // Before the interview began: a skewed or hostile clock. Falls back to arrival time.
  await recording.storeChunk({ session, buffer: WEBM, seq: 0, startedAt: "2001-01-01T00:00:00.000Z" });
  assert.ok(session.aiInterview.recordingStartedAt.getTime() >= Date.now() - 5000);

  const future = fakeSession();
  await recording.storeChunk({
    session: future,
    buffer: WEBM,
    seq: 0,
    startedAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assert.ok(future.aiInterview.recordingStartedAt.getTime() <= Date.now() + 1000);
});

// ---------------------------------------------------------------------------
// Finalize — where "the recording is gone" and "we could not assemble it" part ways
// ---------------------------------------------------------------------------

test("chunks are stitched in seq order, not arrival order", async () => {
  // Uploads are fire-and-forget over a candidate's home connection; out-of-order arrival is the
  // normal case, not the exceptional one. Ordering by insertion would scramble the interview.
  const objects = fakeStorage();
  const session = fakeSession();
  await recording.storeChunk({ session, buffer: Buffer.concat([WEBM, Buffer.from("B")]), seq: 1 });
  await recording.storeChunk({ session, buffer: Buffer.concat([WEBM, Buffer.from("A")]), seq: 0 });

  const result = await recording.finalize({ session });
  assert.equal(result.status, "completed");
  const stitched = objects.get(session.aiInterview.recordingKey);
  assert.ok(stitched.indexOf(Buffer.from("A")) < stitched.indexOf(Buffer.from("B")));
});

test("a successful stitch deletes the chunks, and only after the joined file is durable", async () => {
  const objects = fakeStorage();
  const session = fakeSession();
  await recording.storeChunk({ session, buffer: WEBM, seq: 0 });
  await recording.storeChunk({ session, buffer: WEBM, seq: 1 });
  const chunkKeys = session.aiInterview.recordingChunks.map((c) => c.key);

  await recording.finalize({ session });
  assert.equal(session.aiInterview.recordingChunks.length, 0);
  for (const k of chunkKeys) assert.equal(objects.has(k), false, "chunk objects are cleaned up");
  assert.ok(objects.has(session.aiInterview.recordingKey), "the stitched file survives");
});

test("a failed stitch is 'partial', never 'failed' — the footage exists", async () => {
  // "failed" tells a reviewer nothing was recorded. That is a different fact, and believing it
  // would make a retry look pointless when the chunks are sitting in the bucket intact.
  fakeStorage();
  const session = fakeSession();
  await recording.storeChunk({ session, buffer: WEBM, seq: 0 });
  storageService.getObjectBuffer = async () => {
    throw new Error("S3 is having a day");
  };
  const result = await recording.finalize({ session });
  assert.equal(result.status, "partial");
  assert.equal(session.aiInterview.recordingChunks.length, 1, "the chunks are kept, so a retry is possible");
  assert.equal(session.aiInterview.recordingKey, undefined);
});

test("zero chunks is the honest 'failed'", async () => {
  fakeStorage();
  const session = fakeSession();
  const result = await recording.finalize({ session });
  assert.equal(result.status, "failed");
  assert.equal(result.chunks, 0);
});

test("duration is summed from the chunks we hold, never taken from the client's claim", async () => {
  // A recording that reports 40:00 and plays 31:00 invites a reviewer to assume the missing nine
  // minutes were silence. The reported length has to shrink when a chunk is lost.
  fakeStorage();
  const session = fakeSession();
  await recording.storeChunk({ session, buffer: WEBM, seq: 0, durationMs: 45_000 });
  await recording.storeChunk({ session, buffer: WEBM, seq: 1, durationMs: 45_000 });
  const result = await recording.finalize({ session, durationMs: 2_400_000 });
  assert.equal(result.durationMs, 90_000);
});

test("finalize is idempotent — three callers race and only one may stitch", async () => {
  // The interview's own end, the tab-close beacon, and a reload. A second stitched object would
  // orphan the first and double the storage for every recording.
  const objects = fakeStorage();
  const session = fakeSession();
  await recording.storeChunk({ session, buffer: WEBM, seq: 0 });
  await recording.finalize({ session });
  const key = session.aiInterview.recordingKey;
  const objectCount = objects.size;

  const second = await recording.finalize({ session });
  assert.equal(second.already, true);
  assert.equal(session.aiInterview.recordingKey, key);
  assert.equal(objects.size, objectCount, "no second object was written");
});

test("MP4 chunks are kept but not concatenated — Safari lands 'partial', it does not lie", async () => {
  // WebM chunks from one recorder session share an initialization segment and join cleanly.
  // Fragmented MP4 does not, and claiming a playable file we cannot produce would hand the
  // reviewer a broken player instead of an explanation.
  fakeStorage();
  const session = fakeSession();
  await recording.storeChunk({ session, buffer: MP4, seq: 0 });
  const result = await recording.finalize({ session });
  assert.equal(result.status, "partial");
  assert.equal(session.aiInterview.recordingChunks.length, 1);
});

// ---------------------------------------------------------------------------
// Playback and erasure
// ---------------------------------------------------------------------------

test("a partial recording yields no playback URL", async () => {
  storageService.isEnabled = () => true;
  const session = { aiInterview: { recordingStatus: "partial", recordingKey: null } };
  assert.equal(await recording.playbackUrl(session), null);
});

test("storedKeys covers BOTH producers, which is what makes erasure complete", async () => {
  // This is the fix for a live gap: the LiveKit Egress path wrote `recordingKey` and nothing in
  // candidatePurgeService ever deleted it, so erasing a candidate left a video of their face and
  // voice in the bucket. Both the stitched file and any leftover chunks have to come back here.
  assert.deepEqual(recording.storedKeys({ aiInterview: { recordingKey: "egress/old.mp4" } }), ["egress/old.mp4"]);
  assert.deepEqual(
    recording.storedKeys({
      aiInterview: { recordingKey: "r/final.webm", recordingChunks: [{ key: "r/c0" }, { key: "r/c1" }] },
    }),
    ["r/c0", "r/c1", "r/final.webm"]
  );
  assert.deepEqual(recording.storedKeys({}), []);
  assert.deepEqual(recording.storedKeys(null), []);
});

// ---------------------------------------------------------------------------
// The flag
// ---------------------------------------------------------------------------

test("off by default, per-tenant overridable both ways, and dead without storage", () => {
  storageService.isEnabled = () => true;
  assert.equal(recording.enabled(undefined), false, "no env, no setting ⇒ off");

  process.env.CLIENT_RECORDING_ENABLED = "true";
  assert.equal(recording.enabled(undefined), true);
  assert.equal(recording.enabled({ ai: { sessionRecording: false } }), false, "a tenant can opt out of the fleet default");

  delete process.env.CLIENT_RECORDING_ENABLED;
  assert.equal(recording.enabled({ ai: { sessionRecording: true } }), true, "and opt in without it");

  // A recorder that runs and silently discards everything is worse than one that never starts,
  // because the candidate consented to it.
  storageService.isEnabled = () => false;
  assert.equal(recording.enabled({ ai: { sessionRecording: true } }), false);
});

test("recording is not implied by videoEnabled", () => {
  // "The recruiter can see the candidate live" and "a video of this person is kept afterwards" are
  // different decisions with different consent and retention consequences. Turning on the first
  // must never turn on the second.
  storageService.isEnabled = () => true;
  assert.equal(recording.enabled({ ai: { videoEnabled: true } }), false);
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test("the model can express 'assembled', 'exists but unplayable' and 'nothing arrived' separately", () => {
  const path = InterviewSession.schema.path("aiInterview.recordingStatus");
  for (const s of ["pending", "recording", "completed", "partial", "failed"]) {
    assert.ok(path.enumValues.includes(s), `${s} must be a representable state`);
  }
  assert.ok(InterviewSession.schema.path("aiInterview.recordingStartedAt"), "the capture clock is stored");
  assert.ok(InterviewSession.schema.path("proctoring.recordingConsent.given"), "recording consent is its own clause");
  assert.ok(
    InterviewSession.schema.path("proctoring.recordingConsent.wordingVersion"),
    "and records which wording was accepted, so a later rewrite never makes an old consent unreadable"
  );
});
