const mongoose = require("mongoose");

const PointTransactionSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", index: true },

    type: { type: String, enum: ["EARN", "REDEEM", "ADJUST"], required: true },
    points: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },

    tierCodeAtThatTime: { type: String, default: "" },
    note: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model("PointTransaction", PointTransactionSchema);
