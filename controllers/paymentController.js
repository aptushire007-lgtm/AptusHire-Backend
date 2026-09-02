const crypto = require("crypto");
const Company = require("../models/Company");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const Payment = require("../models/Payment");
const Invoice = require("../models/Invoice");
const razorpayService = require("../services/razorpayService");
const { provisionWorkspace } = require("../services/workspaceProvisioningService");
const { notifyAdmin } = require("../services/notificationService");

function generateInvoiceNumber() {
  return `INV-${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

async function issueInvoiceAndProvision(payment) {
  const existingInvoice = await Invoice.findOne({ payment: payment._id });
  if (existingInvoice) return existingInvoice;

  const company = await Company.findById(payment.company);
  const plan = await SubscriptionPlan.findById(payment.subscriptionPlan);

  const invoice = await Invoice.create({
    company: company._id,
    payment: payment._id,
    invoiceNumber: generateInvoiceNumber(),
    amount: payment.amount,
    currency: payment.currency,
    billingCycle: payment.billingCycle,
    planName: plan.name,
  });

  await notifyAdmin({
    companyId: company._id,
    type: "payment_success",
    title: "Payment successful",
    message: `We've received your payment of ${payment.currency} ${payment.amount} for the ${payment.billingCycle} plan.`,
    email: { template: "paymentSuccessEmailTemplate", args: (admin) => [company, admin, payment] },
  });

  await notifyAdmin({
    companyId: company._id,
    type: "invoice_generated",
    title: `Invoice ${invoice.invoiceNumber} generated`,
    message: `Your invoice for the ${payment.billingCycle} plan is ready.`,
    meta: { invoiceId: invoice._id },
    email: { template: "invoiceEmailTemplate", args: (admin) => [company, admin, invoice] },
  });

  await provisionWorkspace({ company, plan, billingCycle: payment.billingCycle });

  return invoice;
}

async function createOrder(req, res) {
  const { planKey, billingCycle } = req.body;
  if (!planKey || !["monthly", "yearly"].includes(billingCycle)) {
    return res.status(400).json({ error: "planKey and billingCycle ('monthly' or 'yearly') are required" });
  }
  if (!req.user.company) {
    return res.status(400).json({ error: "This account is not associated with a company" });
  }

  const plan = await SubscriptionPlan.findOne({ key: planKey, isActive: true });
  if (!plan) return res.status(404).json({ error: "Subscription plan not found" });

  const company = await Company.findById(req.user.company);
  if (!company) return res.status(404).json({ error: "Company not found" });

  const amountMajorUnit = plan.pricing[billingCycle];
  const amountMinorUnit = Math.round(amountMajorUnit * 100);

  let order;
  try {
    order = await razorpayService.createOrder({
      amount: amountMinorUnit,
      currency: "INR",
      receipt: `company_${company._id}_${Date.now()}`,
      notes: { companyId: String(company._id), planKey, billingCycle },
    });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }

  const payment = await Payment.create({
    company: company._id,
    subscriptionPlan: plan._id,
    billingCycle,
    amount: amountMajorUnit,
    currency: "INR",
    razorpayOrderId: order.id,
    status: "created",
  });

  res.status(201).json({
    paymentId: payment._id,
    orderId: order.id,
    amount: amountMinorUnit,
    currency: "INR",
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
    razorpayConfigured: razorpayService.isConfigured(),
  });
}

async function verifyPayment(req, res) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "razorpay_order_id, razorpay_payment_id, and razorpay_signature are required" });
  }

  const payment = await Payment.findOne({ razorpayOrderId: razorpay_order_id });
  if (!payment) return res.status(404).json({ error: "Payment record not found" });

  const valid = razorpayService.verifyPaymentSignature({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  });

  if (!valid) {
    payment.status = "failed";
    payment.failureReason = "Signature verification failed";
    await payment.save();
    return res.status(400).json({ error: "Payment verification failed" });
  }

  payment.status = "paid";
  payment.razorpayPaymentId = razorpay_payment_id;
  payment.razorpaySignature = razorpay_signature;
  await payment.save();

  const invoice = await issueInvoiceAndProvision(payment);

  res.json({ message: "Payment verified and workspace activated", payment, invoice });
}

