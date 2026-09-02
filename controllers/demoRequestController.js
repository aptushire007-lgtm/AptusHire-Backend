const DemoRequest = require("../models/DemoRequest");
const { dispatchEmail } = require("../services/emailDispatchService");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/demo-requests — public. Persists the lead first (the durable part),
// then best-effort notifies sales by email. The mailto: flow this replaces lost
// the lead entirely whenever the visitor had no configured mail client.
async function createDemoRequest(req, res) {
  const { companyName, email, phone, companySize, message } = req.body || {};

  if (!companyName || String(companyName).trim().length < 2) {
    return res.status(400).json({ error: "companyName is required" });
  }
  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ error: "A valid email is required" });
  }

  const lead = await DemoRequest.create({
    companyName,
    email,
    phone,
    companySize,
    message,
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });

  const salesTo = process.env.SALES_NOTIFY_EMAIL;
  if (salesTo) {
    const text = [
      `New demo request #${lead._id}`,
      `Company: ${lead.companyName}`,
      `Email: ${lead.email}`,
      `Phone: ${lead.phone || "-"}`,
      `Company size: ${lead.companySize || "-"}`,
      "",
      `Message:`,
      lead.message || "-",
    ].join("\n");
    // Best-effort: a sales-inbox failure must never fail the lead capture.
    dispatchEmail({
      to: salesTo,
      subject: `Demo request from ${lead.companyName}`,
      text,
      category: "demo_request",
      relatedType: "DemoRequest",
      relatedId: lead._id,
    }).catch(() => {});
  }

  res.status(201).json({ message: "Demo request received", id: lead._id });
}

module.exports = { createDemoRequest };
