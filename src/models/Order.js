// src/models/Order.js
const mongoose = require("mongoose");

const OrderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    sku: { type: String, default: "" },
    name: { type: String, default: "" },
    qty: { type: Number, required: true },
    price: { type: Number, required: true },
    total: { type: Number, required: true },
  },
  { _id: false }
);

const PaymentSchema = new mongoose.Schema(
  {
    method: { type: String, enum: ["CASH", "BANK", "CARD", "COD", "WALLET", "PENDING"], required: true },
    amount: { type: Number, required: true },
  },
  { _id: false }
);

const DeliverySchema = new mongoose.Schema(
  {
    method: { type: String, enum: ["PICKUP", "SHIP"], default: "SHIP" },
    address: { type: String, default: "" },
    receiverName: { type: String, default: "" },
    receiverPhone: { type: String, default: "" },
    note: { type: String, default: "" },
  },
  { _id: false }
);

const StockAllocationSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    qty: { type: Number, required: true },
  },
  { _id: false }
);

// ✅ Loyalty snapshot (audit)
const LoyaltySnapshotSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },

    baseField: { type: String, default: "total" },
    baseAmount: { type: Number, default: 0 },

    tier: { type: String, default: "BRONZE" },
    vndPerPoint: { type: Number, default: 0 },

    earnedPoints: { type: Number, default: 0 },
    earnedAt: { type: Date, default: null },
    earnedById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    revertedAt: { type: Date, default: null },
    revertedById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    revertReason: { type: String, default: "" },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    code: { type: String, unique: true, index: true, required: true },

    channel: { type: String, enum: ["POS", "ONLINE"], required: true },

    status: {
      type: String,
      // ✅ add DEBT
      enum: ["PENDING", "CONFIRM", "DEBT", "SHIPPED", "CANCELLED", "REFUNDED"],
      default: "PENDING",
      index: true,
    },

    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },

    subtotal: { type: Number, default: 0 },

    discount: { type: Number, default: 0 },
    extraFee: { type: Number, default: 0 },
    pricingNote: { type: String, default: "" },

    total: { type: Number, default: 0 },

    items: { type: [OrderItemSchema], default: [] },
    payments: { type: [PaymentSchema], default: [] },
    delivery: { type: DeliverySchema, default: {} },

    createdById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    stockAllocations: { type: [StockAllocationSchema], default: [] },

    confirmedAt: { type: Date, default: null },
    confirmedById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    shippedAt: { type: Date, default: null },

    refundedAt: { type: Date, default: null },
    refundNote: { type: String, default: "" },

    // ============================
    // Loyalty (Earn)
    // ============================
    pointsEarned: { type: Number, default: 0 },
    pointsAppliedAt: { type: Date, default: null },
    pointsRevertedAt: { type: Date, default: null },

    loyaltyAppliedAt: { type: Date, default: null },
    loyalty: { type: LoyaltySnapshotSchema, default: {} },

    // ============================
    // Redeem (Flow A)
    // - pointsRedeemed: số điểm thực tế dùng để giảm giá
    // - pointsRedeemAmount: số tiền giảm tương ứng
    // - pointsRedeemedAt: thời điểm đã TRỪ điểm ở Customer (idempotent)
    // - pointsRedeemRevertedAt: thời điểm hoàn lại redeem khi CANCEL/REFUND
    // ============================
    pointsRedeemed: { type: Number, default: 0 },
    pointsRedeemAmount: { type: Number, default: 0 },
    pointsRedeemedAt: { type: Date, default: null },
    pointsRedeemRevertedAt: { type: Date, default: null },

    // ============================
    // Debt snapshot
    // ============================
    debtAmount: { type: Number, default: 0 },

    clientMutationId: { type: String, unique: true, sparse: true, index: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

OrderSchema.index({ channel: 1, createdAt: -1 });
OrderSchema.index({ branchId: 1, createdAt: -1 });

module.exports = mongoose.model("Order", OrderSchema);
