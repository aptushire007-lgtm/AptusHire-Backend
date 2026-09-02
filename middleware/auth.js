const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/User");
const Company = require("../models/Company");
const tenantContext = require("../utils/tenantContext");
const { billingEnforced } = require("../utils/billingMode");

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.AUTH_JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "Session expired or invalid, please log in again" });
  }

  const user = await User.findById(payload.userId);
  if (!user) {
    return res.status(401).json({ error: "Account not found" });
  }

  req.user = user;

  // Phase 16.5 — read-only "view as tenant" for platform staff. The header only
  // ever takes effect for a superadmin, and the read-only guarantee is enforced
  // HERE, server-side: any non-GET carrying the header is rejected before any
  // route logic runs — not merely hidden by the UI. Full impersonation
  // deliberately does not exist.
  const viewAs = req.headers["x-view-as-company"];
  if (viewAs && user.role === "superadmin") {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      return res.status(403).json({
        error: "View-as-tenant is read-only — mutations are rejected server-side",
        code: "VIEW_AS_READ_ONLY",
      });
    }
    if (!mongoose.isValidObjectId(String(viewAs))) {
      return res.status(400).json({ error: "Invalid view-as company id" });
    }
    req.viewAsTenant = true;
    // A plain effective-user object: reads behave exactly like the tenant's own
    // admin (role gates included), scoped to the viewed company.
    req.user = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: "admin",
      company: new mongoose.Types.ObjectId(String(viewAs)),
    };
  }

  // Run the rest of the request inside a tenant context so the tenantScope plugin
  // auto-scopes every tenant-model query to this user's company. companyId is
  // undefined for candidate accounts / superadmin (no tenant) — those are not scoped.
  tenantContext.run(
    {
      companyId: req.user.company ? String(req.user.company) : undefined,
      userId: String(req.user._id),
      role: req.user.role,
    },
    () => next()
  );
}

// Populates req.user (and a tenant context) IF a valid bearer token is present, but
// never rejects when it's absent or invalid. For endpoints that are public but return
// richer/owner-only data to an authenticated caller (e.g. GET /jobs/:id showing a draft
// to its owning admin).
async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return next();
  try {
    const payload = jwt.verify(token, process.env.AUTH_JWT_SECRET);
    const user = await User.findById(payload.userId);
    if (user) {
      req.user = user;
      return tenantContext.run(
        {
          companyId: user.company ? String(user.company) : undefined,
          userId: String(user._id),
          role: user.role,
        },
        () => next()
      );
    }
  } catch {
    // Invalid token on an optional-auth route → treat as anonymous.
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have access to this resource" });
    }
    next();
  };
}

// Blocks company-scoped product access when the tenant isn't active (suspended, or
// still pending payment/verification). Enforced per-request so a status change takes
// effect immediately, not only at the next login. Identities without a company
// (candidate accounts, superadmin) pass through — apply this only on admin routers,
// and never on the billing/onboarding routes a pending company needs to become active.
async function requireActiveCompany(req, res, next) {
  try {
    if (!req.user || !req.user.company) return next();
    const company = await Company.findById(req.user.company).select("status");
    if (!company) return res.status(403).json({ error: "Company account not found" });
    // Demo / pilot bypass (BILLING_ENFORCEMENT=off, see utils/billingMode.js). Only the
    // STATUS requirement is lifted — the tenant must still exist, so a dangling company
    // reference is a hard 403 either way. Suspension is unenforced while this is on.
    if (!billingEnforced()) return next();
    if (company.status !== "active") {
      return res.status(403).json({
        error: "Your company account is not active. Complete payment or contact support to continue.",
        code: "COMPANY_INACTIVE",
        status: company.status,
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Gates MUTATING requests once the tenant's subscription has expired past its
// grace window (Phase 11.2). Reads always pass — expiry means read-only, never
// data lockout. Tenants with no subscription row pass (requireActiveCompany
// owns pre-payment states). During grace a warning header is set so the UI can
// surface "renew soon" without blocking anything.
async function requireActiveSubscription(req, res, next) {
  try {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (!req.user || !req.user.company) return next();

    const Subscription = require("../models/Subscription");
    const { assess, graceDays } = require("../services/subscriptionLifecycleService");
    const subscription = await Subscription.findOne({ company: req.user.company }).select("status currentPeriodEnd");
    const state = assess(subscription);

    if (state === "grace") {
      res.setHeader("X-Subscription-State", "grace");
      return next();
    }
    if (state === "expired") {
      const err = new Error(
        "Your subscription has expired and this workspace is read-only. Renew your plan to make changes."
      );
      err.status = 403;
      err.code = "SUBSCRIPTION_EXPIRED";
      err.subscription = { state, currentPeriodEnd: subscription?.currentPeriodEnd, graceDays: graceDays() };
      throw err;
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, optionalAuth, requireRole, requireActiveCompany, requireActiveSubscription };
