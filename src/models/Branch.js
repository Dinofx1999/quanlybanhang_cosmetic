const mongoose = require("mongoose");

const BranchSchema = new mongoose.Schema(
  {
    // ====== CŨ (GIỮ NGUYÊN) ======
    code: { type: String, unique: true, index: true, required: true },
    name: { type: String, required: true },
    address: { type: String, default: "" },
    phone: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
    isMain: { type: Boolean, default: false, index: true },

    // ====== THÊM (CẦN THIẾT) ======

    // 1) Thông tin hiển thị trên bill / POS
    brandName: { type: String, default: "" }, // VD: "Bảo Ân Cosmetics" (in bill)
    email: { type: String, default: "" },
    taxCode: { type: String, default: "" },   // MST (nếu bạn muốn in bill)
    logo: { type: String, default: "" },      // URL logo (nếu in bill/website)
    

    // 2) Cấu hình in bill (56/80mm)
    receipt: {
      header: { type: String, default: "" },  // dòng đầu bill (có thể khác name)
      footer: { type: String, default: "Xin cảm ơn quý khách!" },
      paperSize: { type: Number, default: 80 }, // 56 hoặc 80
      showLogo: { type: Boolean, default: false },
      showTaxCode: { type: Boolean, default: true },
      template: { type: Array, default: [] },show_qrcode: { type: Boolean, default: false }, // có in QR code trên bill không
      showQRCode: { type: Boolean, default: false }, // có in QR code trên bill không
    },

    // 3) Cấu hình POS theo chi nhánh
    posConfig: {
      allowNegativeStock: { type: Boolean, default: false }, // âm kho hay không
      autoPrintReceipt: { type: Boolean, default: true },
      defaultPaymentMethod: {
        type: String,
        enum: ["CASH", "BANK", "QR", "CARD"],
        default: "CASH",
      },
    },
  },
  { timestamps: true }
);



module.exports = mongoose.model("Branch", BranchSchema);
