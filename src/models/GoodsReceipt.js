// src/models/GoodsReceipt.js
const mongoose = require("mongoose");

const GoodsReceiptItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },

    // ✅ sellable unit
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", default: null, index: true },

    // snapshot
    sku: { type: String, default: "" },
    name: { type: String, default: "" },

    // snapshot variant
    variantSku: { type: String, default: "" },
    variantName: { type: String, default: "" },
    attributes: { type: Array, default: [] }, // [{k,v}]

    qty: { type: Number, required: true, min: 1 },
    cost: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const GoodsReceiptSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    supplier: { type: String, default: "" },
    note: { type: String, default: "" },
    status: { type: String, enum: ["DRAFT", "CONFIRMED", "CANCELLED"], default: "DRAFT", index: true },

    items: { type: [GoodsReceiptItemSchema], default: [] },
    subtotal: { type: Number, default: 0 },

    createdById: { type: mongoose.Schema.Types.ObjectId, default: null },
    confirmedById: { type: mongoose.Schema.Types.ObjectId, default: null },
    confirmedAt: { type: Date, default: null },

    /**
     * ✅ FIX: đừng default null
     * - Nếu không truyền clientMutationId -> field sẽ "không tồn tại" trong document
     * - Khi có truyền -> mới lưu string
     */
    clientMutationId: { type: String, default: undefined },
  },
  { timestamps: true, collection: "goodsreceipts" }
);

// indexes
GoodsReceiptSchema.index({ branchId: 1, createdAt: -1 });
GoodsReceiptSchema.index({ status: 1, createdAt: -1 });

/**
 * ✅ FIX: unique chỉ áp dụng khi clientMutationId tồn tại và là string
 * - Tránh duplicate null / missing
 * - Chống double submit khi FE gửi cùng clientMutationId
 */
GoodsReceiptSchema.index(
  { clientMutationId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientMutationId: { $type: "string" } },
  }
);

module.exports = mongoose.model("GoodsReceipt", GoodsReceiptSchema);
