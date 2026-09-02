const { makePartnerDriver } = require("./partnerDriverFactory");

module.exports = makePartnerDriver({
  key: "linkedin",
  name: "LinkedIn (Talent Solutions)",
  envFlag: "LINKEDIN_PARTNER_ENABLED",
  apiBaseEnv: "LINKEDIN_API_BASE",
  defaultBase: "https://api.linkedin.example",
});
