// src/routes/inventory.routes.js
const router = require("express").Router();
const mongoose = require("mongoose");
const Inventory = require("../models/Inventory");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

router.put(
  "/:branchId/:productId",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const { branchId, productId } = req.params;
    if (!mongoose.isValidObjectId(branchId) || !mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ ok: false, message: "INVALID_ID" });
    }

    const quantity = Number(req.body.quantity || 0);

    const doc = await Inventory.findOneAndUpdate(
      { branchId, productId },
      { $set: { quantity } },
      { upsert: true, new: true }
    );

    res.json({ ok: true, inventory: doc });
  })
);

module.exports = router;
