const mongoose = require("mongoose");

const invoiceSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true, unique: true },

    invoiceNumber: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    billingCycle: { type: String, enum: ["monthly", "yearly"], required: true },
    planName: { type: String, required: true },

    issuedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

invoiceSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("Invoice", invoiceSchema);
