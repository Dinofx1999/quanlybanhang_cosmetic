// src/models/ProductVariant.js
const mongoose = require("mongoose");

// Schema cho price tier
const PriceTierSchema = new mongoose.Schema(
  {
    tierId: { type: mongoose.Schema.Types.ObjectId, ref: "TierAgency", required: true },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

// Schema cho attributes (thuộc tính của variant)
const VariantAttributeSchema = new mongoose.Schema(
  {
    k: { type: String, required: true, trim: true, lowercase: true }, // key: "size", "color"
    v: { type: String, required: true, trim: true }, // value: "S", "Đỏ"
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

const ProductVariantSchema = new mongoose.Schema(
  {
    // Reference to Product
    productId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Product", 
      required: true, 
      index: true 
    },
    isDefault: { type: Boolean, default: false, index: true },
    
    // Thông tin cơ bản
    sku: { 
      type: String, 
      required: true, 
      trim: true, 
      uppercase: true,
      index: true 
    },
    barcode: { type: String, trim: true, index: true },
    name: { type: String, trim: true, default: "" }, // Tên hiển thị
    
    // Thuộc tính phân biệt (VD: size=S, color=Đỏ)
    attributes: { type: [VariantAttributeSchema], default: [] },
    
    // Giá riêng cho variant
    price: { type: Number, min: 0, required: true },
    cost: { type: Number, min: 0, default: 0 },
    price_tier: { type: [PriceTierSchema], default: [] },
    
    // Images riêng cho variant (optional, fallback to product images)
    thumbnail: { type: String, default: "" },
    images: { type: [ImageSchema], default: [] },
    
    // Status
    isActive: { type: Boolean, default: true, index: true },
  },
  { 
    timestamps: true,
    collection: "productvariants" // ⭐ SỬ DỤNG TÊN COLLECTION HIỆN CÓ TRONG DB
  }
);

// Indexes
ProductVariantSchema.index({ productId: 1, sku: 1 }, { unique: true });
ProductVariantSchema.index({ 
  barcode: 1 
}, { 
  unique: true, 
  sparse: true,
  partialFilterExpression: { barcode: { $type: "string", $gt: "" } }
});
ProductVariantSchema.index({ productId: 1, isActive: 1 });
ProductVariantSchema.index({ name: "text", sku: "text" });
ProductVariantSchema.index({ productId: 1, isDefault: 1 });

module.exports = mongoose.model("ProductVariant", ProductVariantSchema);