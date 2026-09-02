// Admin round-scorecard routes. Mounted behind SCORECARD_ENGINE_ENABLED in
// server.js — with the flag off, none of these paths exist and the platform
// behaves exactly as it did before.

const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  create,
  listForCandidate,
  getOne,
  resend,
  cancel,
  ledger,
  options,
} = require("../controllers/scorecardController");
const { requireAuth, requireRole, requireActiveCompany } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth, requireRole("admin"), requireActiveCompany);

router.get("/options", options);
router.post("/", create);
router.get("/candidate/:candidateId", listForCandidate);
router.get("/candidate/:candidateId/ledger", ledger);
router.get("/:id", getOne);
router.post("/:id/resend", resend);
router.post("/:id/cancel", cancel);

module.exports = wrapRouter(router);
