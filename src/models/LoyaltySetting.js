// src/models/LoyaltySetting.js
const mongoose = require("mongoose");

const LoyaltySettingSchema = new mongoose.Schema(
  {
    key: { type: String, default: "default", unique: true },
    isActive: { type: Boolean, default: true },

    // Khi hết hạn tier / hoặc logic downgrade khác
    downgradeTo: { type: String, default: "BRONZE", uppercase: true, trim: true },

    renew: {
      enabled: { type: Boolean, default: true },
      addDays: { type: Number, default: 365 },
      basedOn: { type: String, enum: ["NOW"], default: "NOW" },
      onlyForTiers: {
        type: [String],
        default: ["SILVER", "GOLD", "DIAMOND"],
      },
    },

    autoUpgrade: {
      enabled: { type: Boolean, default: true },
      // ✅ CHỐT ENUM spend12m
      metric: { type: String, enum: ["spend12m"], default: "spend12m" },
    },

    pointBase: {
      // "total" khuyến nghị (order.total)
      field: { type: String, enum: ["total", "subtotal"], default: "total" },
    },

    // (Optional) Quy đổi điểm
    redeem: {
      redeemEnable: { type: Boolean, default: false },
      redeemValueVndPerPoint: { type: Number, default: 0 }, // VND / 1 point
      percentOfBill: { type: Number, default: 0 }, // tối đa % hóa đơn
      maxPointsPerOrder: { type: Number, default: 0 }, // tối đa điểm sử dụng
    },

    // (Optional) Downgrade step theo inactivity
    downgrade: {
      enabled: { type: Boolean, default: true },
      inactiveDaysPerStep: { type: Number, default: 90 },
      // thứ tự thấp -> cao (rớt hạng đi ngược lại)
      stepOrder: {
        type: [String],
        default: ["BRONZE", "SILVER", "GOLD", "DIAMOND"],
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LoyaltySetting", LoyaltySettingSchema);
