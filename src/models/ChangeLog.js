const mongoose = require("mongoose");

const ChangeLogSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    collection: { type: String, required: true }, // products, stocks, orders...
    docId: { type: mongoose.Schema.Types.ObjectId, required: true },
    action: { type: String, enum: ["UPSERT", "DELETE"], default: "UPSERT" },
    version: { type: Number, required: true, index: true },
  },
  { timestamps: { createdAt: "at", updatedAt: false } }
);

ChangeLogSchema.index({ branchId: 1, version: 1 });

module.exports = mongoose.model("ChangeLog", ChangeLogSchema);
