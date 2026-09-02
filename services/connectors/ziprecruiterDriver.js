const { makePartnerDriver } = require("./partnerDriverFactory");

module.exports = makePartnerDriver({
  key: "ziprecruiter",
  name: "ZipRecruiter",
  envFlag: "ZIPRECRUITER_PARTNER_ENABLED",
  apiBaseEnv: "ZIPRECRUITER_API_BASE",
  defaultBase: "https://api.ziprecruiter.example",
});
