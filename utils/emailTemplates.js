function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

// Every timestamp shown to a candidate carries an explicit timezone label —
// a bare server-locale time reads as the candidate's local time and is wrong
// for almost everyone. MAIL_TIMEZONE picks the zone (IST default; the platform
// is India-first), and the short zone name is always rendered with it.
const MAIL_TIMEZONE = process.env.MAIL_TIMEZONE || "Asia/Kolkata";

function formatDateTime(date) {
  return date.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: MAIL_TIMEZONE,
    timeZoneName: "short",
  });
}

const DEFAULT_INSTRUCTIONS =
  "Use a laptop or desktop with a working camera and microphone — the interview cannot run on most phones. " +
  "Join from a quiet, well-lit location with a stable internet connection.";

function rejectionEmailTemplate(candidate, job) {
  const name = candidate.basicDetails.name;
  const subject = `Update on your application for ${job.title}`;
  const text =
    `Hi ${name},\n\n` +
    `Thank you for applying for the ${job.title} position. After reviewing your application, ` +
    `we will not be moving forward at this time.\n\n` +
    `We appreciate your interest and wish you the best in your search.\n\n` +
    `Regards,\nRecruitment Team`;
  const html =
    `<p>Hi ${escapeHtml(name)},</p>` +
    `<p>Thank you for applying for the <strong>${escapeHtml(job.title)}</strong> position. ` +
    `After reviewing your application, we will not be moving forward at this time.</p>` +
    `<p>We appreciate your interest and wish you the best in your search.</p>` +
    `<p>Regards,<br/>Recruitment Team</p>`;

  return { subject, text, html };
}

function interviewInvitationEmailTemplate(candidate, job, session) {
  const name = candidate.basicDetails.name;
  const deadline = formatDateTime(session.expiresAt);
  const instructions = session.instructions || DEFAULT_INSTRUCTIONS;

  // Honest scheduling: the link works from the moment it arrives until it
  // expires — there is no fixed slot, so the email says exactly that instead
  // of naming a fictional date the system never enforces.
  const subject = `You're invited to interview for ${job.title}`;
  const text =
    `Hi ${name},\n\n` +
    `Congratulations! You've cleared the initial screening for the ${job.title} position, ` +
    `and we'd like to invite you to an AI-conducted interview.\n\n` +
    `Take it whenever suits you — your link works any time until:\n` +
    `${deadline}\n\n` +
    `Interview Link: ${session.interviewUrl}\n\n` +
    `Instructions:\n${instructions}\n\n` +
    `Keep this email — you'll need this link to start (or resume) your interview.\n\n` +
    `Regards,\nRecruitment Team`;
  const html =
    `<p>Hi ${escapeHtml(name)},</p>` +
    `<p>Congratulations! You've cleared the initial screening for the <strong>${escapeHtml(job.title)}</strong> ` +
    `position, and we'd like to invite you to an AI-conducted interview.</p>` +
    `<p>Take it whenever suits you — your link works any time until <strong>${escapeHtml(deadline)}</strong>.</p>` +
    `<p><a href="${escapeHtml(session.interviewUrl)}" style="display:inline-block;padding:10px 18px;background:#2a5f4f;color:#fff;text-decoration:none;border-radius:6px;">Start Interview</a></p>` +
    `<p>Or open this link: <a href="${escapeHtml(session.interviewUrl)}">${escapeHtml(session.interviewUrl)}</a></p>` +
    `<p><strong>Instructions:</strong><br/>${escapeHtml(instructions)}</p>` +
    `<p>Keep this email — you'll need this link to start (or resume) your interview.</p>` +
    `<p>Regards,<br/>Recruitment Team</p>`;

  return { subject, text, html };
}

