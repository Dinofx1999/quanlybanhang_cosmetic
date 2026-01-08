const mongoose = require("mongoose");

const POSSessionSchema = new mongoose.Schema(
  {
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    cashierId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    openedAt: { type: Date, default: Date.now, index: true },
    closedAt: { type: Date, default: null },

    openingCash: { type: Number, default: 0 },
    closingCash: { type: Number, default: 0 },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

// 1 cashier chỉ có 1 ca đang mở trong 1 branch
POSSessionSchema.index(
  { branchId: 1, cashierId: 1, closedAt: 1 },
  { partialFilterExpression: { closedAt: null } }
);

module.exports = mongoose.model("POSSession", POSSessionSchema);
