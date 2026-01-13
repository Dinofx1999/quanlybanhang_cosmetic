// src/routes/loyaltyApply.routes.js
const router = require("express").Router();
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const { applyLoyaltyForConfirmedOrder } = require("../services/loyaltyEngine");

router.post(
  "/apply/:orderId",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const rs = await applyLoyaltyForConfirmedOrder(req.params.orderId);
    res.json({ ok: true, result: rs });
  })
);

module.exports = router;
