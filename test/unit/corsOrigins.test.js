// The allow-list is compared against the browser's Origin header by EXACT string
// equality, both by the cors middleware and by the Socket.io handshake. That makes it
// a parsing problem disguised as a config problem: one character of formatting drift in
// an env var rejects every request from that app, and the server logs nothing unusual
// because a CORS rejection is a correct, deliberate refusal.
//
// The trap that motivates these gates: link-building runs through normalizeBase(), which
// already strips a trailing slash, while the allow-list did not. So a pasted
// "https://app.onrender.com/" produced working interview EMAILS and a completely dead
// SPA — a symptom that points at the frontend, the API URL, or the deploy, and never at
// the one character actually responsible.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseOrigins, candidateLinkBase, normalizeBase } = require("../../utils/corsOrigins");

// What a browser actually puts in the Origin header: scheme + host + optional port, and
// never a path — so never a trailing slash, whatever the operator pasted.
const BROWSER_ORIGIN = "https://recruitment-admin.onrender.com";

test("ACCEPTANCE GATE: a trailing slash in the env var still matches the browser's Origin", () => {
  const allowed = parseOrigins("https://recruitment-admin.onrender.com/", null);
  assert.ok(
    allowed.includes(BROWSER_ORIGIN),
    "a dashboard/address-bar paste carries a trailing slash; unstripped it rejects 100% of requests"
  );
});

test("every formatting variant an operator can paste resolves to the same origin", () => {
  for (const raw of [
    "https://recruitment-admin.onrender.com",
    "https://recruitment-admin.onrender.com/",
    "https://recruitment-admin.onrender.com//",
    "  https://recruitment-admin.onrender.com/  ",
  ]) {
    assert.deepEqual(parseOrigins(raw), [BROWSER_ORIGIN], `failed for ${JSON.stringify(raw)}`);
  }
});

test("a comma-separated list is split, trimmed and stripped per entry", () => {
  assert.deepEqual(
    parseOrigins("https://a.onrender.com/, http://localhost:5173 ,", "https://b.onrender.com/"),
    ["https://a.onrender.com", "http://localhost:5173", "https://b.onrender.com"]
  );
});

test("stripping stops at the trailing slash — a port or path prefix is never mangled", () => {
  // http://localhost:5174 must survive intact, and a base that genuinely carries a path
  // must keep it: truncating either silently repoints the app somewhere else.
  assert.deepEqual(parseOrigins("http://localhost:5174/"), ["http://localhost:5174"]);
  assert.deepEqual(parseOrigins("https://example.com/app/"), ["https://example.com/app"]);
});

test("unset vars produce an empty list, not [''] — an empty string would match nothing forever", () => {
  assert.deepEqual(parseOrigins(undefined, "", null), []);
});

test("the CORS list and the emailed link base agree on the same paste", () => {
  const prev = process.env.PUBLIC_CANDIDATE_URL;
  process.env.PUBLIC_CANDIDATE_URL = "https://recruitment-user.onrender.com/";
  try {
    // The regression these two assertions pin: these used to disagree, and the
    // disagreement is what made the failure so hard to place.
    assert.equal(candidateLinkBase(), "https://recruitment-user.onrender.com");
    assert.deepEqual(parseOrigins(process.env.PUBLIC_CANDIDATE_URL), ["https://recruitment-user.onrender.com"]);
    assert.equal(normalizeBase(process.env.PUBLIC_CANDIDATE_URL), parseOrigins(process.env.PUBLIC_CANDIDATE_URL)[0]);
  } finally {
    if (prev === undefined) delete process.env.PUBLIC_CANDIDATE_URL;
    else process.env.PUBLIC_CANDIDATE_URL = prev;
  }
});
