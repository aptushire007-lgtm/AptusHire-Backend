const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const rateLimit = require("express-rate-limit");
const { register, resendOtp, verifyOtp } = require("../controllers/companyAuthController");

const router = express.Router();

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

router.post("/register", otpLimiter, register);
router.post("/resend-otp", otpLimiter, resendOtp);
router.post("/verify-otp", otpLimiter, verifyOtp);

module.exports = wrapRouter(router);
