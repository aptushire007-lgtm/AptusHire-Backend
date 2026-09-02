// The persistent session (W7) and progressive playback (W8).
//
// Both are latency work on the live audio path, and both have a failure mode that is silent: a
// session that stops transcribing looks exactly like a candidate who stopped talking, and an audio
// route that loses its authorization check looks exactly like one that still has it. The parts
// that can be tested without a browser or a live provider are tested here, and the parts that
// cannot are named in UPDATES.md rather than assumed.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const speech = require("../../services/speechService");
const speechAuth = require("../../utils/speechAuthorization");

test("the spoken-length estimate is sane and monotonic", () => {
  // It exists for one job: give the echo gate an idea of playback position during the first
  // moments of a STREAMED question, before the audio element knows its own duration. Wrong in
  // either direction is survivable — the real duration replaces it — but it must not be absurd,
  // because a wildly low estimate would make the gate think a question had finished and start
  // treating its own echo as the candidate.
  const short = speech.estimateSpeechMs("Tell me about it.");
  const long = speech.estimateSpeechMs(
    "Tell me about the Kafka migration you led at Zeta, and what your specific role was on that " +
      "team, particularly around the consumer rebalancing work."
  );
  assert.ok(short > 0);
  assert.ok(long > short, "a longer sentence must estimate longer");
  // An ordinary spoken question runs a few seconds — not a few hundred milliseconds, and not a
  // minute.
  assert.ok(long > 1500 && long < 30000, `implausible estimate: ${long}ms`);
  assert.equal(speech.estimateSpeechMs(""), speech.estimateSpeechMs("   "));
});

test("streaming did not move the authorization boundary", () => {
  // The whole risk of splitting playback into prepare + stream is that the second step becomes a
  // way to say something the first step never approved. It cannot: the ticket names text this
  // server stored, and what may be stored is decided by exactly the same function as before.
  const session = {
    aiInterview: {
      candidateFirstName: "Priya",
      turns: [{ role: "ai", kind: "question", text: "What did you own on that project?" }],
    },
  };
  assert.equal(speechAuth.authorize("What did you own on that project?", session).authorized, true);
  assert.equal(speechAuth.authorize("Thank you, Priya.", session).authorized, true);
  assert.equal(speechAuth.authorize("Do you have children?", session).authorized, false);
  // And enforcement is still on by default — a streaming path that quietly stopped refusing would
  // be the worst possible regression here.
  assert.equal(speechAuth.isEnforcing(), true);
});

test("both playback endpoints exist, and only the buffered one is behind the portal token", () => {
  // The ticket route deliberately carries no candidate auth: an <audio> element cannot send an
  // Authorization header, and putting the portal JWT in the URL would write a live session token
  // into browser history and every access log it passes. This pins that trade-off so it reads as
  // a decision rather than an oversight — and pins that NOTHING ELSE lost its auth alongside it.
  const router = require("../../routes/interviewPortalRoutes");
  const routes = router.stack
    .filter((l) => l.route)
    .map((l) => ({
      path: l.route.path,
      methods: Object.keys(l.route.methods),
      handlers: l.route.stack.length,
    }));

  const prepare = routes.find((r) => r.path === "/voice/speak/stream" && r.methods.includes("post"));
  const stream = routes.find((r) => r.path === "/voice/speak/stream/:ticket" && r.methods.includes("get"));
  const buffered = routes.find((r) => r.path === "/voice/speak" && r.methods.includes("post"));

  assert.ok(prepare, "the authorising step must exist");
  assert.ok(stream, "the streaming step must exist");
  assert.ok(buffered, "the buffered endpoint stays for short cached phrases");

  // prepare and buffered carry auth + rate limiting + handler; the ticket route carries only its
  // handler. If the ticket route ever grows middleware, or the others ever lose it, this fails.
  assert.equal(stream.handlers, 1, "the ticket is the credential — nothing else guards this route");
  assert.ok(prepare.handlers > 1, "authorising a sentence must stay authenticated");
  assert.ok(buffered.handlers > 1, "the buffered endpoint must stay authenticated");
});

test("every voice route the interview depends on is still mounted", () => {
  // A persistent session leans on the token endpoint for RECONNECTS as well as for the first
  // connection, which is easy to forget when the first connection stops being the only one.
  const router = require("../../routes/interviewPortalRoutes");
  const paths = new Set(router.stack.filter((l) => l.route).map((l) => l.route.path));
  for (const p of ["/voice/token", "/voice/speak", "/voice/speak/stream", "/voice/intent", "/voice/consent"]) {
    assert.ok(paths.has(p), `${p} is missing`);
  }
});
