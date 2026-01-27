// src/models/FlashSale.js
const mongoose = require("mongoose");

// ===============================
// Schema cho variant trong flash sale
// ===============================
const FlashSaleVariantSchema = new mongoose.Schema(
  {
    variantId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "ProductVariant", 
      required: true,
      index: true 
    },
    
    flashPrice: { 
      type: Number, 
      required: true, 
      min: 0 
    },
    
    discountPercent: { 
      type: Number, 
      min: 0, 
      max: 100,
      default: 0 
    },
    
    limitedQuantity: { 
      type: Number, 
      min: 0,
      default: null
    },
    
    soldQuantity: { 
      type: Number, 
      default: 0,
      min: 0 
    },
    
    maxPerCustomer: { 
      type: Number, 
      default: null
    },
    
    isActive: { 
      type: Boolean, 
      default: true 
    },
    
    order: { 
      type: Number, 
      default: 0 
    },
    
    badge: {
      type: String,
      trim: true,
      default: ""
    }
  },
  { _id: false }
);

// ===============================
// Schema chính cho Flash Sale
// ===============================
const FlashSaleSchema = new mongoose.Schema(
  {
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
    
    variants: { 
      type: [FlashSaleVariantSchema], 
      default: [] 
    },
    
    banner: { 
      type: String, 
      default: "" 
    },
    
    images: [{
      url: { type: String, required: true },
      order: { type: Number, default: 0 }
    }],
    
    branchIds: [{ 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Branch" 
    }],
    
    tierIds: [{ 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "TierAgency" 
    }],
    
    priority: { 
      type: Number, 
      default: 0,
      index: true 
    },
    
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

// ===============================
// Indexes
// ===============================
FlashSaleSchema.index({ code: 1 }, { unique: true });
FlashSaleSchema.index({ status: 1, isActive: 1 });
FlashSaleSchema.index({ startDate: 1, endDate: 1 });
FlashSaleSchema.index({ "variants.variantId": 1 });
FlashSaleSchema.index({ priority: -1 });

// ===============================
// Virtual: Kiểm tra flash sale đang active
// ===============================
FlashSaleSchema.virtual("isCurrentlyActive").get(function() {
  const now = new Date();
  return (
    this.isActive &&
    this.status === "ACTIVE" &&
    this.startDate <= now &&
    this.endDate >= now
  );
});

// ===============================
// Virtual: Tổng số variants active
// ===============================
FlashSaleSchema.virtual("totalActiveVariants").get(function() {
  return (this.variants || []).filter(v => v.isActive).length;
});

// ===============================
// Method: Cập nhật status tự động
// ===============================
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

// ===============================
// Method: Kiểm tra variant có trong flash sale không
// ===============================
FlashSaleSchema.methods.hasVariant = function(variantId) {
  return (this.variants || []).some(v => 
    String(v.variantId) === String(variantId) && v.isActive
  );
};

// ===============================
// Method: Lấy thông tin variant trong flash sale
// ===============================
FlashSaleSchema.methods.getVariant = function(variantId) {
  return (this.variants || []).find(v => 
    String(v.variantId) === String(variantId) && v.isActive
  );
};

// ===============================
// Method: Tăng số lượng đã bán
// ===============================
FlashSaleSchema.methods.incrementSoldQuantity = async function(variantId, quantity = 1) {
  const variant = this.variants.find(v => String(v.variantId) === String(variantId));
  
  if (!variant) {
    throw new Error("VARIANT_NOT_IN_FLASH_SALE");
  }
  
  if (!variant.isActive) {
    throw new Error("VARIANT_NOT_ACTIVE");
  }
  
  if (variant.limitedQuantity) {
    const remaining = variant.limitedQuantity - variant.soldQuantity;
    if (quantity > remaining) {
      throw new Error("INSUFFICIENT_FLASH_SALE_QUANTITY");
    }
  }
  
  variant.soldQuantity += quantity;
  await this.save();
  
  return variant;
};

// ===============================
// Method: Giảm số lượng đã bán (khi hủy đơn)
// ===============================
FlashSaleSchema.methods.decrementSoldQuantity = async function(variantId, quantity = 1) {
  const variant = this.variants.find(v => String(v.variantId) === String(variantId));
  
  if (!variant) {
    throw new Error("VARIANT_NOT_IN_FLASH_SALE");
  }
  
  variant.soldQuantity = Math.max(0, variant.soldQuantity - quantity);
  await this.save();
  
  return variant;
};

// ===============================
// Static: Lấy flash sale đang active
// ===============================
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
      { branchIds: { $size: 0 } },
      { branchIds: options.branchId }
    ];
  }
  
  if (options.tierId) {
    const tierQuery = {
      $or: [
        { tierIds: { $size: 0 } },
        { tierIds: options.tierId }
      ]
    };
    
    if (query.$or) {
      query.$and = [
        { $or: query.$or },
        tierQuery
      ];
      delete query.$or;
    } else {
      query.$or = tierQuery.$or;
    }
  }
  
  return this.find(query).sort({ priority: -1, startDate: 1 });
};

// ===============================
// Static: Lấy flash sale có priority cao nhất cho variant
// ===============================
FlashSaleSchema.statics.getHighestPriorityForVariant = async function(variantId, options = {}) {
  const now = new Date();
  const query = {
    isActive: true,
    status: "ACTIVE",
    startDate: { $lte: now },
    endDate: { $gte: now },
    "variants.variantId": variantId,
    "variants.isActive": true
  };
  
  if (options.branchId) {
    query.$or = [
      { branchIds: { $size: 0 } },
      { branchIds: options.branchId }
    ];
  }
  
  if (options.tierId) {
    const tierQuery = {
      $or: [
        { tierIds: { $size: 0 } },
        { tierIds: options.tierId }
      ]
    };
    
    if (query.$or) {
      query.$and = [
        { $or: query.$or },
        tierQuery
      ];
      delete query.$or;
    } else {
      query.$or = tierQuery.$or;
    }
  }
  
  const flashSale = await this.findOne(query).sort({ priority: -1, startDate: 1 });
  
  if (!flashSale) return null;
  
  const variant = flashSale.variants.find(v => 
    String(v.variantId) === String(variantId) && v.isActive
  );
  
  return variant ? { flashSale, variant } : null;
};

// ===============================
// Static: Kiểm tra variant có đủ số lượng flash sale không
// ===============================
FlashSaleSchema.statics.checkAvailability = async function(variantId, quantity = 1, options = {}) {
  const result = await this.getHighestPriorityForVariant(variantId, options);
  
  if (!result) {
    return { available: false, reason: "NO_ACTIVE_FLASH_SALE" };
  }
  
  const { variant } = result;
  
  if (!variant.limitedQuantity) {
    return { available: true, flashSale: result.flashSale, variant };
  }
  
  const remaining = variant.limitedQuantity - variant.soldQuantity;
  
  if (remaining < quantity) {
    return { 
      available: false, 
      reason: "INSUFFICIENT_QUANTITY",
      remaining 
    };
  }
  
  return { available: true, flashSale: result.flashSale, variant, remaining };
};

// ===============================
// ✅ KHÔNG CÓ PRE-SAVE MIDDLEWARE NÀO CẢ
// Validation và update status sẽ làm trong route handler
// ===============================

// ===============================
// Ensure virtuals are included in JSON
// ===============================
FlashSaleSchema.set("toJSON", { virtuals: true });
FlashSaleSchema.set("toObject", { virtuals: true });

// ===============================
// Export
// ===============================
module.exports = mongoose.model("FlashSale", FlashSaleSchema);