function assessmentInvitationEmailTemplate(candidate, job, session) {
  const name = candidate.basicDetails.name;
  const deadline = formatDateTime(new Date(session.expiresAt));
  const startBy = formatDateTime(new Date(session.startDeadline));
  const instructions =
    session.instructions ||
    "Use a laptop or desktop in a quiet place with a stable connection. Each section is timed — once you start a section, its clock runs until you submit it.";

  const subject = `Skills assessment for ${job.title}`;
  const text =
    `Hi ${name},\n\n` +
    `You've been invited to a skills assessment for the ${job.title} position.\n\n` +
    `Start it any time before: ${startBy}\n` +
    `Your link stays valid until: ${deadline}\n\n` +
    `Assessment Link: ${session.assessmentUrl}\n\n` +
    `Instructions:\n${instructions}\n\n` +
    `Your answers save automatically — if you lose connection, reopen the same link to resume exactly where you left off.\n\n` +
    `Regards,\nRecruitment Team`;
  const html =
    `<p>Hi ${escapeHtml(name)},</p>` +
    `<p>You've been invited to a skills assessment for the <strong>${escapeHtml(job.title)}</strong> position.</p>` +
    `<p>Start it any time before <strong>${escapeHtml(startBy)}</strong>. Your link stays valid until <strong>${escapeHtml(deadline)}</strong>.</p>` +
    `<p><a href="${escapeHtml(session.assessmentUrl)}" style="display:inline-block;padding:10px 18px;background:#2a5f4f;color:#fff;text-decoration:none;border-radius:6px;">Start Assessment</a></p>` +
    `<p>Or open this link: <a href="${escapeHtml(session.assessmentUrl)}">${escapeHtml(session.assessmentUrl)}</a></p>` +
    `<p><strong>Instructions:</strong><br/>${escapeHtml(instructions)}</p>` +
    `<p>Your answers save automatically — if you lose connection, reopen the same link to resume exactly where you left off.</p>` +
    `<p>Regards,<br/>Recruitment Team</p>`;

  return { subject, text, html };
}

function assessmentReminderEmailTemplate(candidate, job, session) {
  const name = candidate.basicDetails.name;
  const startBy = formatDateTime(new Date(session.startDeadline));
  const subject = `Reminder: your skills assessment for ${job.title}`;
  const text =
    `Hi ${name},\n\n` +
    `A reminder that your skills assessment for ${job.title} is waiting. ` +
    `Start it before ${startBy} using the link from your invitation email.\n\n` +
    `Regards,\nRecruitment Team`;
  const html =
    `<p>Hi ${escapeHtml(name)},</p>` +
    `<p>A reminder that your skills assessment for <strong>${escapeHtml(job.title)}</strong> is waiting. ` +
    `Start it before <strong>${escapeHtml(startBy)}</strong> using the link from your invitation email.</p>` +
    `<p>Regards,<br/>Recruitment Team</p>`;
  return { subject, text, html };
}

// Panelist scorecard invite (RoundScorecard). Written for someone who may have
// never seen this platform and will not create an account: it says what the form
// is, how long it takes, and — deliberately — that it carries the questions
// worth asking. That last part is why it gets opened.
function scorecardInviteEmailTemplate({ interviewerName, candidateName, jobTitle, stageLabel, scorecardUrl, expiresAt, targetCount }) {
  const deadline = formatDateTime(new Date(expiresAt));
  const probeLine = targetCount
    ? `It already lists the ${targetCount} thing${targetCount === 1 ? "" : "s"} still worth probing for this candidate, so you can open it before the call and use it as your question list.`
    : `It lists this role's approved criteria so you can use it as your question list.`;

  const subject = `Scorecard: ${candidateName} — ${stageLabel} (${jobTitle})`;
  const text =
    `Hi ${interviewerName},\n\n` +
    `You're down to run the ${stageLabel.toLowerCase()} for ${candidateName} (${jobTitle}).\n\n` +
    `Your scorecard: ${scorecardUrl}\n\n` +
    `${probeLine}\n\n` +
    `No login needed — the link is yours. It takes about two minutes to fill in, and it's easiest to keep open during the interview. ` +
    `Anything you didn't get to, leave as "not assessed" — a blank is more useful to us than a guess.\n\n` +
    `The link works until ${deadline}.\n\n` +
    `Regards,\nRecruitment Team`;
  const html =
    `<p>Hi ${escapeHtml(interviewerName)},</p>` +
    `<p>You're down to run the <strong>${escapeHtml(stageLabel.toLowerCase())}</strong> for <strong>${escapeHtml(candidateName)}</strong> (${escapeHtml(jobTitle)}).</p>` +
    `<p><a href="${escapeHtml(scorecardUrl)}" style="display:inline-block;padding:10px 18px;background:#2a5f4f;color:#fff;text-decoration:none;border-radius:6px;">Open your scorecard</a></p>` +
    `<p>Or open this link: <a href="${escapeHtml(scorecardUrl)}">${escapeHtml(scorecardUrl)}</a></p>` +
    `<p>${escapeHtml(probeLine)}</p>` +
    `<p>No login needed — the link is yours. It takes about two minutes to fill in, and it's easiest to keep open during the interview. ` +
    `Anything you didn't get to, leave as <em>not assessed</em> — a blank is more useful to us than a guess.</p>` +
    `<p>The link works until <strong>${escapeHtml(deadline)}</strong>.</p>` +
    `<p>Regards,<br/>Recruitment Team</p>`;

  return { subject, text, html };
}

