const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { listMine, listTypes, unreadCount, markRead, markAllRead, remove } = require("../controllers/adminNotificationController");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
const requireAdmin = [requireAuth, requireRole("admin")];

router.get("/", requireAdmin, listMine);
router.get("/types", requireAdmin, listTypes);
router.get("/unread-count", requireAdmin, unreadCount);
router.patch("/read-all", requireAdmin, markAllRead);
router.patch("/:id/read", requireAdmin, markRead);
router.delete("/:id", requireAdmin, remove);

module.exports = wrapRouter(router);
