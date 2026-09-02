// Zero-dependency structured logger (Wave 6 / observability). Emits one JSON object per
// line so a log shipper (Loki / CloudWatch / ELK) can parse it without a custom grok rule.
// Levels are gated by LOG_LEVEL (default "info"); set LOG_PRETTY=true for human-readable
// dev output. Bind request context with logger.child({ reqId, company }).
//
// Deliberately not pino: the pilot runs on a single VPS and avoiding pino's worker-thread
// transport sidesteps a class of Windows/dev headaches. Swap for pino at nationwide scale.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] || LEVELS.info;
const PRETTY = process.env.LOG_PRETTY === "true";

// Field names whose values must never reach the logs, regardless of nesting.
const REDACT = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "token",
  "refreshtoken",
  "accesstoken",
  "authorization",
  "otp",
  "otphash",
  "tokenhash",
  "verificationtokenhash",
  "secret",
  "razorpaysignature",
]);

function redact(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT.has(k.toLowerCase()) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

// Accepts (msg, fields), (fields, msg), (fields), or (Error) — pino-ish ergonomics.
function normalize(a, b) {
  let msg;
  let fields;
  if (a instanceof Error) {
    msg = b || a.message;
    fields = { err: { name: a.name, message: a.message, stack: a.stack } };
  } else if (typeof a === "string") {
    msg = a;
    fields = b;
  } else {
    fields = a;
    msg = b;
  }
  return { msg, fields };
}

function emit(level, bindings, a, b) {
  if (LEVELS[level] < THRESHOLD) return;
  const { msg, fields } = normalize(a, b);
  const rec = { level, time: new Date().toISOString(), ...bindings };
  if (fields) Object.assign(rec, redact(fields));
  if (msg) rec.msg = msg;
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  if (PRETTY) {
    const extra = fields ? " " + JSON.stringify(redact(fields)) : "";
    out.write(`${rec.time} ${level.toUpperCase().padEnd(5)} ${msg || ""}${extra}\n`);
  } else {
    out.write(JSON.stringify(rec) + "\n");
  }
}

function make(bindings) {
  return {
    child: (extra) => make({ ...bindings, ...extra }),
    debug: (a, b) => emit("debug", bindings, a, b),
    info: (a, b) => emit("info", bindings, a, b),
    warn: (a, b) => emit("warn", bindings, a, b),
    error: (a, b) => emit("error", bindings, a, b),
  };
}

module.exports = make({});
