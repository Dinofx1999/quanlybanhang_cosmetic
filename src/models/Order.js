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
    // ✅ thêm PENDING để lưu tình trạng chưa thu tiền
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

// ✅ lưu dấu vết TRỪ/HOÀN KHO
// - ONLINE: có sau khi CONFIRM
// - POS: có thể có ngay lúc tạo PENDING/CONFIRM (vì bạn yêu cầu PENDING cũng trừ kho)
const StockAllocationSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    qty: { type: Number, required: true },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    code: { type: String, unique: true, index: true, required: true },

    channel: { type: String, enum: ["POS", "ONLINE"], required: true },

    status: {
      type: String,
      enum: ["PENDING", "CONFIRM", "SHIPPED", "CANCELLED", "REFUNDED"],
      default: "PENDING",
      index: true,
    },

    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },

    subtotal: { type: Number, default: 0 },

    // ✅ NEW: discount + extraFee (+ note)
    discount: { type: Number, default: 0 },
    extraFee: { type: Number, default: 0 },
    pricingNote: { type: String, default: "" },

    // ✅ total = subtotal - discount + extraFee (routes sẽ tính)
    total: { type: Number, default: 0 },

    items: { type: [OrderItemSchema], default: [] },
    payments: { type: [PaymentSchema], default: [] },
    delivery: { type: DeliverySchema, default: {} },

    createdById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // ✅ set khi đã trừ kho (POS: PENDING/CONFIRM, ONLINE: CONFIRM)
    stockAllocations: { type: [StockAllocationSchema], default: [] },

    // ✅ chỉ set khi CONFIRM
    confirmedAt: { type: Date, default: null },
    confirmedById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    shippedAt: { type: Date, default: null },

    refundedAt: { type: Date, default: null },
    refundNote: { type: String, default: "" },

    clientMutationId: { type: String, unique: true, sparse: true, index: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

OrderSchema.index({ channel: 1, createdAt: -1 });
OrderSchema.index({ branchId: 1, createdAt: -1 });

module.exports = mongoose.model("Order", OrderSchema);
