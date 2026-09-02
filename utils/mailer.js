const nodemailer = require("nodemailer");
const logger = require("./logger");
const {
  rejectionEmailTemplate,
  interviewInvitationEmailTemplate,
  verificationEmailTemplate,
  passwordResetEmailTemplate,
  otpEmailTemplate,
  workspaceReadyEmailTemplate,
} = require("./emailTemplates");

const BREVO_API_BASE = "https://api.brevo.com/v3";

// Nodemailer's own defaults are ~2 minutes per phase. On a host that silently drops
// outbound SMTP (Render blackholes the connection rather than refusing it) that turns
// every send into a 2-minute hang, and with BullMQ's 3 attempts a single dead email
// occupies a worker for ~6 minutes. Failing fast is what makes the retry/alert path
// useful instead of theoretical.
const DEFAULT_TIMEOUT_MS = 15000;

// Sending "from" a consumer mailbox through a third-party relay fails SPF/DMARC
// alignment for that domain. Brevo accepts the API call and the receiving side then
// junks or rejects it, so it looks like a delivery mystery rather than a config error.
const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "aol.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "rediffmail.com",
]);

function timeoutMs() {
  return Number(process.env.SMTP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
}

// Accepts "Name <a@b.com>", "a@b.com", or nodemailer's {name, address} object.
function parseAddress(value) {
  if (!value) return null;
  if (typeof value === "object") {
    const email = value.address || value.email || "";
    return email ? { name: value.name || "", email: email.trim() } : null;
  }
  const str = String(value).trim();
  const angle = str.match(/^(.*?)\s*<([^>]+)>$/);
  if (angle) return { name: angle[1].trim().replace(/^"|"$/g, ""), email: angle[2].trim() };
  return str ? { name: "", email: str } : null;
}

// Comma-splitting would mangle a quoted display name containing a comma. Nothing in
// this codebase sends to a display-name list — every `to` is a bare address — so the
// simple split is correct here and documented rather than over-engineered.
function parseAddressList(value) {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : String(value).split(",");
  return parts.map(parseAddress).filter((a) => a && a.email);
}

function isFreemailSender(address) {
  const parsed = parseAddress(address);
  if (!parsed) return false;
  const domain = parsed.email.split("@")[1];
  return !!domain && FREEMAIL_DOMAINS.has(domain.toLowerCase());
}

// Transport selection, highest priority first:
//   1. BREVO_API_KEY — HTTPS to api.brevo.com. Chosen first because it is immune to the
//      outbound SMTP port blocking that container platforms apply, which is the failure
//      that took down every password-reset email on the Render deploy.
//   2. SMTP_HOST     — classic relay, now with explicit timeouts.
//   3. neither       — jsonTransport: composed, logged, NEVER delivered (dev only).
function resolveMode() {
  if (process.env.BREVO_API_KEY) return "brevo-api";
  if (process.env.SMTP_HOST) return "smtp";
  return "json";
}

function createBrevoApiTransport() {
  return {
    name: "brevo-api",
    version: "1.0.0",
    send(mail, callback) {
      const data = mail.data || {};
      const sender = parseAddress(data.from);
      const to = parseAddressList(data.to);

      if (!sender) return callback(new Error("Brevo API: no sender address (set MAIL_FROM)"));
      if (!to.length) return callback(new Error("Brevo API: no recipient address"));

      const payload = {
        sender: sender.name ? { name: sender.name, email: sender.email } : { email: sender.email },
        to: to.map((a) => (a.name ? { name: a.name, email: a.email } : { email: a.email })),
        subject: data.subject,
      };
      if (data.html) payload.htmlContent = data.html;
      if (data.text) payload.textContent = data.text;

      const ms = timeoutMs();
      fetch(`${BREVO_API_BASE}/smtp/email`, {
        method: "POST",
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(ms),
      })
        .then(async (res) => {
          const body = await res.text();
          if (!res.ok) {
            // Brevo's body carries the actionable part ("sender ... is not valid",
            // "unauthorized"). A bare status code sends you looking in the wrong place.
            throw new Error(`Brevo API ${res.status}: ${body.slice(0, 300)}`);
          }
          let messageId = "";
          try {
            messageId = JSON.parse(body).messageId || "";
          } catch {
            /* Brevo returned a non-JSON 2xx; the send still succeeded. */
          }
          const addresses = payload.to.map((t) => t.email);
          callback(null, {
            messageId,
            envelope: { from: sender.email, to: addresses },
            accepted: addresses,
            rejected: [],
            response: body.slice(0, 300),
          });
        })
        .catch((err) => {
          if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
            return callback(new Error(`Brevo API request timed out after ${ms}ms`));
          }
          callback(err instanceof Error ? err : new Error(String(err)));
        });
    },
  };
}

function smtpOptions() {
  const ms = timeoutMs();
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    // All three matter: a blackholed port hangs at connect, a silent relay hangs at
    // greeting, and a half-open socket hangs mid-DATA. Leaving any of them on the
    // nodemailer default reinstates the multi-minute stall.
    connectionTimeout: ms,
    greetingTimeout: ms,
    socketTimeout: ms,
  };
}

// Keyed on the resolved config, not just the mode, so changing a var rebuilds the
// transport instead of being pinned to whatever the first call happened to see.
let cached = null;

