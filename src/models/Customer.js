const mongoose = require("mongoose");

const CustomerSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, sparse: true, index: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    points: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Customer", CustomerSchema);
