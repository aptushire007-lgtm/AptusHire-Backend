const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { createLimiter } = require("../middleware/rateLimit");
const { createDemoRequest } = require("../controllers/demoRequestController");

const router = express.Router();

// Public lead-capture endpoint — rate-limited per IP so it can't be used to
// spam the leads collection or the sales inbox.
const demoLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  prefix: "rl:demo:",
  message: "Too many demo requests from this address — please try again later.",
});

router.post("/", demoLimiter, createDemoRequest);

module.exports = wrapRouter(router);
