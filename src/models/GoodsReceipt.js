const mongoose = require("mongoose");

const GoodsReceiptItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    sku: { type: String, default: "" },
    name: { type: String, default: "" },

    qty: { type: Number, required: true },      // số lượng nhập
    cost: { type: Number, required: true },     // giá nhập / 1
    total: { type: Number, required: true },    // qty * cost
  },
  { _id: false }
);

const GoodsReceiptSchema = new mongoose.Schema(
  {
    code: { type: String, unique: true, index: true, required: true },

    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },

    supplier: { type: String, default: "" },
    note: { type: String, default: "" },

    status: { type: String, enum: ["DRAFT", "CONFIRMED", "CANCELLED"], default: "DRAFT", index: true },

    subtotal: { type: Number, default: 0 }, // tổng tiền nhập (sum item.total)

    items: { type: [GoodsReceiptItemSchema], default: [] },

    createdById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    confirmedById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    confirmedAt: { type: Date, default: null },

    // chống bấm confirm 2 lần / sync
    clientMutationId: { type: String, unique: true, sparse: true, index: true },
  },
  { timestamps: true }
);

GoodsReceiptSchema.index({ branchId: 1, createdAt: -1 });
GoodsReceiptSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("GoodsReceipt", GoodsReceiptSchema);
