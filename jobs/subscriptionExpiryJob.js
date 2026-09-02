const { schedule, cronTimezone } = require("../utils/cronSchedule");
const Subscription = require("../models/Subscription");
const Company = require("../models/Company");
const tenantContext = require("../utils/tenantContext");
const { notifyAdmin } = require("../services/notificationService");

const REMINDER_WINDOW_DAYS = Number(process.env.SUBSCRIPTION_EXPIRY_REMINDER_DAYS) || 7;
const RESEND_COOLDOWN_MS = 24 * 60 * 60 * 1000;

async function sendDueReminders() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const cooldownThreshold = new Date(now.getTime() - RESEND_COOLDOWN_MS);

  const subscriptions = await Subscription.find({
    status: "active",
    currentPeriodEnd: { $gte: now, $lte: windowEnd },
    $or: [{ expiryReminderSentAt: null }, { expiryReminderSentAt: { $lt: cooldownThreshold } }],
  }).select("_id");

  for (const { _id } of subscriptions) {
    // Atomic claim-before-send (same reasoning as the interview reminder job): stamping
    // expiryReminderSentAt inside the filter guard means only one worker sends.
    const subscription = await Subscription.findOneAndUpdate(
      {
        _id,
        $or: [{ expiryReminderSentAt: null }, { expiryReminderSentAt: { $lt: cooldownThreshold } }],
      },
      { $set: { expiryReminderSentAt: now } },
      { new: true }
    ).populate("plan");
    if (!subscription) continue; // another worker already claimed it

    const company = await Company.findById(subscription.company);
    if (!company) continue;

    try {
      await notifyAdmin({
        companyId: company._id,
        type: "subscription_renewal",
        title: "Subscription expiring soon",
        message: `Your ${company.name} subscription expires on ${subscription.currentPeriodEnd.toLocaleDateString("en-US")}.`,
        meta: { subscriptionId: subscription._id },
        email: {
          template: "subscriptionExpiryReminderEmailTemplate",
          args: (admin) => [company, admin, subscription],
        },
      });
    } catch (err) {
      console.error("[subscriptionExpiryJob] failed to notify admin:", err.message);
      // Release the claim so the next daily tick retries.
      await Subscription.updateOne({ _id: subscription._id }, { $set: { expiryReminderSentAt: null } });
    }
  }
}

function startSubscriptionExpiryJob() {
  schedule("0 8 * * *", () => {
    tenantContext
      .runAsSystem(async () => {
        // Phase 11.2: state transitions FIRST (active → past_due → expired),
        // then reminders for those still approaching expiry.
        const { runTransitions } = require("../services/subscriptionLifecycleService");
        const moved = await runTransitions();
        if (moved.pastDue || moved.expired) {
          console.log(`[subscriptionExpiryJob] transitions: ${moved.pastDue} past_due, ${moved.expired} expired`);
        }
        await sendDueReminders();
      })
      .catch((err) => console.error("[subscriptionExpiryJob] run failed:", err.message));
  });
  console.log(`[subscriptionExpiryJob] scheduled daily at 08:00 ${cronTimezone()}`);
}

module.exports = { startSubscriptionExpiryJob };
