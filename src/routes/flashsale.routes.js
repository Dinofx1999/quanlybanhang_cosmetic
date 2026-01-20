// src/routes/flashsale.routes.js
const router = require("express").Router();
const { z } = require("zod");
const mongoose = require("mongoose");

const FlashSale = require("../models/FlashSale");
const Product = require("../models/Product");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

// ===============================
// HELPERS
// ===============================
function isValidObjectId(id) {
  return mongoose.isValidObjectId(String(id || ""));
}

// ===============================
// GET /api/flashsales - Lấy danh sách flash sales
// ===============================
router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const isActive = req.query.isActive !== undefined ? String(req.query.isActive) === "true" : null;
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const query = {};
    
    if (status) query.status = status;
    if (isActive !== null) query.isActive = isActive;
    
    if (branchId && isValidObjectId(branchId)) {
      query.$or = [
        { branchIds: { $size: 0 } },
        { branchIds: new mongoose.Types.ObjectId(branchId) }
      ];
    }

    const [items, total] = await Promise.all([
      FlashSale.find(query)
        .sort({ priority: -1, startDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      FlashSale.countDocuments(query)
    ]);

    res.json({
      ok: true,
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  })
);

// ===============================
// GET /api/flashsales/active - Lấy flash sales đang active
// ===============================
router.get(
  "/active",
  authRequired,
  asyncHandler(async (req, res) => {
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    const tierId = req.query.tierId ? String(req.query.tierId) : null;

    const options = {};
    if (branchId && isValidObjectId(branchId)) {
      options.branchId = new mongoose.Types.ObjectId(branchId);
    }
    if (tierId && isValidObjectId(tierId)) {
      options.tierId = new mongoose.Types.ObjectId(tierId);
    }

    const items = await FlashSale.getActiveSales(options);

    res.json({
      ok: true,
      items,
      total: items.length
    });
  })
);

// ===============================
// GET /api/flashsales/:id - Chi tiết flash sale
// ===============================
router.get(
  "/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const flashSaleId = req.params.id;
    
    if (!isValidObjectId(flashSaleId)) {
      return res.status(400).json({ ok: false, message: "INVALID_FLASH_SALE_ID" });
    }

    const flashSale = await FlashSale.findById(flashSaleId)
      .populate("products.productId", "name sku thumbnail price")
      .lean();

    if (!flashSale) {
      return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });
    }

    res.json({ ok: true, flashSale });
  })
);

// ===============================
// GET /api/flashsales/:id/products - Lấy products trong flash sale
// ===============================
router.get(
  "/:id/products",
  authRequired,
  asyncHandler(async (req, res) => {
    const flashSaleId = req.params.id;
    
    if (!isValidObjectId(flashSaleId)) {
      return res.status(400).json({ ok: false, message: "INVALID_FLASH_SALE_ID" });
    }

    const flashSale = await FlashSale.findById(flashSaleId).lean();
    
    if (!flashSale) {
      return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });
    }

    // Lấy danh sách productIds
    const productIds = flashSale.products
      .filter(p => p.isActive)
      .map(p => p.productId);

    // Lấy thông tin products
    const products = await Product.find({
      _id: { $in: productIds },
      isActive: true
    }).lean();

    // Merge thông tin flash sale vào products
    const items = products.map(product => {
      const flashProduct = flashSale.products.find(
        p => String(p.productId) === String(product._id)
      );

      return {
        ...product,
        flashSale: {
          flashSaleId: flashSale._id,
          flashPrice: flashProduct.flashPrice,
          discountPercent: flashProduct.discountPercent,
          limitedQuantity: flashProduct.limitedQuantity,
          soldQuantity: flashProduct.soldQuantity,
          remainingQuantity: flashProduct.limitedQuantity 
            ? Math.max(0, flashProduct.limitedQuantity - flashProduct.soldQuantity)
            : null,
          maxPerCustomer: flashProduct.maxPerCustomer,
          badge: flashProduct.badge,
          startDate: flashSale.startDate,
          endDate: flashSale.endDate
        }
      };
    });

    res.json({
      ok: true,
      flashSale: {
        _id: flashSale._id,
        name: flashSale.name,
        code: flashSale.code,
        startDate: flashSale.startDate,
        endDate: flashSale.endDate,
        status: flashSale.status
      },
      items,
      total: items.length
    });
  })
);

