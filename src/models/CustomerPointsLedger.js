const mongoose = require("mongoose");

const CustomerPointsLedgerSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      index: true,
      required: true,
    },

    // +points hoặc -points
    delta: { type: Number, required: true },

    // ✅ required nhưng có default để tránh fail khi tạo trước
    balanceAfter: { type: Number, required: true, default: 0 },

    // EARN_ORDER | REVERT_EARN_CANCELLED | REVERT_EARN_REFUNDED | MANUAL_ADJUST ...
    reason: { type: String, default: "", index: true },

    // nguồn phát sinh: Order, Refund...
    refType: { type: String, default: "", index: true },
    refId: { type: mongoose.Schema.Types.ObjectId, index: true },

    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },

    expireAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

CustomerPointsLedgerSchema.index({ customerId: 1, createdAt: -1 });

// ✅ idempotent
CustomerPointsLedgerSchema.index({ refType: 1, refId: 1, reason: 1 }, { unique: true });

module.exports = mongoose.model("CustomerPointsLedger", CustomerPointsLedgerSchema);
