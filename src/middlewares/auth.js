const jwt = require("jsonwebtoken");
const { env } = require("../config/env");

function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, message: "Missing token" });

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    req.user = payload; // { sub, role, branchId }
    next();
  } catch {
    return res.status(401).json({ ok: false, message: "Invalid token" });
  }
}

function requireRole(roles = []) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, message: "Unauthenticated" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ ok: false, message: "Forbidden" });
    next();
  };
}

module.exports = { authRequired, requireRole };
