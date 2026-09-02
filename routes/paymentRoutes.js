const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  createOrder,
  verifyPayment,
  retryPayment,
  cancelPayment,
  paymentHistory,
  getInvoice,
} = require("../controllers/paymentController");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
const requireAdmin = [requireAuth, requireRole("admin")];

// NOTE: POST /webhook is intentionally NOT defined here — it's mounted
// directly in server.js with a raw-body parser, ahead of the global
// express.json() middleware, because Razorpay's webhook signature must be
// verified against the exact raw request bytes.

router.post("/create-order", requireAdmin, createOrder);
router.post("/verify", requireAdmin, verifyPayment);
router.post("/:paymentId/retry", requireAdmin, retryPayment);
router.post("/:paymentId/cancel", requireAdmin, cancelPayment);
router.get("/history", requireAdmin, paymentHistory);
router.get("/invoices/:id", requireAdmin, getInvoice);

module.exports = wrapRouter(router);
