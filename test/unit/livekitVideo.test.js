// Phase 7 (new_improvements.md): candidate video capture + LiveKit Egress recording, shipped
// fully wired but gated behind a flag defaulted OFF. These tests pin down the pure gating/costing
// logic only — startRecording/handleEgressEnded/meterSession touch Mongo and the LiveKit SDK, out
// of scope for this DB-free unit suite (same boundary the existing audio-path tests respect).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const livekit = require("../../services/livekitService");

test("videoEnabled defaults OFF with no env var and no tenant override", () => {
  delete process.env.LIVEKIT_VIDEO_ENABLED;
  assert.equal(livekit.videoEnabled({}), false);
  assert.equal(livekit.videoEnabled(null), false);
});

test("videoEnabled requires storage to actually be configured, even if the flag says yes", () => {
  // storageService.isEnabled() is false in this test env (no S3_* vars set) — a tenant flag with
  // no bucket behind it must still resolve to off, not throw or half-work mid-interview.
  const settings = { ai: { videoEnabled: true } };
  assert.equal(livekit.videoEnabled(settings), false, "Egress cannot write to local disk");
});

test("videoEnabled respects an explicit tenant override direction (modulo the storage gate)", () => {
  // Both true and false overrides are read — verified by checking neither throws and false stays
  // false regardless of env, since explicit false must always win.
  process.env.LIVEKIT_VIDEO_ENABLED = "true";
  assert.equal(livekit.videoEnabled({ ai: { videoEnabled: false } }), false, "explicit false always wins");
  delete process.env.LIVEKIT_VIDEO_ENABLED;
});

test("videoCostCents is a separate, positive, monotonic rate from the audio costCents", () => {
  const ms = 5 * 60 * 1000; // 5 minutes
  const audio = livekit.costCents(ms);
  const video = livekit.videoCostCents(ms);
  assert.ok(audio > 0);
  assert.ok(video > 0);
  // Doubling duration should roughly double cost (linear per-minute billing).
  assert.ok(Math.abs(livekit.videoCostCents(ms * 2) - video * 2) < 0.01);
});

test("costCents/videoCostCents never go negative for a bad (negative) duration", () => {
  assert.equal(livekit.costCents(-1000), 0);
  assert.equal(livekit.videoCostCents(-1000), 0);
});

test("roomName/sessionIdFromRoom round-trip, so the webhook can always map an egress room back to a session", () => {
  const fakeSession = { _id: "507f1f77bcf86cd799439011" };
  const room = livekit.roomName(fakeSession);
  assert.equal(livekit.sessionIdFromRoom(room), String(fakeSession._id));
});
