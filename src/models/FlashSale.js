// src/models/FlashSale.js
const mongoose = require("mongoose");

// Schema cho sản phẩm tham gia flash sale
const FlashSaleProductSchema = new mongoose.Schema(
  {
    productId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Product", 
      required: true,
      index: true 
    },
    
    // ✅ Giá flash sale
    flashPrice: { 
      type: Number, 
      required: true, 
      min: 0 
    },
    
    // ✅ Giảm giá theo %
    discountPercent: { 
      type: Number, 
      min: 0, 
      max: 100,
      default: 0 
    },
    
    // ✅ Số lượng giới hạn cho flash sale
    limitedQuantity: { 
      type: Number, 
      min: 0,
      default: null  // null = không giới hạn
    },
    
    // ✅ Số lượng đã bán trong flash sale
    soldQuantity: { 
      type: Number, 
      default: 0,
      min: 0 
    },
    
    // ✅ Số lượng tối đa 1 khách có thể mua
    maxPerCustomer: { 
      type: Number, 
      default: null  // null = không giới hạn
    },
    
    // ✅ Trạng thái
    isActive: { 
      type: Boolean, 
      default: true 
    },
    
    // ✅ Thứ tự hiển thị
    order: { 
      type: Number, 
      default: 0 
    },
    
    // ✅ Badge/Label (VD: "HOT", "BÁN CHẠY")
    badge: {
      type: String,
      trim: true,
      default: ""
    }
  },
  { _id: false }
);

const FlashSaleSchema = new mongoose.Schema(
  {
    // ✅ Thông tin cơ bản
    name: { 
      type: String, 
      required: true, 
      trim: true,
      index: true 
    },
    
    code: { 
      type: String, 
      required: true, 
      trim: true, 
      uppercase: true,
      unique: true,
      index: true 
    },
    
    description: { 
      type: String, 
      trim: true,
      default: "" 
    },
    
    // ✅ Thời gian
    startDate: { 
      type: Date, 
      required: true,
      index: true 
    },
    
    endDate: { 
      type: Date, 
      required: true,
      index: true 
    },
    
    // ✅ Danh sách sản phẩm
    products: { 
      type: [FlashSaleProductSchema], 
      default: [] 
    },
    
    // ✅ Hình ảnh banner
    banner: { 
      type: String, 
      default: "" 
    },
    
    images: [{
      url: { type: String, required: true },
      order: { type: Number, default: 0 }
    }],
    
    // ✅ Áp dụng cho chi nhánh nào
    branchIds: [{ 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Branch" 
    }],  // [] = tất cả chi nhánh
    
    // ✅ Áp dụng cho tier khách hàng nào
    tierIds: [{ 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "TierAgency" 
    }],  // [] = tất cả tier
    
    // ✅ Priority (flash sale nào ưu tiên hơn nếu sản phẩm nằm trong nhiều chương trình)
    priority: { 
      type: Number, 
      default: 0,
      index: true 
    },
    
    // ✅ Trạng thái
    status: {
      type: String,
      enum: ["DRAFT", "SCHEDULED", "ACTIVE", "ENDED", "CANCELLED"],
      default: "DRAFT",
      index: true
    },
    
    isActive: { 
      type: Boolean, 
      default: true,
      index: true 
    },
    
    // ✅ Metadata
    createdBy: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User" 
    },
    
    updatedBy: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User" 
    },
  },
  {
    timestamps: true,
    collection: "flashsales"
  }
);

// ✅ Indexes
FlashSaleSchema.index({ code: 1 }, { unique: true });
FlashSaleSchema.index({ status: 1, isActive: 1 });
FlashSaleSchema.index({ startDate: 1, endDate: 1 });
FlashSaleSchema.index({ "products.productId": 1 });
FlashSaleSchema.index({ priority: -1 });

// ✅ Virtual: Kiểm tra flash sale đang active
FlashSaleSchema.virtual("isCurrentlyActive").get(function() {
  const now = new Date();
  return (
    this.isActive &&
    this.status === "ACTIVE" &&
    this.startDate <= now &&
    this.endDate >= now
  );
});

// ✅ Method: Cập nhật status tự động
FlashSaleSchema.methods.updateStatus = function() {
  const now = new Date();
  
  if (this.status === "CANCELLED") {
    return this.status;
  }
  
  if (now < this.startDate) {
    this.status = "SCHEDULED";
  } else if (now >= this.startDate && now <= this.endDate) {
    this.status = "ACTIVE";
  } else if (now > this.endDate) {
    this.status = "ENDED";
  }
  
  return this.status;
};

// ✅ Static: Lấy flash sale đang active
FlashSaleSchema.statics.getActiveSales = function(options = {}) {
  const now = new Date();
  const query = {
    isActive: true,
    status: "ACTIVE",
    startDate: { $lte: now },
    endDate: { $gte: now },
  };
  
  if (options.branchId) {
    query.$or = [
      { branchIds: { $size: 0 } },  // Áp dụng cho tất cả
      { branchIds: options.branchId }
    ];
  }
  
  if (options.tierId) {
    query.$or = [
      { tierIds: { $size: 0 } },  // Áp dụng cho tất cả
      { tierIds: options.tierId }
    ];
  }
  
  return this.find(query).sort({ priority: -1, startDate: 1 });
};

module.exports = mongoose.model("FlashSale", FlashSaleSchema);