async function webhook(req, res) {
  const signature = req.headers["x-razorpay-signature"];
  const valid = razorpayService.verifyWebhookSignature({ rawBody: req.rawBody, signature });
  if (!valid) {
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  const event = req.body.event;
  const paymentEntity = req.body.payload?.payment?.entity;
  if (!paymentEntity) return res.status(200).json({ received: true });

  const payment = await Payment.findOne({ razorpayOrderId: paymentEntity.order_id });
  if (!payment) return res.status(200).json({ received: true });

  if (event === "payment.captured" && payment.status !== "paid") {
    payment.status = "paid";
    payment.razorpayPaymentId = paymentEntity.id;
    await payment.save();
    await issueInvoiceAndProvision(payment);
  } else if (event === "payment.failed" && payment.status === "created") {
    payment.status = "failed";
    payment.failureReason = paymentEntity.error_description || "Payment failed";
    await payment.save();

    const company = await Company.findById(payment.company);
    await notifyAdmin({
      companyId: payment.company,
      type: "payment_failed",
      title: "Payment failed",
      message: `Your payment attempt for the ${payment.billingCycle} plan failed: ${payment.failureReason}`,
      email: { template: "paymentFailedEmailTemplate", args: (admin) => [company, admin, payment] },
    });
  }

  res.status(200).json({ received: true });
}

async function retryPayment(req, res) {
  const { paymentId } = req.params;
  const previous = await Payment.findById(paymentId);
  // Return 404 (not 403) on a foreign id so the endpoint isn't an existence oracle.
  // tenantScope already restricts this findById to the caller's company.
  if (!previous || String(previous.company) !== String(req.user.company)) {
    return res.status(404).json({ error: "Payment not found" });
  }
  if (previous.status !== "failed" && previous.status !== "cancelled") {
    return res.status(400).json({ error: "Only failed or cancelled payments can be retried" });
  }

  const plan = await SubscriptionPlan.findById(previous.subscriptionPlan);
  const amountMinorUnit = Math.round(previous.amount * 100);

  let order;
  try {
    order = await razorpayService.createOrder({
      amount: amountMinorUnit,
      currency: previous.currency,
      receipt: `retry_${previous._id}_${Date.now()}`,
      notes: { companyId: String(previous.company), planKey: plan.key, billingCycle: previous.billingCycle },
    });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }

  const payment = await Payment.create({
    company: previous.company,
    subscriptionPlan: previous.subscriptionPlan,
    billingCycle: previous.billingCycle,
    amount: previous.amount,
    currency: previous.currency,
    razorpayOrderId: order.id,
    status: "created",
  });

  res.status(201).json({
    paymentId: payment._id,
    orderId: order.id,
    amount: amountMinorUnit,
    currency: payment.currency,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || null,
    razorpayConfigured: razorpayService.isConfigured(),
  });
}

async function cancelPayment(req, res) {
  const { paymentId } = req.params;
  const payment = await Payment.findById(paymentId);
  if (!payment || String(payment.company) !== String(req.user.company)) {
    return res.status(404).json({ error: "Payment not found" });
  }
  if (payment.status !== "created") {
    return res.status(400).json({ error: "Only a payment awaiting completion can be cancelled" });
  }

  payment.status = "cancelled";
  await payment.save();
  res.json({ message: "Payment cancelled", payment });
}

async function paymentHistory(req, res) {
  const payments = await Payment.find({ company: req.user.company }).sort({ createdAt: -1 }).populate("subscriptionPlan", "name key");
  res.json(payments);
}

async function getInvoice(req, res) {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice || String(invoice.company) !== String(req.user.company)) {
    return res.status(404).json({ error: "Invoice not found" });
  }
  res.json(invoice);
}

module.exports = { createOrder, verifyPayment, webhook, retryPayment, cancelPayment, paymentHistory, getInvoice };
