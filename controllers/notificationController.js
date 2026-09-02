const Notification = require("../models/Notification");
const Candidate = require("../models/Candidate");

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A logged-in candidate's notifications are split across two references:
// `user` (dashboard-level events like "welcome") and `candidate` (per-application
// events like ATS results), because a candidate can apply to jobs under the
// same email before ever registering an account. This mirrors the lookup
// already used in candidateDashboardController.getDashboard().
async function ownedCandidateIds(user) {
  const applications = await Candidate.find({ "basicDetails.email": user.email }).select("_id");
  return applications.map((a) => a._id);
}

function ownershipFilter(user, candidateIds) {
  return { $or: [{ candidate: { $in: candidateIds } }, { user: user._id }] };
}

async function listMine(req, res) {
  const { page = 1, limit = 20, type, read, search } = req.query;
  const candidateIds = await ownedCandidateIds(req.user);

  const and = [ownershipFilter(req.user, candidateIds)];
  if (type) and.push({ type });
  if (read === "true") and.push({ read: true });
  if (read === "false") and.push({ read: false });
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    and.push({ $or: [{ title: pattern }, { message: pattern }] });
  }
  const filter = { $and: and };

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(100, Math.max(1, Number(limit)));

  const [notifications, total] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Notification.countDocuments(filter),
  ]);

  res.json({ notifications, total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 });
}

async function unreadCount(req, res) {
  const candidateIds = await ownedCandidateIds(req.user);
  const count = await Notification.countDocuments({ ...ownershipFilter(req.user, candidateIds), read: false });
  res.json({ count });
}

async function markRead(req, res) {
  const candidateIds = await ownedCandidateIds(req.user);
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, ...ownershipFilter(req.user, candidateIds) },
    { read: true },
    { new: true }
  );
  if (!notification) return res.status(404).json({ error: "Notification not found" });
  res.json(notification);
}

async function markAllRead(req, res) {
  const candidateIds = await ownedCandidateIds(req.user);
  await Notification.updateMany({ ...ownershipFilter(req.user, candidateIds), read: false }, { read: true });
  res.json({ message: "All notifications marked as read" });
}

async function remove(req, res) {
  const candidateIds = await ownedCandidateIds(req.user);
  const notification = await Notification.findOneAndDelete({ _id: req.params.id, ...ownershipFilter(req.user, candidateIds) });
  if (!notification) return res.status(404).json({ error: "Notification not found" });
  res.json({ message: "Notification deleted" });
}

module.exports = { listMine, unreadCount, markRead, markAllRead, remove };
