// Every password-reset email this platform ever attempted failed with "Connection timeout",
// while the same credentials verified fine from a developer laptop. The code was correct the
// whole time: the deploy host blocks outbound SMTP, and nothing in the system could tell the
// difference between "the relay refused us" and "we are not allowed to reach the relay".
//
// Two consequences are gated here:
//   1. There must be a transport that cannot be port-blocked (the Brevo HTTP API), and it
//      must win over SMTP when configured, or a deploy fixes the outage by adding a key and
//      keeps timing out anyway.
//   2. The SMTP path must carry explicit timeouts. Nodemailer defaults to ~2 minutes per
//      phase, so against a blackholed port each attempt hangs for minutes and BullMQ's three
//      retries occupy a worker for ~6 — which is why two reset emails sat in "retrying" for
//      ten minutes instead of failing fast and raising the alert.
//
// The third gate is the sender identity: MAIL_FROM was a gmail.com address relayed through a
// third party, which fails DMARC alignment. That one is invisible — the provider accepts the
// message and the recipient's server silently junks it — so it has to be caught by config
// inspection rather than by any delivery signal.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  sendMail,
  resolveMode,
  smtpOptions,
  describeTransport,
  isFreemailSender,
  parseAddress,
  parseAddressList,
} = require("../../utils/mailer");

const MAIL_ENV = [
  "BREVO_API_KEY",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_TIMEOUT_MS",
  "MAIL_FROM",
  "NODE_ENV",
];

let savedEnv;
let savedFetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(MAIL_ENV.map((k) => [k, process.env[k]]));
  MAIL_ENV.forEach((k) => delete process.env[k]);
  savedFetch = global.fetch;
});

afterEach(() => {
  MAIL_ENV.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
  global.fetch = savedFetch;
});

test("ACCEPTANCE GATE: the HTTP API wins over SMTP, so adding the key actually fixes a port-blocked host", () => {
  process.env.SMTP_HOST = "smtp-relay.brevo.com";
  process.env.BREVO_API_KEY = "xkeysib-test";

  assert.equal(resolveMode(), "brevo-api", "SMTP_HOST left over from the broken config must not win");
  assert.equal(describeTransport().delivers, true);
});

test("ACCEPTANCE GATE: SMTP carries explicit timeouts on all three phases", () => {
  process.env.SMTP_HOST = "smtp-relay.brevo.com";
  const opts = smtpOptions();

  for (const phase of ["connectionTimeout", "greetingTimeout", "socketTimeout"]) {
    assert.equal(typeof opts[phase], "number", `${phase} must be set explicitly`);
    assert.ok(
      opts[phase] > 0 && opts[phase] <= 30000,
      `${phase}=${opts[phase]}ms — nodemailer's ~2min default is what let one dead send stall a worker`
    );
  }
});

test("SMTP_TIMEOUT_MS overrides the default without touching code", () => {
  process.env.SMTP_HOST = "smtp-relay.brevo.com";
  process.env.SMTP_TIMEOUT_MS = "4000";

  assert.equal(smtpOptions().connectionTimeout, 4000);
});

test("SMTP port and auth follow the env, defaulting to 587 with no auth", () => {
  process.env.SMTP_HOST = "smtp-relay.brevo.com";
  assert.equal(smtpOptions().port, 587);
  assert.equal(smtpOptions().auth, undefined, "an empty SMTP_USER means an unauthenticated relay, not empty credentials");

  process.env.SMTP_PORT = "2525";
  process.env.SMTP_USER = "relay-login";
  process.env.SMTP_PASS = "secret";
  assert.equal(smtpOptions().port, 2525, "2525 is the documented escape hatch when 587 is blocked");
  assert.deepEqual(smtpOptions().auth, { user: "relay-login", pass: "secret" });
});

test("with no transport configured, the mailer reports that it does NOT deliver", () => {
  const described = describeTransport();

  assert.equal(described.mode, "json");
  assert.equal(described.delivers, false, "validateEnv keys the production hard-fail off this flag");
  assert.match(described.detail, /NEVER delivered/);
});

test("a consumer mailbox as MAIL_FROM is detected — relaying it fails DMARC alignment", () => {
  assert.equal(isFreemailSender("algorithemicedge@gmail.com"), true, "the address this deploy actually shipped with");
  assert.equal(isFreemailSender("Recruitment <someone@outlook.com>"), true);
  assert.equal(isFreemailSender("no-reply@yourcompany.com"), false);
  assert.equal(isFreemailSender(undefined), false);
});

test("sender parsing handles both the bare address and the display-name form", () => {
  assert.deepEqual(parseAddress("a@b.com"), { name: "", email: "a@b.com" });
  assert.deepEqual(parseAddress("Recruitment Team <a@b.com>"), { name: "Recruitment Team", email: "a@b.com" });
  assert.deepEqual(parseAddress('"Recruitment Team" <a@b.com>'), { name: "Recruitment Team", email: "a@b.com" });
  assert.deepEqual(parseAddressList("a@b.com, c@d.com").map((x) => x.email), ["a@b.com", "c@d.com"]);
  assert.deepEqual(parseAddressList(""), []);
});

test("the HTTP transport posts Brevo's documented payload with the key in the header", async () => {
  process.env.BREVO_API_KEY = "xkeysib-test";
  process.env.MAIL_FROM = "Recruitment <no-reply@company.test>";

  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 201, text: async () => JSON.stringify({ messageId: "<abc@brevo>" }) };
  };

  const info = await sendMail({
    to: "candidate@example.com",
    subject: "Reset your password",
    text: "plain body",
    html: "<p>html body</p>",
  });

  assert.equal(captured.url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["api-key"], "xkeysib-test");
  assert.ok(captured.init.signal, "the request must be abortable or a hung API call reinstates the stall");

  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body.sender, { name: "Recruitment", email: "no-reply@company.test" });
  assert.deepEqual(body.to, [{ email: "candidate@example.com" }]);
  assert.equal(body.subject, "Reset your password");
  assert.equal(body.textContent, "plain body");
  assert.equal(body.htmlContent, "<p>html body</p>");
  assert.equal(info.messageId, "<abc@brevo>");
});

test("a rejected API call surfaces Brevo's own message, not just the status code", async () => {
  process.env.BREVO_API_KEY = "xkeysib-test";
  process.env.MAIL_FROM = "no-reply@company.test";

  global.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ code: "invalid_parameter", message: "the sender you used is not valid" }),
  });

  // "sender is not valid" is the single most common production failure here and is
  // unrecoverable from a bare 400 — the operator would go looking at connectivity.
  await assert.rejects(
    () => sendMail({ to: "c@example.com", subject: "s", text: "t" }),
    /400.*sender you used is not valid/s
  );
});

test("a hung HTTP call is reported as a timeout rather than propagating an AbortError", async () => {
  process.env.BREVO_API_KEY = "xkeysib-test";
  process.env.MAIL_FROM = "no-reply@company.test";
  process.env.SMTP_TIMEOUT_MS = "50";

  global.fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });

  await assert.rejects(() => sendMail({ to: "c@example.com", subject: "s", text: "t" }), /timed out after 50ms/);
});
