const mongoose = require("mongoose");

const CustomerSchema = new mongoose.Schema(
  {
    phone: { type: String, unique: true, sparse: true, index: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    dob: { type: Date, default: null, index: true },

    points: { type: Number, default: 0 },

    tier: {
      code: { type: String, default: "BRONZE", uppercase: true, trim: true },
      startsAt: { type: Date, default: Date.now },
      expiresAt: { type: Date, default: null },
      permanent: { type: Boolean, default: false },
      locked: { type: Boolean, default: false },
    },

    stats: {
      spendAll: { type: Number, default: 0 },
      ordersAll: { type: Number, default: 0 },
      lastOrderAt: { type: Date, default: null },
    },

    // ✅ biến xét hạng theo bạn chốt:
    // - cộng dồn khi mua
    // - KHÔNG reset khi lên hạng
    // - reset = 0 khi rớt hạng
    tierProgress: {
      spendForTier: { type: Number, default: 0 },
      resetAt: { type: Date, default: Date.now },
    },

    tierUpdatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

CustomerSchema.index({ phone: 1, updatedAt: -1 });
CustomerSchema.index({ name: 1, updatedAt: -1 });

module.exports = mongoose.model("Customer", CustomerSchema);
