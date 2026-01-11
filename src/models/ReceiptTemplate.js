const mongoose = require("mongoose");

const receiptTemplateSchema = new mongoose.Schema(
  {
    branchId: {
      type: String,
      default: null,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    paperSize: {
      type: Number,
      enum: [56, 80],
      default: 56,
    },
    components: [
      {
        id: {
          type: String,
          required: true,
        },
        type: {
          type: String,
          enum: [
            "logo",
            "heading",
            "text",
            "divider",
            "customer-info",
            "items-table",
            "totals",
            "qrcode",
            "barcode",
          ],
          required: true,
        },
        content: String,
        style: {
          fontSize: Number,
          fontWeight: String,
          textAlign: String,
          color: String,
          marginTop: Number,
          marginBottom: Number,
          paddingTop: Number,
          paddingBottom: Number,
        },
        config: mongoose.Schema.Types.Mixed,
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Index cho query performance
receiptTemplateSchema.index({ branchId: 1, isActive: 1 });
receiptTemplateSchema.index({ branchId: 1, isDefault: 1 });

module.exports = mongoose.model("ReceiptTemplate", receiptTemplateSchema);