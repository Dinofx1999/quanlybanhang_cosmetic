// src/models/Product.js
const mongoose = require("mongoose");

// Schema cho price tier (giá sỉ theo tier khách hàng)
const PriceTierSchema = new mongoose.Schema(
  {
    tierId: { type: mongoose.Schema.Types.ObjectId, ref: "TierAgency", required: true },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// Schema cho options (để tạo variants)
const ProductOptionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, lowercase: true, trim: true }, // vd: "size", "color"
    label: { type: String, trim: true }, // vd: "Kích thước", "Màu sắc"
    values: { type: [String], default: [] }, // vd: ["S", "M", "L"]
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

// Schema cho pricing rules (quy tắc tính giá động)
const PricingRuleSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    priority: { type: Number, default: 100 },
    when: [
      {
        key: { type: String, required: true }, // attribute key
        op: { type: String, enum: ["eq", "ne", "in", "nin"], default: "eq" },
        value: { type: String, required: true },
      },
    ],
    actionRetail: {
      type: { type: String, enum: ["NONE", "SET", "ADD"], default: "NONE" },
      amount: { type: Number, default: 0 },
    },
    actionTiers: [
      {
        tierId: { type: mongoose.Schema.Types.ObjectId, required: true },
        type: { type: String, enum: ["NONE", "SET", "ADD"], default: "NONE" },
        amount: { type: Number, default: 0 },
      },
    ],
  },
  { _id: false }
);

// Schema cho images
const ImageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    isPrimary: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

const ProductSchema = new mongoose.Schema(
  {
    // Thông tin cơ bản
    sku: { type: String, required: true, trim: true, uppercase: true, unique: true },
    name: { type: String, required: true, trim: true },
    barcode: { type: String, trim: true, sparse: true },

    // Phân loại
    brand: { type: String, trim: true, default: "" },
    categoryId: { type: mongoose.Schema.Types.Mixed }, // ObjectId hoặc String
    categoryName: { type: String, trim: true, default: "" },

    // Giá cơ bản (cho product không có variants)
    price: { type: Number, required: true, min: 0, default: 0 },
    cost: { type: Number, min: 0, default: 0 },
    price_tier: { type: [PriceTierSchema], default: [] },

    // Variants system
    hasVariants: { type: Boolean, default: false },
    options: { type: [ProductOptionSchema], default: [] },

    // Base pricing cho variants (giá gốc trước khi áp rules)
    basePrice: { type: Number, min: 0 }, // Giá lẻ cơ bản
    baseTier: { type: [PriceTierSchema], default: [] }, // Giá sỉ cơ bản
    pricingRules: { type: [PricingRuleSchema], default: [] }, // Rules tính giá động

    // Images
    thumbnail: { type: String, default: "" },
    images: { type: [ImageSchema], default: [] },

    // ✅ NEW: variant mặc định (đơn vị kho tối thiểu)
    defaultVariantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", default: null, index: true },
    // defaultVariantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", default: null, index: true },

    // Status
    isActive: { type: Boolean, default: true, index: true },
  },
  {
    timestamps: true,
    collection: "products", // Đảm bảo tên collection
  }
);

// Indexes
ProductSchema.index({ sku: 1 }, { unique: true });
ProductSchema.index(
  { barcode: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { barcode: { $type: "string", $gt: "" } },
  }
);
ProductSchema.index({ name: "text", sku: "text" });
ProductSchema.index({ brand: 1 });
ProductSchema.index({ categoryId: 1 });
ProductSchema.index({ isActive: 1 });
ProductSchema.index({ defaultVariantId: 1 });

module.exports = mongoose.model("Product", ProductSchema);