function scorecardReminderEmailTemplate({ interviewerName, candidateName, stageLabel, scorecardUrl, expiresAt }) {
  const deadline = formatDateTime(new Date(expiresAt));
  const subject = `Reminder: scorecard for ${candidateName} (${stageLabel})`;
  const text =
    `Hi ${interviewerName},\n\n` +
    `Your ${stageLabel.toLowerCase()} scorecard for ${candidateName} is still open. It takes about two minutes: ${scorecardUrl}\n\n` +
    `It expires ${deadline}.\n\nRegards,\nRecruitment Team`;
  const html =
    `<p>Hi ${escapeHtml(interviewerName)},</p>` +
    `<p>Your ${escapeHtml(stageLabel.toLowerCase())} scorecard for <strong>${escapeHtml(candidateName)}</strong> is still open. It takes about two minutes.</p>` +
    `<p><a href="${escapeHtml(scorecardUrl)}">Open your scorecard</a></p>` +
    `<p>It expires <strong>${escapeHtml(deadline)}</strong>.</p>` +
    `<p>Regards,<br/>Recruitment Team</p>`;
  return { subject, text, html };
}

function verificationEmailTemplate(user, verifyUrl) {
  const subject = "Verify your email address";
  const text =
    `Hi ${user.name},\n\n` +
    `Please verify your email address by opening the link below:\n\n` +
    `${verifyUrl}\n\n` +
    `This link expires in 24 hours. If you didn't create this account, you can ignore this email.\n\n` +
    `Regards,\nRecruitment Team`;
  const html =
    `<p>Hi ${escapeHtml(user.name)},</p>` +
    `<p>Please verify your email address by clicking the button below:</p>` +
    `<p><a href="${escapeHtml(verifyUrl)}" style="display:inline-block;padding:10px 18px;background:#2a5f4f;color:#fff;text-decoration:none;border-radius:6px;">Verify Email</a></p>` +
    `<p>Or open this link: <a href="${escapeHtml(verifyUrl)}">${escapeHtml(verifyUrl)}</a></p>` +
    `<p>This link expires in 24 hours. If you didn't create this account, you can ignore this email.</p>` +
    `<p>Regards,<br/>Recruitment Team</p>`;

  return { subject, text, html };
}

function passwordResetEmailTemplate(user, resetUrl) {
  const subject = "Reset your password";
  const text =
    `Hi ${user.name},\n\n` +
    `We received a request to reset your password. Open the link below to choose a new one:\n\n` +
    `${resetUrl}\n\n` +
    `This link expires in 30 minutes. If you didn't request this, you can ignore this email — your password will not change.\n\n` +
    `Regards,\nRecruitment Team`;
  const html =
    `<p>Hi ${escapeHtml(user.name)},</p>` +
    `<p>We received a request to reset your password. Click the button below to choose a new one:</p>` +
    `<p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:10px 18px;background:#2a5f4f;color:#fff;text-decoration:none;border-radius:6px;">Reset Password</a></p>` +
    `<p>Or open this link: <a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>` +
    `<p>This link expires in 30 minutes. If you didn't request this, you can ignore this email — your password will not change.</p>` +
    `<p>Regards,<br/>Recruitment Team</p>`;

  return { subject, text, html };
}