// ===============================
// POST /api/flashsales - Tạo flash sale mới
// ===============================
router.post(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const body = z.object({
      name: z.string().min(2),
      code: z.string().min(2),
      description: z.string().optional(),
      startDate: z.string(),
      endDate: z.string(),
      priority: z.number().optional(),
      branchIds: z.array(z.string()).optional(),
      tierIds: z.array(z.string()).optional(),
      banner: z.string().optional(),
      images: z.array(z.object({
        url: z.string(),
        order: z.number().optional()
      })).optional(),
      products: z.array(z.object({
        productId: z.string(),
        flashPrice: z.number().nonnegative(),
        discountPercent: z.number().min(0).max(100).optional(),
        limitedQuantity: z.number().nonnegative().optional().nullable(),
        maxPerCustomer: z.number().nonnegative().optional().nullable(),
        badge: z.string().optional(),
        order: z.number().optional()
      })).optional()
    }).safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({ ok: false, error: body.error.flatten() });
    }

    const data = body.data;

    // Kiểm tra code trùng
    const existingCode = await FlashSale.findOne({ 
      code: data.code.toUpperCase() 
    });
    
    if (existingCode) {
      return res.status(400).json({ 
        ok: false, 
        message: "CODE_ALREADY_EXISTS" 
      });
    }

    // Validate dates
    const startDate = new Date(data.startDate);
    const endDate = new Date(data.endDate);
    
    if (startDate >= endDate) {
      return res.status(400).json({ 
        ok: false, 
        message: "START_DATE_MUST_BE_BEFORE_END_DATE" 
      });
    }

    // Chuẩn bị products
    const products = (data.products || []).map(p => ({
      productId: new mongoose.Types.ObjectId(p.productId),
      flashPrice: Math.round(p.flashPrice),
      discountPercent: p.discountPercent || 0,
      limitedQuantity: p.limitedQuantity || null,
      soldQuantity: 0,
      maxPerCustomer: p.maxPerCustomer || null,
      badge: p.badge || "",
      order: p.order || 0,
      isActive: true
    }));

    const flashSale = await FlashSale.create({
      name: data.name.trim(),
      code: data.code.toUpperCase().trim(),
      description: data.description || "",
      startDate,
      endDate,
      priority: data.priority || 0,
      branchIds: (data.branchIds || [])
        .filter(id => isValidObjectId(id))
        .map(id => new mongoose.Types.ObjectId(id)),
      tierIds: (data.tierIds || [])
        .filter(id => isValidObjectId(id))
        .map(id => new mongoose.Types.ObjectId(id)),
      banner: data.banner || "",
      images: data.images || [],
      products,
      status: "DRAFT",
      isActive: true,
      createdBy: req.user._id
    });

    // Auto update status
    flashSale.updateStatus();
    await flashSale.save();

    res.json({ ok: true, flashSale });
  })
);

// ===============================
// PUT /api/flashsales/:id - Cập nhật flash sale
// ===============================
router.put(
  "/:id",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const flashSaleId = req.params.id;
    
    if (!isValidObjectId(flashSaleId)) {
      return res.status(400).json({ ok: false, message: "INVALID_FLASH_SALE_ID" });
    }

    const body = z.object({
      name: z.string().min(2).optional(),
      description: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      priority: z.number().optional(),
      branchIds: z.array(z.string()).optional(),
      tierIds: z.array(z.string()).optional(),
      banner: z.string().optional(),
      images: z.array(z.object({
        url: z.string(),
        order: z.number().optional()
      })).optional(),
      isActive: z.boolean().optional(),
      status: z.enum(["DRAFT", "SCHEDULED", "ACTIVE", "ENDED", "CANCELLED"]).optional()
    }).safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({ ok: false, error: body.error.flatten() });
    }

    const flashSale = await FlashSale.findById(flashSaleId);
    
    if (!flashSale) {
      return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });
    }

    const data = body.data;
    const patch = {};

    if (data.name) patch.name = data.name.trim();
    if (data.description !== undefined) patch.description = data.description;
    if (data.priority !== undefined) patch.priority = data.priority;
    if (data.banner !== undefined) patch.banner = data.banner;
    if (data.images !== undefined) patch.images = data.images;
    if (data.isActive !== undefined) patch.isActive = data.isActive;
    if (data.status) patch.status = data.status;

    if (data.startDate) {
      patch.startDate = new Date(data.startDate);
    }
    
    if (data.endDate) {
      patch.endDate = new Date(data.endDate);
    }

    if (patch.startDate && patch.endDate && patch.startDate >= patch.endDate) {
      return res.status(400).json({ 
        ok: false, 
        message: "START_DATE_MUST_BE_BEFORE_END_DATE" 
      });
    }

    if (data.branchIds !== undefined) {
      patch.branchIds = data.branchIds
        .filter(id => isValidObjectId(id))
        .map(id => new mongoose.Types.ObjectId(id));
    }

    if (data.tierIds !== undefined) {
      patch.tierIds = data.tierIds
        .filter(id => isValidObjectId(id))
        .map(id => new mongoose.Types.ObjectId(id));
    }

    patch.updatedBy = req.user._id;

    Object.assign(flashSale, patch);
    flashSale.updateStatus();
    await flashSale.save();

    res.json({ ok: true, flashSale });
  })
);