function configSignature(mode) {
  if (mode === "brevo-api") return `brevo-api:${timeoutMs()}`;
  if (mode === "smtp") {
    const o = smtpOptions();
    return `smtp:${o.host}:${o.port}:${o.secure}:${o.auth ? o.auth.user : "noauth"}:${o.connectionTimeout}`;
  }
  return "json";
}

function getTransporter() {
  const mode = resolveMode();
  const signature = configSignature(mode);
  if (cached && cached.signature === signature) return cached.transporter;

  let transporter;
  if (mode === "brevo-api") {
    transporter = nodemailer.createTransport(createBrevoApiTransport());
  } else if (mode === "smtp") {
    transporter = nodemailer.createTransport(smtpOptions());
  } else {
    // No transport configured (dev/local): compose end-to-end without credentials
    // and without sending anything.
    transporter = nodemailer.createTransport({ jsonTransport: true });
  }

  cached = { signature, transporter };
  return transporter;
}

function describeTransport() {
  const mode = resolveMode();
  if (mode === "brevo-api") {
    return { mode, delivers: true, detail: `Brevo HTTP API (${BREVO_API_BASE}) timeout=${timeoutMs()}ms` };
  }
  if (mode === "smtp") {
    const port = Number(process.env.SMTP_PORT) || 587;
    return {
      mode,
      delivers: true,
      detail:
        `SMTP ${process.env.SMTP_HOST}:${port} secure=${process.env.SMTP_SECURE === "true"} ` +
        `auth=${process.env.SMTP_USER || "none"} timeout=${timeoutMs()}ms`,
    };
  }
  return { mode, delivers: false, detail: "nodemailer jsonTransport — mail is composed and logged but NEVER delivered" };
}

// Proves the configured transport can actually reach the provider from THIS host, which
// is the whole diagnosis for "the code is fine but nothing arrives": run it locally and
// on the deploy, and compare.
async function verifyTransport() {
  const mode = resolveMode();
  const described = describeTransport();

  if (mode === "brevo-api") {
    const ms = timeoutMs();
    let res;
    try {
      res = await fetch(`${BREVO_API_BASE}/account`, {
        headers: { "api-key": process.env.BREVO_API_KEY, accept: "application/json" },
        signal: AbortSignal.timeout(ms),
      });
    } catch (err) {
      const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new Error(timedOut ? `Brevo API unreachable (timed out after ${ms}ms)` : `Brevo API unreachable: ${err.message}`);
    }
    const body = await res.text();
    if (!res.ok) throw new Error(`Brevo API key rejected (${res.status}): ${body.slice(0, 200)}`);
    let account = "";
    try {
      const parsed = JSON.parse(body);
      account = parsed.email || parsed.companyName || "";
    } catch {
      /* account details are cosmetic */
    }
    return { ...described, ok: true, account };
  }

  if (mode === "smtp") {
    await getTransporter().verify();
    return { ...described, ok: true };
  }

  return { ...described, ok: false };
}

async function sendMail({ to, subject, text, html }) {
  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || "no-reply@recruitment.local",
    to,
    subject,
    text,
    html,
  });

  if (resolveMode() === "json") {
    // Dev fallback: nothing was actually sent — but the caller (and EmailLog) will record
    // it as sent. Printing the full body is deliberate and is how you retrieve a
    // verification link or OTP locally, the same way Laravel's "log" mail driver or
    // Rails' letter_opener work.
    //
    // The bodies of the verification / password-reset / OTP mails contain live
    // credentials, so this must never run in production. validateEnv hard-fails a
    // production boot with no transport configured; this second guard means that even if
    // that check is bypassed, the secret is not written to a production log aggregator.
    const line = `[mailer] no mail transport configured — NOT SENT. to=${to} subject="${subject}"`;
    if (process.env.NODE_ENV === "production") {
      logger.error(`${line} (body withheld in production)`);
    } else {
      logger.warn(`${line}\n${text}`);
    }
  }

  return info;
}

async function sendRejectionEmail(candidate, job) {
  const { subject, text, html } = rejectionEmailTemplate(candidate, job);
  return sendMail({ to: candidate.basicDetails.email, subject, text, html });
}

async function sendInterviewInvitationEmail(candidate, job, session) {
  const { subject, text, html } = interviewInvitationEmailTemplate(candidate, job, session);
  return sendMail({ to: candidate.basicDetails.email, subject, text, html });
}

async function sendVerificationEmail(user, verifyUrl) {
  const { subject, text, html } = verificationEmailTemplate(user, verifyUrl);
  return sendMail({ to: user.email, subject, text, html });
}

async function sendPasswordResetEmail(user, resetUrl) {
  const { subject, text, html } = passwordResetEmailTemplate(user, resetUrl);
  return sendMail({ to: user.email, subject, text, html });
}

async function sendOtpEmail(email, companyName, otp) {
  const { subject, text, html } = otpEmailTemplate(companyName, otp);
  return sendMail({ to: email, subject, text, html });
}

async function sendWorkspaceReadyEmail(email, company, adminName) {
  const { subject, text, html } = workspaceReadyEmailTemplate(company, adminName);
  return sendMail({ to: email, subject, text, html });
}

module.exports = {
  sendMail,
  sendRejectionEmail,
  sendInterviewInvitationEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendOtpEmail,
  sendWorkspaceReadyEmail,
  // Diagnostics / config surface — used by validateEnv, scripts/checkMail.js and tests.
  resolveMode,
  smtpOptions,
  describeTransport,
  verifyTransport,
  isFreemailSender,
  parseAddress,
  parseAddressList,
};
