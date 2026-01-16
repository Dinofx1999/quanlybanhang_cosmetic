// src/models/VariantStockTxn.js
const mongoose = require("mongoose");

const VariantStockTxnSchema = new mongoose.Schema(
  {
    variantId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "ProductVariant", 
      required: true, 
      index: true 
    },
    branchId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Branch", 
      required: true, 
      index: true 
    },
    
    // Loại giao dịch
    type: {
      type: String,
      enum: ["IN", "OUT", "SET", "TRANSFER_OUT", "TRANSFER_IN"],
      required: true,
      index: true,
    },
    
    // Số lượng thay đổi
    qty: { type: Number, required: true },
    before: { type: Number, default: 0 }, // Số lượng trước khi thay đổi
    after: { type: Number, default: 0 },  // Số lượng sau khi thay đổi
    
    // Ghi chú
    note: { type: String, default: "" },
    
    // Reference to other documents (optional)
    refType: { type: String, default: "" }, // "Order", "GoodsReceipt", etc.
    refId: { type: mongoose.Schema.Types.ObjectId },
    
    // Người thực hiện
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { 
    timestamps: true,
    collection: "variantstocktxns"
  }
);

// Indexes
VariantStockTxnSchema.index({ variantId: 1, createdAt: -1 });
VariantStockTxnSchema.index({ branchId: 1, createdAt: -1 });
VariantStockTxnSchema.index({ type: 1 });

module.exports = mongoose.model("VariantStockTxn", VariantStockTxnSchema);