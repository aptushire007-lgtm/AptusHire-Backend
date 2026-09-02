const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { listMine, unreadCount, markRead, markAllRead, remove } = require("../controllers/notificationController");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
const requireCandidate = [requireAuth, requireRole("candidate")];

router.get("/", requireCandidate, listMine);
router.get("/unread-count", requireCandidate, unreadCount);
router.patch("/read-all", requireCandidate, markAllRead);
router.patch("/:id/read", requireCandidate, markRead);
router.delete("/:id", requireCandidate, remove);

module.exports = wrapRouter(router);