// ===============================
// POST /api/flashsales/:id/products - Thêm products vào flash sale
// ===============================
router.post(
  "/:id/products",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const flashSaleId = req.params.id;
    
    if (!isValidObjectId(flashSaleId)) {
      return res.status(400).json({ ok: false, message: "INVALID_FLASH_SALE_ID" });
    }

    const body = z.object({
      products: z.array(z.object({
        productId: z.string(),
        flashPrice: z.number().nonnegative(),
        discountPercent: z.number().min(0).max(100).optional(),
        limitedQuantity: z.number().nonnegative().optional().nullable(),
        maxPerCustomer: z.number().nonnegative().optional().nullable(),
        badge: z.string().optional(),
        order: z.number().optional()
      }))
    }).safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({ ok: false, error: body.error.flatten() });
    }

    const flashSale = await FlashSale.findById(flashSaleId);
    
    if (!flashSale) {
      return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });
    }

    const newProducts = body.data.products.map(p => ({
      productId: new mongoose.Types.ObjectId(p.productId),
      flashPrice: Math.round(p.flashPrice),
      discountPercent: p.discountPercent || 0,
      limitedQuantity: p.limitedQuantity || null,
      soldQuantity: 0,
      maxPerCustomer: p.maxPerCustomer || null,
      badge: p.badge || "",
      order: p.order || 0,
      isActive: true
    }));

    // Loại bỏ trùng lặp
    const existingIds = new Set(
      flashSale.products.map(p => String(p.productId))
    );

    const toAdd = newProducts.filter(
      p => !existingIds.has(String(p.productId))
    );

    flashSale.products.push(...toAdd);
    flashSale.updatedBy = req.user._id;
    await flashSale.save();

    res.json({ 
      ok: true, 
      added: toAdd.length,
      flashSale 
    });
  })
);

// ===============================
// PUT /api/flashsales/:id/products/:productId - Cập nhật product trong flash sale
// ===============================
router.put(
  "/:id/products/:productId",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const { id: flashSaleId, productId } = req.params;
    
    if (!isValidObjectId(flashSaleId) || !isValidObjectId(productId)) {
      return res.status(400).json({ ok: false, message: "INVALID_ID" });
    }

    const body = z.object({
      flashPrice: z.number().nonnegative().optional(),
      discountPercent: z.number().min(0).max(100).optional(),
      limitedQuantity: z.number().nonnegative().optional().nullable(),
      maxPerCustomer: z.number().nonnegative().optional().nullable(),
      badge: z.string().optional(),
      order: z.number().optional(),
      isActive: z.boolean().optional()
    }).safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({ ok: false, error: body.error.flatten() });
    }

    const flashSale = await FlashSale.findById(flashSaleId);
    
    if (!flashSale) {
      return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });
    }

    const productIndex = flashSale.products.findIndex(
      p => String(p.productId) === productId
    );

    if (productIndex === -1) {
      return res.status(404).json({ ok: false, message: "PRODUCT_NOT_IN_FLASH_SALE" });
    }

    const data = body.data;
    
    if (data.flashPrice !== undefined) {
      flashSale.products[productIndex].flashPrice = Math.round(data.flashPrice);
    }
    if (data.discountPercent !== undefined) {
      flashSale.products[productIndex].discountPercent = data.discountPercent;
    }
    if (data.limitedQuantity !== undefined) {
      flashSale.products[productIndex].limitedQuantity = data.limitedQuantity;
    }
    if (data.maxPerCustomer !== undefined) {
      flashSale.products[productIndex].maxPerCustomer = data.maxPerCustomer;
    }
    if (data.badge !== undefined) {
      flashSale.products[productIndex].badge = data.badge;
    }
    if (data.order !== undefined) {
      flashSale.products[productIndex].order = data.order;
    }
    if (data.isActive !== undefined) {
      flashSale.products[productIndex].isActive = data.isActive;
    }

    flashSale.updatedBy = req.user._id;
    await flashSale.save();

    res.json({ ok: true, flashSale });
  })
);

