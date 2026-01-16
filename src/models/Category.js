// models/Category.js
const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      trim: true,
    },
    
    // ✅ NESTED CATEGORIES FIELDS
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,  // ← QUAN TRỌNG: Default null
    },
    parentName: {
      type: String,
      default: null,
    },
    level: {
      type: Number,
      default: 0,  // ← QUAN TRỌNG: Default 0
    },
    path: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],  // ← QUAN TRỌNG: Default []
    },
    
    order: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    collection: "categories",
  }
);

// Indexes
categorySchema.index({ parentId: 1, order: 1 });
categorySchema.index({ path: 1 });
categorySchema.index({ code: 1 });
categorySchema.index({ isActive: 1 });
categorySchema.index({ slug: 1 });

module.exports = mongoose.model("Category", categorySchema);