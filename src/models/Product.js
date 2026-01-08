const mongoose = require("mongoose");

const ProductImageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },      // URL ảnh
    isPrimary: { type: Boolean, default: false }, // ảnh chính
    order: { type: Number, default: 0 },          // thứ tự hiển thị
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

    cost: { type: Number, default: 0 },   // VND
    price: { type: Number, default: 0 },  // VND

    // ✅ HÌNH ẢNH
    thumbnail: { type: String, default: "" }, // ảnh đại diện (dùng list nhanh)
    images: { type: [ProductImageSchema], default: [] },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Product", ProductSchema);
