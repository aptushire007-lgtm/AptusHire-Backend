const { makePartnerDriver } = require("./partnerDriverFactory");

// Indeed ORGANIC listings need no driver at all — the Tier A XML feed covers
// them. This driver is for SPONSORED postings via the ATS-partner program.
module.exports = makePartnerDriver({
  key: "indeed",
  name: "Indeed (sponsored)",
  envFlag: "INDEED_PARTNER_ENABLED",
  apiBaseEnv: "INDEED_API_BASE",
  defaultBase: "https://api.indeed.example",
});
