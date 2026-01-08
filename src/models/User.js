const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    username: { type: String, unique: true, index: true, required: true },
    passwordHash: { type: String, required: true },
    name: { type: String, default: "" },
    role: { type: String, enum: ["ADMIN", "MANAGER", "CASHIER", "STAFF"], default: "STAFF" },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", UserSchema);
