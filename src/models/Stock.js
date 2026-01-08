const mongoose = require("mongoose");

const StockSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    qty: { type: Number, default: 0 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

StockSchema.index({ branchId: 1, productId: 1 }, { unique: true });

module.exports = mongoose.model("Stock", StockSchema);
