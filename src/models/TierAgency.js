// src/models/TierAgency.js
const mongoose = require("mongoose");

const TierAgencySchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true }, // VD: "AGENCY_1"
    name: { type: String, required: true, trim: true },                                 // VD: "Sỉ cấp 1"
    level: { type: Number, default: 0 },                                                 // sắp xếp / ưu tiên
    isActive: { type: Boolean, default: true },

    // (tuỳ chọn) mô tả/điều kiện áp dụng
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

TierAgencySchema.index({ isActive: 1, level: 1 });

module.exports = mongoose.model("TierAgency", TierAgencySchema);
