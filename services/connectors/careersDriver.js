// Tier A "connector" for the tenant's own careers page — trivially published:
// the page renders every published job already, so this driver just records the
// canonical URL. Exists so the careers channel appears in the same publish UI
// with the same status row as every external board.

const careersService = require("../careersService");
const Company = require("../../models/Company");
const { publicBaseUrl } = require("../../utils/corsOrigins");

module.exports = {
  key: "careers",
  name: "Careers page",
  tier: "A",
  needsCredential: false,

  available() {
    return { enabled: true };
  },

  validate() {
    return []; // anything publishable in the ATS is publishable on the careers page
  },

  async publish({ job, company }) {
    const doc = company._id ? company : await Company.findById(job.company);
    const slug = await careersService.ensureCompanySlug(doc);
    careersService.cacheClear(); // the page should show the job immediately
    return { externalRef: String(job._id), externalUrl: `${publicBaseUrl()}/careers/${slug}` };
  },

  async update(ctx) {
    careersService.cacheClear();
    return { externalRef: ctx.externalRef };
  },

  async withdraw() {
    careersService.cacheClear(); // page/feed only render published jobs — nothing else to do
    return {};
  },

  async checkStatus({ job }) {
    return { status: job && job.status === "published" ? "published" : "withdrawn" };
  },
};
