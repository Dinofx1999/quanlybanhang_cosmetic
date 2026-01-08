// src/models/Inventory.js
const mongoose = require("mongoose");

const InventorySchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },

    quantity: { type: Number, default: 0 },      // tồn kho
    reserved: { type: Number, default: 0 },      // giữ chỗ (tuỳ bạn dùng hay không)
  },
  { timestamps: true }
);

// 1 sản phẩm chỉ có 1 record tồn kho cho 1 chi nhánh
InventorySchema.index({ branchId: 1, productId: 1 }, { unique: true });

module.exports = mongoose.model("Inventory", InventorySchema);
