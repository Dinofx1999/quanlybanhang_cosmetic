const mongoose = require("mongoose");

const CategorySchema = new mongoose.Schema(
  {
    code: { type: String, unique: true, index: true, required: true },
    name: { type: String, required: true },
    slug: { type: String, index: true, required: true },

    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },

    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Category", CategorySchema);
