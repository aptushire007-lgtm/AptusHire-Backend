const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { compileForJob, getForJob, getRubric, getRubricInsights, updateRubric, approveRubric, deleteRubric } = require("../controllers/rubricController");
const { requireAuth, requireRole, requireActiveCompany } = require("../middleware/auth");

const router = express.Router();
const requireAdmin = [requireAuth, requireRole("admin"), requireActiveCompany];

router.post("/job/:jobId/compile", requireAdmin, compileForJob);
router.get("/job/:jobId", requireAdmin, getForJob);
router.get("/:id", requireAdmin, getRubric);
router.get("/:id/insights", requireAdmin, getRubricInsights);
router.patch("/:id", requireAdmin, updateRubric);
router.post("/:id/approve", requireAdmin, approveRubric);
router.delete("/:id", requireAdmin, deleteRubric);

module.exports = wrapRouter(router);
