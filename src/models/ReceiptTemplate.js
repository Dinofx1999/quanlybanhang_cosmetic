const mongoose = require("mongoose");

const ReceiptTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    paperWidth: { type: String, enum: ["80mm"], default: "80mm" },

    // user editable
    html: { type: String, required: true, default: "" },
    css: { type: String, required: true, default: "" },

    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ReceiptTemplate", ReceiptTemplateSchema);
