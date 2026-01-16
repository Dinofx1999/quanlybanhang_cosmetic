// src/models/VariantStock.js
const mongoose = require("mongoose");

const VariantStockSchema = new mongoose.Schema(
  {
    branchId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Branch", 
      required: true, 
      index: true 
    },
    variantId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "ProductVariant", 
      required: true, 
      index: true 
    },
    qty: { type: Number, default: 0 },
    reserved: { type: Number, default: 0 }, // Số lượng đang giữ trong orders
  },
  { 
    timestamps: true,
    collection: "variantstocks" // ⭐ SỬ DỤNG TÊN COLLECTION HIỆN CÓ TRONG DB
  }
);

// Compound unique index
VariantStockSchema.index({ branchId: 1, variantId: 1 }, { unique: true });

module.exports = mongoose.model("VariantStock", VariantStockSchema);