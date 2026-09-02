const crypto = require("crypto");
const Razorpay = require("razorpay");

function isConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function getClient() {
  if (!isConfigured()) return null;
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

async function createOrder({ amount, currency, receipt, notes }) {
  const client = getClient();
  if (!client) {
    const err = new Error("Payments are not configured yet. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
    err.status = 503;
    throw err;
  }
  return client.orders.create({ amount, currency, receipt, notes, payment_capture: 1 });
}

// Constant-time comparison of two hex HMAC digests. A plain `===` short-circuits
// on the first differing byte, leaking a timing side-channel on these
// security-critical checks. crypto.timingSafeEqual throws on length mismatch, so
// guard on length first; the try/catch makes a malformed client-supplied
// signature return false instead of crashing the verification path.
function safeEqualHex(expectedHex, actualHex) {
  try {
    const expected = Buffer.from(expectedHex, "hex");
    const actual = Buffer.from(String(actualHex || ""), "hex");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!process.env.RAZORPAY_KEY_SECRET) return false;
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return safeEqualHex(expected, signature);
}

function verifyWebhookSignature({ rawBody, signature }) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  return safeEqualHex(expected, signature);
}

module.exports = { isConfigured, getClient, createOrder, verifyPaymentSignature, verifyWebhookSignature };
