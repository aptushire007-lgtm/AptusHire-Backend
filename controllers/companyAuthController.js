const jwt = require("jsonwebtoken");
const { registerCompany, resendCompanyOtp, verifyCompanyOtp } = require("../services/companyRegistrationService");
const { ServiceError } = require("../utils/errors");

function handleServiceError(err, res) {
  if (err instanceof ServiceError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: "Something went wrong" });
}

async function register(req, res) {
  const { company, admin: adminDetails } = req.body;
  try {
    const { company: createdCompany } = await registerCompany({
      companyDetails: company || {},
      adminDetails: adminDetails || {},
    });
    res.status(201).json({
      message: "Company registered. Log in to continue to your subscription plan.",
      company: { id: createdCompany._id, name: createdCompany.name, companyCode: createdCompany.companyCode, status: createdCompany.status },
    });
  } catch (err) {
    handleServiceError(err, res);
  }
}

async function resendOtp(req, res) {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required" });
  try {
    await resendCompanyOtp(email);
    res.json({ message: "If a pending registration exists for that email, a new code has been sent." });
  } catch (err) {
    handleServiceError(err, res);
  }
}

async function verifyOtp(req, res) {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: "email and otp are required" });

  try {
    const { company, admin } = await verifyCompanyOtp(email, otp);
    const token = jwt.sign({ userId: String(admin._id), role: admin.role }, process.env.AUTH_JWT_SECRET, {
      expiresIn: "1h",
    });
    res.json({
      message: "Email verified. Choose a subscription plan to activate your workspace.",
      token,
      company: { id: company._id, name: company.name, companyCode: company.companyCode, status: company.status },
    });
  } catch (err) {
    handleServiceError(err, res);
  }
}

module.exports = { register, resendOtp, verifyOtp };
