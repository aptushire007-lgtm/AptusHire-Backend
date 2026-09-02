const InterviewQueue = require("../models/InterviewQueue");

async function listQueue(req, res) {
  const filter = { status: "queued", company: req.user.company };
  if (req.query.job) filter.job = req.query.job;

  const entries = await InterviewQueue.find(filter)
    .populate("candidate", "basicDetails ats status")
    .populate("job", "title department")
    .sort({ atsScore: -1, createdAt: 1 });

  res.json(entries);
}

async function updateQueueEntry(req, res) {
  const { status } = req.body;
  if (!["queued", "removed"].includes(status)) {
    return res.status(400).json({ error: "status must be 'queued' or 'removed'" });
  }
  const entry = await InterviewQueue.findOneAndUpdate(
    { _id: req.params.id, company: req.user.company },
    { status },
    { new: true }
  );
  if (!entry) return res.status(404).json({ error: "Queue entry not found" });
  res.json(entry);
}

module.exports = { listQueue, updateQueueEntry };
