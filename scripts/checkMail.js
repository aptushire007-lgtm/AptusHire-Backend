// Proves whether THIS host can actually deliver mail with the current config.
//
//   npm run check:mail                  # describe + verify the transport, send nothing
//   npm run check:mail -- you@your.com  # also send one real test email
//
// Run it in both places and compare. Identical config that verifies locally and times out
// on the deploy means the host is blocking the transport, not that the credentials are
// wrong — that is exactly the shape of the outbound-SMTP block on container platforms,
// where every password-reset email died with "Connection timeout" while the code was fine.
//
// No database connection: this isolates mail delivery from everything else.
require("dotenv").config();

const { describeTransport, verifyTransport, sendMail, isFreemailSender } = require("../utils/mailer");

const recipient = process.argv[2];

function line(char = "-") {
  console.log(char.repeat(72));
}

async function main() {
  const transport = describeTransport();

  line("=");
  console.log("MAIL TRANSPORT CHECK");
  line("=");
  console.log(`mode          : ${transport.mode}`);
  console.log(`detail        : ${transport.detail}`);
  console.log(`delivers mail : ${transport.delivers ? "yes" : "NO — composed and logged only"}`);
  console.log(`MAIL_FROM     : ${process.env.MAIL_FROM || "(unset → no-reply@recruitment.local)"}`);
  console.log(`NODE_ENV      : ${process.env.NODE_ENV || "(unset)"}`);
  line();

  if (!transport.delivers) {
    console.error("FAIL: no transport configured. Set BREVO_API_KEY (preferred) or SMTP_HOST.");
    process.exitCode = 1;
    return;
  }

  if (isFreemailSender(process.env.MAIL_FROM)) {
    console.warn(
      `WARN: MAIL_FROM (${process.env.MAIL_FROM}) is a consumer mailbox. Even a successful send here can be ` +
        `junked or rejected by the recipient on DMARC alignment. Use a verified domain sender.`
    );
    line();
  }

  const startedAt = Date.now();
  try {
    const result = await verifyTransport();
    console.log(`PASS: transport reachable and credentials accepted (${Date.now() - startedAt}ms)`);
    if (result.account) console.log(`      provider account: ${result.account}`);
  } catch (err) {
    console.error(`FAIL: ${err.message}   (${Date.now() - startedAt}ms)`);
    line();
    if (transport.mode === "smtp") {
      console.error("Most likely this host blocks outbound SMTP. In order of preference:");
      console.error("  1. Set BREVO_API_KEY and drop SMTP_* — sends over HTTPS, cannot be port-blocked.");
      console.error("  2. Set SMTP_PORT=2525 (Brevo's alternate port, usually not blocked).");
      console.error("  3. Confirm from this same host:  node -e \"require('net').connect(587,'smtp-relay.brevo.com').on('connect',()=>console.log('open')).on('error',e=>console.log(e.code))\"");
    } else {
      console.error("Check BREVO_API_KEY is a valid v3 API key (Brevo → SMTP & API → API keys),");
      console.error("not the SMTP login. Outbound HTTPS to api.brevo.com must also be allowed.");
    }
    process.exitCode = 1;
    return;
  }

  if (!recipient) {
    line();
    console.log("No recipient given — nothing was sent.");
    console.log("To send one real test email:  npm run check:mail -- you@your-domain.com");
    return;
  }

  line();
  console.log(`Sending a test email to ${recipient} ...`);
  const sendStart = Date.now();
  try {
    const info = await sendMail({
      to: recipient,
      subject: "Recruitment platform — mail transport test",
      text: `This is a delivery test sent via the "${transport.mode}" transport at ${new Date().toISOString()}.\n\nIf you are reading it, password reset, verification and interview invitations can reach real inboxes from this host.`,
      html: `<p>This is a delivery test sent via the <strong>${transport.mode}</strong> transport at ${new Date().toISOString()}.</p><p>If you are reading it, password reset, verification and interview invitations can reach real inboxes from this host.</p>`,
    });
    console.log(`PASS: provider accepted the message (${Date.now() - sendStart}ms)`);
    if (info && info.messageId) console.log(`      messageId: ${info.messageId}`);
    line();
    console.log("Acceptance is not delivery — now confirm it actually lands in the inbox");
    console.log("(check spam too). If it is accepted but never arrives, the problem is sender");
    console.log("reputation / DMARC alignment on MAIL_FROM, not connectivity.");
  } catch (err) {
    console.error(`FAIL: send rejected — ${err.message}   (${Date.now() - sendStart}ms)`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
