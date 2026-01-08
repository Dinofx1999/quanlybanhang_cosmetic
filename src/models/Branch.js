const mongoose = require("mongoose");

const BranchSchema = new mongoose.Schema(
  {
    code: { type: String, unique: true, index: true, required: true },
    name: { type: String, required: true },
    address: { type: String, default: "" },
    phone: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Branch", BranchSchema);
