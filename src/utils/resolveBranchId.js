// utils/resolveBranchId.js
const mongoose = require("mongoose");

function resolveBranchId(req) {
  const role = String(req.user?.role || "").toUpperCase();
  const userBranchId = req.user?.branchId ? String(req.user.branchId) : null;
  const qBranch = req.query.branchId !== undefined ? String(req.query.branchId) : "all";

  if (role === "STAFF") return userBranchId; // khóa theo token

  // admin/manager//
  if (!qBranch || qBranch === "all" || qBranch === "null") return null;

  if (!mongoose.isValidObjectId(qBranch)) return null;
  return qBranch;
}

module.exports = { resolveBranchId };