function otpEmailTemplate(companyName, otp) {
  const subject = "Your verification code";
  const text =
    `Hi,\n\n` +
    `Your verification code for ${companyName} is: ${otp}\n\n` +
    `This code expires in 10 minutes. If you didn't request this, you can ignore this email.\n\n` +
    `Regards,\nRecruitment Platform`;
  const html =
    `<p>Hi,</p>` +
    `<p>Your verification code for <strong>${escapeHtml(companyName)}</strong> is:</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px;">${escapeHtml(otp)}</p>` +
    `<p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>` +
    `<p>Regards,<br/>Recruitment Platform</p>`;

  return { subject, text, html };
}

function workspaceReadyEmailTemplate(company, adminName) {
  const subject = `Your ${company.name} workspace is ready`;
  const text =
    `Hi ${adminName},\n\n` +
    `Payment received — your workspace for ${company.name} is now active.\n\n` +
    `Company ID: ${company.companyCode}\n\n` +
    `You can now log in and start posting jobs.\n\n` +
    `Regards,\nRecruitment Platform`;
  const html =
    `<p>Hi ${escapeHtml(adminName)},</p>` +
    `<p>Payment received — your workspace for <strong>${escapeHtml(company.name)}</strong> is now active.</p>` +
    `<p><strong>Company ID:</strong> ${escapeHtml(company.companyCode)}</p>` +
    `<p>You can now log in and start posting jobs.</p>` +
    `<p>Regards,<br/>Recruitment Platform</p>`;

  return { subject, text, html };
}

function welcomeEmailTemplate(user) {
  const subject = "Welcome to your candidate dashboard";
  const text =
    `Hi ${user.name},\n\n` +
    `Your candidate dashboard is ready. Upload your resume, complete your profile, and start applying to jobs.\n\n` +
    `Regards,\nRecruitment Platform`;
  const html =
    `<p>Hi ${escapeHtml(user.name)},</p>` +
    `<p>Your candidate dashboard is ready. Upload your resume, complete your profile, and start applying to jobs.</p>` +
    `<p>Regards,<br/>Recruitment Platform</p>`;

  return { subject, text, html };
}

function applicationSubmittedEmailTemplate(candidate, job) {
  const name = candidate.basicDetails.name;
  const subject = `Application received for ${job.title}`;
  const text =
    `Hi ${name},\n\n` +
    `We've received your application for the ${job.title} position. It's being reviewed now, ` +
    `and you'll be notified of the outcome by email and on your dashboard.\n\n` +
    `Regards,\nRecruitment Team`;
  const html =
    `<p>Hi ${escapeHtml(name)},</p>` +
    `<p>We've received your application for the <strong>${escapeHtml(job.title)}</strong> position. It's being reviewed ` +
    `now, and you'll be notified of the outcome by email and on your dashboard.</p>` +
    `<p>Regards,<br/>Recruitment Team</p>`;

  return { subject, text, html };
}

// NOTE: the reminder cannot contain the interview link itself — only the link's
// hash is stored (deliberately: a stored raw token is a stolen-database
// interview hijack). So the reminder is made actionable the honest way: it
// names the exact email to search for and the real deadline, with timezone.
function interviewReminderEmailTemplate(candidate, job, session) {
  const name = candidate.basicDetails.name;
  const deadline = formatDateTime(session.expiresAt);

  const subject = `Reminder: your interview for ${job.title} — link expires soon`;
  const text =
    `Hi ${name},\n\n` +
    `A reminder that your interview for the ${job.title} position is still waiting for you.\n\n` +
    `Your interview link works until: ${deadline}\n\n` +
    `To start, open the email titled "You're invited to interview for ${job.title}" and use the link inside ` +
    `(for security we can't resend the same link automatically — if you can't find it, reply to that email and ` +
    `the hiring team can issue a fresh one).\n\n` +
    `Use a laptop or desktop with a camera and microphone, and allow a few minutes for the pre-interview device checks.\n\n` +
    `Regards,\nRecruitment Team`;
  const html =
    `<p>Hi ${escapeHtml(name)},</p>` +
    `<p>A reminder that your interview for the <strong>${escapeHtml(job.title)}</strong> position is still waiting for you.</p>` +
    `<p>Your interview link works until <strong>${escapeHtml(deadline)}</strong>.</p>` +
    `<p>To start, open the email titled <strong>&ldquo;You're invited to interview for ${escapeHtml(job.title)}&rdquo;</strong> ` +
    `and use the link inside. For security we can't resend the same link automatically — if you can't find it, reply to ` +
    `that email and the hiring team can issue a fresh one.</p>` +
    `<p>Use a laptop or desktop with a camera and microphone, and allow a few minutes for the pre-interview device checks.</p>` +
    `<p>Regards,<br/>Recruitment Team</p>`;

  return { subject, text, html };
}