// ===============================
// DELETE /api/flashsales/:id/products/:productId - Xóa product khỏi flash sale
// ===============================
router.delete(
  "/:id/products/:productId",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const { id: flashSaleId, productId } = req.params;
    
    if (!isValidObjectId(flashSaleId) || !isValidObjectId(productId)) {
      return res.status(400).json({ ok: false, message: "INVALID_ID" });
    }

    const flashSale = await FlashSale.findById(flashSaleId);
    
    if (!flashSale) {
      return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });
    }

    const beforeCount = flashSale.products.length;
    
    flashSale.products = flashSale.products.filter(
      p => String(p.productId) !== productId
    );

    if (flashSale.products.length === beforeCount) {
      return res.status(404).json({ ok: false, message: "PRODUCT_NOT_IN_FLASH_SALE" });
    }

    flashSale.updatedBy = req.user._id;
    await flashSale.save();

    res.json({ ok: true, message: "PRODUCT_REMOVED", flashSale });
  })
);

// ===============================
// POST /api/flashsales/:id/activate - Kích hoạt flash sale
// ===============================
router.post(
  "/:id/activate",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const flashSaleId = req.params.id;
    
    if (!isValidObjectId(flashSaleId)) {
      return res.status(400).json({ ok: false, message: "INVALID_FLASH_SALE_ID" });
    }

    const flashSale = await FlashSale.findById(flashSaleId);
    
    if (!flashSale) {
      return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });
    }

    flashSale.isActive = true;
    flashSale.updateStatus();
    flashSale.updatedBy = req.user._id;
    await flashSale.save();

    // ✅ Sync flash sale info to products
    await syncFlashSaleToProducts(flashSale);

    res.json({ ok: true, flashSale });
  })
);

// ===============================
// POST /api/flashsales/:id/deactivate - Tắt flash sale
// ===============================
router.post(
  "/:id/deactivate",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const flashSaleId = req.params.id;
    
    if (!isValidObjectId(flashSaleId)) {
      return res.status(400).json({ ok: false, message: "INVALID_FLASH_SALE_ID" });
    }

    const flashSale = await FlashSale.findById(flashSaleId);
    
    if (!flashSale) {
      return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });
    }

    flashSale.isActive = false;
    flashSale.status = "CANCELLED";
    flashSale.updatedBy = req.user._id;
    await flashSale.save();

    // ✅ Remove flash sale info from products
    await Product.updateMany(
      { activeFlashSaleId: flashSale._id },
      {
        $set: {
          activeFlashSaleId: null,
          flashSalePrice: null,
          flashSaleStartDate: null,
          flashSaleEndDate: null
        }
      }
    );

    res.json({ ok: true, flashSale });
  })
);

// ===============================
// HELPER: Sync flash sale to products
// ===============================
async function syncFlashSaleToProducts(flashSale) {
  if (!flashSale.isCurrentlyActive) {
    return;
  }

  const bulkOps = flashSale.products
    .filter(p => p.isActive)
    .map(p => ({
      updateOne: {
        filter: { _id: p.productId },
        update: {
          $set: {
            activeFlashSaleId: flashSale._id,
            flashSalePrice: p.flashPrice,
            flashSaleStartDate: flashSale.startDate,
            flashSaleEndDate: flashSale.endDate
          }
        }
      }
    }));

  if (bulkOps.length > 0) {
    await Product.bulkWrite(bulkOps);
  }
}

module.exports = router;