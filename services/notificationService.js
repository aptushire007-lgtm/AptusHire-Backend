const Notification = require("../models/Notification");
const AdminNotification = require("../models/AdminNotification");
const NotificationPreference = require("../models/NotificationPreference");
const User = require("../models/User");
const { emitToCompany, emitToCandidateUser } = require("../config/socket");
const { dispatchEmail } = require("./emailDispatchService");
const templates = require("../utils/emailTemplates");

async function getPreference(userId) {
  if (!userId) return null;
  return NotificationPreference.findOne({ user: userId });
}

function emailAllowed(pref, type) {
  if (!pref) return true;
  if (!pref.emailEnabled) return false;
  return !pref.mutedTypes.includes(type);
}

function inAppAllowed(pref) {
  return !pref || pref.inAppEnabled;
}

async function sendTemplatedEmail({ to, template, args, type, relatedType, relatedId }) {
  const built = templates[template](...args);
  return dispatchEmail({
    to,
    subject: built.subject,
    text: built.text,
    html: built.html,
    category: type,
    relatedType,
    relatedId,
  });
}

// candidateId: the anonymous Candidate application document (always present
// once someone has applied). userId: the logged-in User account, only present
// once/if that candidate has registered for the dashboard — real-time socket
// delivery is only possible for the latter, since anonymous applicants have
// no active session to push to.
async function notifyCandidate({ candidateId, userId, type, title, message, meta, email }) {
  const pref = await getPreference(userId);
  let doc = null;

  if (inAppAllowed(pref)) {
    doc = await Notification.create({ candidate: candidateId, user: userId, type, title, message, meta });
    if (userId) emitToCandidateUser(userId, "notification:new", doc);
  }

  if (email && emailAllowed(pref, type)) {
    await sendTemplatedEmail({
      to: email.to,
      template: email.template,
      args: email.args,
      type,
      relatedType: "Candidate",
      relatedId: candidateId || userId,
    });
  }

  return doc;
}

async function notifyAdmin({ companyId, type, title, message, meta, email }) {
  const doc = await AdminNotification.create({ company: companyId, type, title, message, meta });
  emitToCompany(companyId, "notification:new", doc);

  if (email) {
    const admins = await User.find({ company: companyId, role: "admin" });
    for (const admin of admins) {
      const pref = await getPreference(admin._id);
      if (!emailAllowed(pref, type)) continue;
      await sendTemplatedEmail({
        to: admin.email,
        template: email.template,
        args: email.args(admin),
        type,
        relatedType: "Company",
        relatedId: companyId,
      });
    }
  }

  return doc;
}

module.exports = { notifyCandidate, notifyAdmin };
