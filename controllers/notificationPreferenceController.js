const NotificationPreference = require("../models/NotificationPreference");

async function getMine(req, res) {
  const pref = await NotificationPreference.findOneAndUpdate(
    { user: req.user._id },
    { user: req.user._id },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.json(pref);
}

async function updateMine(req, res) {
  const { emailEnabled, inAppEnabled, mutedTypes } = req.body;
  const update = {};
  if (typeof emailEnabled === "boolean") update.emailEnabled = emailEnabled;
  if (typeof inAppEnabled === "boolean") update.inAppEnabled = inAppEnabled;
  if (Array.isArray(mutedTypes)) update.mutedTypes = mutedTypes;

  const pref = await NotificationPreference.findOneAndUpdate(
    { user: req.user._id },
    { user: req.user._id, ...update },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.json(pref);
}

module.exports = { getMine, updateMine };
