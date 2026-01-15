const mongoose = require("mongoose");

const ProductImageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    isPrimary: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

// ✅ Giá theo cấp sỉ
const PriceTierSchema = new mongoose.Schema(
  {
    tierId: { type: mongoose.Schema.Types.ObjectId, ref: "TierAgency", required: true },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const ProductSchema = new mongoose.Schema(
  {
    sku: { type: String, unique: true, index: true, required: true },
    name: { type: String, index: true, required: true },
    brand: { type: String, default: "" },

    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },
    categoryName: { type: String, default: "" },

    barcode: { type: String, index: true, default: "" },

    cost: { type: Number, default: 0 },
    price: { type: Number, default: 0 }, // giá lẻ mặc định

    thumbnail: { type: String, default: "" },
    images: { type: [ProductImageSchema], default: [] },

    // ✅ thêm trường giá theo tier
    price_tier: { type: [PriceTierSchema], default: [] },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Index để query nhanh theo tier
ProductSchema.index({ "price_tier.tierId": 1 });

// Validate: không cho trùng tierId trong 1 product
// Validate: không cho trùng tierId trong 1 product
ProductSchema.pre("validate", function () {
  const arr = Array.isArray(this.price_tier) ? this.price_tier : [];
  const seen = new Set();

  for (const x of arr) {
    const id = String(x.tierId || "");
    if (!id) continue;
    if (seen.has(id)) {
      throw new Error("DUPLICATE_TIER_PRICE");
    }
    seen.add(id);
  }
});


module.exports = mongoose.model("Product", ProductSchema);
