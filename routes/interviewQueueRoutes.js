const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { listQueue, updateQueueEntry } = require("../controllers/interviewQueueController");
const { requireAuth, requireRole, requireActiveCompany } = require("../middleware/auth");

const router = express.Router();
const requireAdmin = [requireAuth, requireRole("admin"), requireActiveCompany];

router.get("/", requireAdmin, listQueue);
router.patch("/:id", requireAdmin, updateQueueEntry);

module.exports = wrapRouter(router);
