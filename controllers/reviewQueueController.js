// Human review queue (BUILD-PLAN Phase 7.6): everything the pipeline is not
// confident about, with the reason and the evidence, resolved by one click —
// and every resolution is a LABELLED training signal for calibration
// (Phase 10): what the engine said, what the human decided.

const ReviewItem = require("../models/ReviewItem");
const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const { advanceAfterAtsPass } = require("../services/atsService");
const { applyTransition, emitStageUpdate } = require("../services/pipelineService");
const { appendStageHistory } = require("../utils/pipeline");

async function listQueue(req, res) {
  const status = req.query.status === "resolved" ? "resolved" : "open";
  const items = await ReviewItem.find({ company: req.user.company, status })
    .sort({ createdAt: -1 })
    .limit(200)
    .populate("candidate", "basicDetails status ats")
    .populate("job", "title")
    .populate("assessment", "overallScore band reviewReason qa thresholds");

  // An item whose candidate or job has since been deleted is not a decision
  // anyone can make — the subject is gone, and `resolveItem` below correctly
  // 404s on it. Serving it anyway put a ghost card in the queue: no name, no
  // score, and both buttons wired to an error toast, which is precisely the
  // "render a placeholder as if it were a measurement" failure the Honest
  // Reading Rule exists to prevent. Populate resolves a dangling ref to null,
  // and that null is the signal.
  //
  // This is defence, not the cure: the cure is that every delete path takes its
  // review items with it (candidatePurgeService for DPDP erasure + the
  // retention job, deleteJob for a removed role). The filter stays because rows
  // orphaned before those fixes are still in the collection, and because a
  // queue that shows a decision about nobody is worse than one that is short.
  const live = items.filter((item) => item.candidate && item.job);
  if (live.length !== items.length) {
    console.warn(
      `[reviewQueue] hid ${items.length - live.length} orphaned item(s) for company ${req.user.company} — candidate or job deleted`
    );
  }
  res.json(live);
}

async function resolveItem(req, res) {
  const { decision, note } = req.body || {};
  if (!["advance", "decline"].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'advance' or 'decline'" });
  }

  const item = await ReviewItem.findOne({ _id: req.params.id, company: req.user.company, status: "open" });
  if (!item) return res.status(404).json({ error: "Open review item not found" });

  const candidate = await Candidate.findOne({ _id: item.candidate, company: req.user.company }).populate("job", "title");
  const job = await Job.findOne({ _id: item.job, company: req.user.company });
  if (!candidate || !job) return res.status(404).json({ error: "Candidate or job no longer exists" });

  const actorName = req.user.name || req.user.email || "admin";

  if (decision === "advance") {
    // Exactly the machine-pass pathway (interview queue + magic-link session),
    // with the human actor recorded in the timeline.
    appendStageHistory(candidate, candidate.status, {
      note: note || "Advanced from the review queue",
      by: actorName,
    });
    await advanceAfterAtsPass(candidate, job, candidate.ats?.overallScore ?? item.label?.engineScore ?? 0);
    await candidate.save();
    // advanceAfterAtsPass mutates status directly (it's the machine-pass path,
    // reused here for a human "advance"), so it doesn't go through
    // applyTransition — fire the same realtime event by hand so any open
    // Hiring Pipeline / candidate profile tab reflects this decision live.
    emitStageUpdate(candidate);
  } else {
    // applyTransition validates, saves, and sends the standard rejection
    // notifications — a human decline is an ordinary pipeline decision.
    await applyTransition(candidate, "rejected", { note: note || "Declined from the review queue", actorName });
  }

  item.status = "resolved";
  item.resolution = { decision, note: note || "", by: req.user._id, at: new Date() };
  item.label = { ...(item.label?.toObject?.() || item.label || {}), humanDecision: decision };
  await item.save();

  req.audit = {
    action: `review_queue.${decision}`,
    resource: "candidate",
    resourceId: String(candidate._id),
    meta: { reviewItemId: String(item._id), reasons: item.reasons, note: note || "" },
  };

  res.json({ ok: true, item });
}

module.exports = { listQueue, resolveItem };