function offerLetterEmailTemplate(candidate, job, offer) {
  const name = candidate.basicDetails.name;
  const subject = `Offer Letter — ${job.title}`;
  const text =
    `Hi ${name},\n\n` +
    `Congratulations! We are pleased to offer you the ${job.title} position.\n\n` +
    (offer?.message ? `${offer.message}\n\n` : "") +
    `Regards,\nRecruitment Team`;
  const html =
    `<p>Hi ${escapeHtml(name)},</p>` +
    `<p>Congratulations! We are pleased to offer you the <strong>${escapeHtml(job.title)}</strong> position.</p>` +
    (offer?.message ? `<p>${escapeHtml(offer.message)}</p>` : "") +
    `<p>Regards,<br/>Recruitment Team</p>`;

  return { subject, text, html };
}

function stageUpdateEmailTemplate(candidate, job, stageLabel, note) {
  const name = candidate.basicDetails.name;
  const subject = `Update on your application for ${job.title}`;
  const text =
    `Hi ${name},\n\n` +
    `There's an update on your application for the ${job.title} position.\n\n` +
    `Current stage: ${stageLabel}\n` +
    (note ? `Note: ${note}\n` : "") +
    `\nYou can track your full application timeline from your candidate dashboard.\n\n` +
    `Regards,\nRecruitment Team`;
  const html =
    `<p>Hi ${escapeHtml(name)},</p>` +
    `<p>There's an update on your application for the <strong>${escapeHtml(job.title)}</strong> position.</p>` +
    `<table cellpadding="4" cellspacing="0">` +
    `<tr><td><strong>Current stage</strong></td><td>${escapeHtml(stageLabel)}</td></tr>` +
    (note ? `<tr><td><strong>Note</strong></td><td>${escapeHtml(note)}</td></tr>` : "") +
    `</table>` +
    `<p>You can track your full application timeline from your candidate dashboard.</p>` +
    `<p>Regards,<br/>Recruitment Team</p>`;

  return { subject, text, html };
}

function paymentSuccessEmailTemplate(company, admin, payment) {
  const subject = `Payment received — ${company.name}`;
  const text =
    `Hi ${admin.name},\n\n` +
    `We've received your payment of ${payment.currency} ${payment.amount} for the ${payment.billingCycle} plan.\n\n` +
    `Regards,\nRecruitment Platform`;
  const html =
    `<p>Hi ${escapeHtml(admin.name)},</p>` +
    `<p>We've received your payment of <strong>${escapeHtml(payment.currency)} ${escapeHtml(String(payment.amount))}</strong> ` +
    `for the ${escapeHtml(payment.billingCycle)} plan.</p>` +
    `<p>Regards,<br/>Recruitment Platform</p>`;

  return { subject, text, html };
}

function paymentFailedEmailTemplate(company, admin, payment) {
  const subject = `Payment failed — ${company.name}`;
  const text =
    `Hi ${admin.name},\n\n` +
    `Your payment attempt for the ${payment.billingCycle} plan failed: ${payment.failureReason || "Unknown error"}.\n\n` +
    `Please log in and retry your payment to keep your workspace active.\n\n` +
    `Regards,\nRecruitment Platform`;
  const html =
    `<p>Hi ${escapeHtml(admin.name)},</p>` +
    `<p>Your payment attempt for the ${escapeHtml(payment.billingCycle)} plan failed: ` +
    `${escapeHtml(payment.failureReason || "Unknown error")}.</p>` +
    `<p>Please log in and retry your payment to keep your workspace active.</p>` +
    `<p>Regards,<br/>Recruitment Platform</p>`;

  return { subject, text, html };
}

