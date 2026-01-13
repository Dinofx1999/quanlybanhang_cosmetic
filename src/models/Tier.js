const mongoose = require("mongoose");

const TierSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, uppercase: true, trim: true, unique: true, index: true },
    name: { type: String, default: "" },
    isActive: { type: Boolean, default: true },

    // ✅ priority cao hơn = rank cao hơn
    priority: { type: Number, default: 0, index: true },

    // ✅ Ngưỡng lên hạng: chỉ cần đạt là lên (dựa theo customer.tierProgress.spendForTier)
    qualify: {
      thresholdVnd: { type: Number, default: 0 }, // VD: SILVER >= 10,000,000
    },

    // ✅ Earn points config theo tier
    earn: {
      amountPerPoint: { type: Number, default: 100000 }, // VD: 100k = 1 point
      round: { type: String, enum: ["FLOOR", "ROUND", "CEIL"], default: "FLOOR" },
      minOrderAmount: { type: Number, default: 0 }, // VD: đơn < min thì không cộng điểm
    },

    durationDays: { type: Number, default: 0 }, // 0 = không hạn
  },
  { timestamps: true }
);

TierSchema.index({ isActive: 1, priority: -1 });

module.exports = mongoose.model("Tier", TierSchema);