function invoiceEmailTemplate(company, admin, invoice) {
  const subject = `Invoice ${invoice.invoiceNumber} — ${company.name}`;
  const text =
    `Hi ${admin.name},\n\n` +
    `Here are your invoice details:\n\n` +
    `Invoice Number: ${invoice.invoiceNumber}\n` +
    `Plan: ${invoice.planName}\n` +
    `Billing Cycle: ${invoice.billingCycle}\n` +
    `Amount: ${invoice.currency} ${invoice.amount}\n\n` +
    `Regards,\nRecruitment Platform`;
  const html =
    `<p>Hi ${escapeHtml(admin.name)},</p>` +
    `<p>Here are your invoice details:</p>` +
    `<table cellpadding="4" cellspacing="0">` +
    `<tr><td><strong>Invoice Number</strong></td><td>${escapeHtml(invoice.invoiceNumber)}</td></tr>` +
    `<tr><td><strong>Plan</strong></td><td>${escapeHtml(invoice.planName)}</td></tr>` +
    `<tr><td><strong>Billing Cycle</strong></td><td>${escapeHtml(invoice.billingCycle)}</td></tr>` +
    `<tr><td><strong>Amount</strong></td><td>${escapeHtml(invoice.currency)} ${escapeHtml(String(invoice.amount))}</td></tr>` +
    `</table>` +
    `<p>Regards,<br/>Recruitment Platform</p>`;

  return { subject, text, html };
}

function subscriptionExpiryReminderEmailTemplate(company, admin, subscription) {
  const endDate = subscription.currentPeriodEnd.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const subject = `Your ${company.name} subscription is expiring soon`;
  const text =
    `Hi ${admin.name},\n\n` +
    `Your subscription is set to expire on ${endDate}. Renew before then to avoid any interruption to your workspace.\n\n` +
    `Regards,\nRecruitment Platform`;
  const html =
    `<p>Hi ${escapeHtml(admin.name)},</p>` +
    `<p>Your subscription is set to expire on <strong>${escapeHtml(endDate)}</strong>. Renew before then to avoid any ` +
    `interruption to your workspace.</p>` +
    `<p>Regards,<br/>Recruitment Platform</p>`;

  return { subject, text, html };
}

function passwordChangedEmailTemplate(user) {
  const subject = "Your password was changed";
  const text =
    `Hi ${user.name},\n\n` +
    `This is a confirmation that your account password was just changed. If you didn't make this change, please contact ` +
    `support immediately.\n\n` +
    `Regards,\nRecruitment Platform`;
  const html =
    `<p>Hi ${escapeHtml(user.name)},</p>` +
    `<p>This is a confirmation that your account password was just changed. If you didn't make this change, please ` +
    `contact support immediately.</p>` +
    `<p>Regards,<br/>Recruitment Platform</p>`;

  return { subject, text, html };
}

module.exports = {
  rejectionEmailTemplate,
  interviewInvitationEmailTemplate,
  assessmentInvitationEmailTemplate,
  assessmentReminderEmailTemplate,
  scorecardInviteEmailTemplate,
  scorecardReminderEmailTemplate,
  verificationEmailTemplate,
  passwordResetEmailTemplate,
  otpEmailTemplate,
  workspaceReadyEmailTemplate,
  welcomeEmailTemplate,
  applicationSubmittedEmailTemplate,
  interviewReminderEmailTemplate,
  offerLetterEmailTemplate,
  stageUpdateEmailTemplate,
  paymentSuccessEmailTemplate,
  paymentFailedEmailTemplate,
  invoiceEmailTemplate,
  subscriptionExpiryReminderEmailTemplate,
  passwordChangedEmailTemplate,
};
