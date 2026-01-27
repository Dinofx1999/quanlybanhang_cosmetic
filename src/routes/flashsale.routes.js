// src/routes/flashsale.routes.js
const router = require("express").Router();
const mongoose = require("mongoose");

const FlashSale = require("../models/FlashSale");
const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");

const { asyncHandler } = require("../utils/asyncHandler");
const { authRequired, requireRole } = require("../middlewares/auth");

function isValidObjectId(id) {
  return mongoose.isValidObjectId(String(id || ""));
}

// =====================================================
// PUBLIC: GET /:id/products
// Mount tại: /api/public/flash-sales
// => GET /api/public/flash-sales/:id/products
// =====================================================
router.get(
  "/:id/products",
  asyncHandler(async (req, res) => {
    const flashSaleId = req.params.id;

    if (!isValidObjectId(flashSaleId)) {
      return res.status(400).json({ ok: false, message: "INVALID_FLASH_SALE_ID" });
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const flashSale = await FlashSale.findById(flashSaleId).lean();
    if (!flashSale) return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });

    // Public: chỉ trả khi sale đang active + trong thời gian
    const now = new Date();
    const isPublicActive =
      flashSale.isActive === true &&
      String(flashSale.status || "").toUpperCase() === "ACTIVE" &&
      new Date(flashSale.startDate) <= now &&
      new Date(flashSale.endDate) >= now;

    if (!isPublicActive) {
      return res.json({
        ok: true,
        flashSale: {
          _id: flashSale._id,
          name: flashSale.name,
          code: flashSale.code,
          description: flashSale.description,
          startDate: flashSale.startDate,
          endDate: flashSale.endDate,
          banner: flashSale.banner,
        },
        items: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
      });
    }

    const activeFsVariants = (flashSale.variants || []).filter((v) => v && v.isActive !== false);

    const variantIds = activeFsVariants
      .map((v) => v.variantId)
      .filter((id) => isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (!variantIds.length) {
      return res.json({
        ok: true,
        flashSale: {
          _id: flashSale._id,
          name: flashSale.name,
          code: flashSale.code,
          description: flashSale.description,
          startDate: flashSale.startDate,
          endDate: flashSale.endDate,
          banner: flashSale.banner,
        },
        items: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
      });
    }

    // sort theo order trước, rồi paginate theo list này
    const sortedFs = [...activeFsVariants].sort((a, b) => (a.order || 0) - (b.order || 0));
    const pagedFs = sortedFs.slice(skip, skip + limit);

    const pagedVariantIds = pagedFs.map((v) => new mongoose.Types.ObjectId(v.variantId));

    const variants = await ProductVariant.find({ _id: { $in: pagedVariantIds } })
      .populate("productId", "name brand categoryName thumbnail images")
      .lean();

    const vMap = new Map(variants.map((v) => [String(v._id), v]));

    const items = pagedFs
      .map((fsVariant) => {
        const variant = vMap.get(String(fsVariant.variantId));
        if (!variant) return null;

        const product = variant.productId || {};
        const originalPrice = Number(variant.price || 0);
        const flashPrice = Number(fsVariant.flashPrice || 0);

        const discountAmount = originalPrice > 0 ? Math.max(0, originalPrice - flashPrice) : 0;
        const discountPercent =
          originalPrice > 0 ? Math.round((discountAmount / originalPrice) * 100) : 0;

        const soldQuantity = Number(fsVariant.soldQuantity || 0);
        const limitedQuantity =
          fsVariant.limitedQuantity === null || fsVariant.limitedQuantity === undefined
            ? null
            : Number(fsVariant.limitedQuantity);

        const remainingQuantity =
          limitedQuantity != null ? Math.max(0, limitedQuantity - soldQuantity) : null;

        return {
          _id: String(fsVariant._id || fsVariant.variantId), // id item trong flash sale
          productId: String(product._id || ""),
          productName: String(product.name || variant.name || ""),
          productBrand: String(product.brand || ""),
          productCategoryName: String(product.categoryName || ""),

          sku: variant.sku,
          name: variant.name,
          attributes: variant.attributes || [],

          originalPrice,
          flashPrice,
          discountPercent,
          discountAmount,

          thumbnail: variant.thumbnail || product.thumbnail || "",
          images:
            variant.images && variant.images.length
              ? variant.images
              : Array.isArray(product.images)
              ? product.images
              : [],

          badge: String(fsVariant.badge || "").trim(),
          limitedQuantity,
          soldQuantity,
          remainingQuantity,
        };
      })
      .filter(Boolean);

    const total = sortedFs.length;

    return res.json({
      ok: true,
      flashSale: {
        _id: flashSale._id,
        name: flashSale.name,
        code: flashSale.code,
        description: flashSale.description,
        startDate: flashSale.startDate,
        endDate: flashSale.endDate,
        banner: flashSale.banner,
      },
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  })
);

// ===============================
// ADMIN: GET /api/flashsales
// ===============================
router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const isActive = req.query.isActive !== undefined ? req.query.isActive === "true" : null;
    const q = String(req.query.q || "").trim();

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const query = {};
    if (status) query.status = status;
    if (isActive !== null) query.isActive = isActive;
    if (q) {
      query.$or = [
        { name: { $regex: q, $options: "i" } },
        { code: { $regex: q, $options: "i" } },
      ];
    }

    const [items, total] = await Promise.all([
      FlashSale.find(query).sort({ priority: -1, startDate: -1 }).skip(skip).limit(limit).lean(),
      FlashSale.countDocuments(query),
    ]);

    const itemsWithCount = items.map((fs) => ({
      ...fs,
      totalProducts: (fs.variants || []).filter((v) => v.isActive).length,
      totalVariants: (fs.variants || []).length,
    }));

    res.json({
      ok: true,
      items: itemsWithCount,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  })
);

// ===============================
// PUBLIC: GET /api/flashsales/active
// (nếu bạn mount router này ở public thì vẫn dùng được)
// ===============================
router.get(
  "/active",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const branchId = req.query.branchId || null;
    const tierId = req.query.tierId || null;

    const query = {
      isActive: true,
      status: "ACTIVE",
      startDate: { $lte: now },
      endDate: { $gte: now },
    };

    if (branchId && isValidObjectId(branchId)) {
      query.$or = [
        { branchIds: { $size: 0 } },
        { branchIds: new mongoose.Types.ObjectId(branchId) },
      ];
    }

    if (tierId && isValidObjectId(tierId)) {
      const existingOr = query.$or;
      if (existingOr) {
        query.$and = [
          { $or: existingOr },
          {
            $or: [
              { tierIds: { $size: 0 } },
              { tierIds: new mongoose.Types.ObjectId(tierId) },
            ],
          },
        ];
        delete query.$or;
      } else {
        query.$or = [
          { tierIds: { $size: 0 } },
          { tierIds: new mongoose.Types.ObjectId(tierId) },
        ];
      }
    }

    const items = await FlashSale.find(query).sort({ priority: -1, startDate: 1 }).lean();

    const itemsWithCount = items.map((fs) => ({
      _id: fs._id,
      name: fs.name,
      code: fs.code,
      description: fs.description,
      startDate: fs.startDate,
      endDate: fs.endDate,
      banner: fs.banner,
      images: fs.images,
      priority: fs.priority,
      totalProducts: (fs.variants || []).filter((v) => v.isActive).length,
    }));

    res.json({ ok: true, items: itemsWithCount, total: itemsWithCount.length });
  })
);

// ===============================
// ADMIN: GET /api/flashsales/:id (chi tiết)
// ===============================
router.get(
  "/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const flashSaleId = req.params.id;
    if (!isValidObjectId(flashSaleId)) {
      return res.status(400).json({ ok: false, message: "INVALID_FLASH_SALE_ID" });
    }

    const flashSale = await FlashSale.findById(flashSaleId).lean();
    if (!flashSale) return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });

    const variantIds = (flashSale.variants || [])
      .filter((v) => v.isActive)
      .map((v) => v.variantId);

    const variants = await ProductVariant.find({ _id: { $in: variantIds } })
      .populate("productId", "name brand categoryName thumbnail images")
      .lean();

    const variantMap = new Map();
    variants.forEach((v) => variantMap.set(String(v._id), v));

    const detailedVariants = (flashSale.variants || [])
      .filter((v) => v.isActive)
      .map((fsVariant) => {
        const variant = variantMap.get(String(fsVariant.variantId));
        if (!variant) return null;

        const product = variant.productId || {};
        const discountAmount = Number(variant.price || 0) - Number(fsVariant.flashPrice || 0);
        const discountPercent =
          Number(variant.price || 0) > 0
            ? Math.round((discountAmount / Number(variant.price || 0)) * 100)
            : 0;

        return {
          variantId: variant._id,
          productId: product._id,
          productName: product.name,
          productBrand: product.brand || "",
          categoryName: product.categoryName || "",

          sku: variant.sku,
          name: variant.name,
          attributes: variant.attributes || [],

          originalPrice: variant.price,
          flashPrice: fsVariant.flashPrice,
          discountPercent,
          discountAmount,

          thumbnail: variant.thumbnail || product.thumbnail || "",
          images:
            variant.images && variant.images.length > 0 ? variant.images : product.images || [],

          badge: fsVariant.badge || "",
          limitedQuantity: fsVariant.limitedQuantity,
          soldQuantity: fsVariant.soldQuantity || 0,
          remainingQuantity: fsVariant.limitedQuantity
            ? Math.max(0, fsVariant.limitedQuantity - (fsVariant.soldQuantity || 0))
            : null,
          maxPerCustomer: fsVariant.maxPerCustomer,
          order: fsVariant.order || 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    res.json({
      ok: true,
      flashSale: { ...flashSale, totalVariants: detailedVariants.length, variants: detailedVariants },
    });
  })
);

// ===============================
// ADMIN: POST /api/flashsales (tạo)
// ===============================
router.post(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const {
      name,
      code,
      description,
      startDate,
      endDate,
      variants,
      banner,
      images,
      branchIds,
      tierIds,
      priority,
      status,
    } = req.body;

    if (!name || !code || !startDate || !endDate) {
      return res.status(400).json({ ok: false, message: "MISSING_REQUIRED_FIELDS" });
    }

    const existing = await FlashSale.findOne({ code: String(code).toUpperCase() });
    if (existing) return res.status(400).json({ ok: false, message: "CODE_ALREADY_EXISTS" });

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (end <= start) {
      return res.status(400).json({ ok: false, message: "END_DATE_MUST_BE_AFTER_START_DATE" });
    }

    const validatedVariants = [];
    if (Array.isArray(variants)) {
      for (const v of variants) {
        if (!v.variantId || !isValidObjectId(v.variantId)) continue;

        const variant = await ProductVariant.findById(v.variantId);
        if (!variant) continue;

        let discountPercent = Number(v.discountPercent) || 0;
        if (discountPercent === 0 && Number(variant.price || 0) > 0) {
          discountPercent = Math.round(
            ((Number(variant.price || 0) - Number(v.flashPrice || 0)) / Number(variant.price || 0)) * 100
          );
        }

        validatedVariants.push({
          variantId: new mongoose.Types.ObjectId(v.variantId),
          flashPrice: Number(v.flashPrice) || 0,
          discountPercent: Math.max(0, Math.min(100, discountPercent)),
          limitedQuantity: v.limitedQuantity ? Number(v.limitedQuantity) : null,
          soldQuantity: 0,
          maxPerCustomer: v.maxPerCustomer ? Number(v.maxPerCustomer) : null,
          isActive: v.isActive !== false,
          order: Number(v.order) || 0,
          badge: String(v.badge || "").trim(),
        });
      }
    }

    const flashSale = new FlashSale({
      name: String(name).trim(),
      code: String(code).toUpperCase().trim(),
      description: String(description || "").trim(),
      startDate: start,
      endDate: end,
      variants: validatedVariants,
      banner: String(banner || "").trim(),
      images: Array.isArray(images) ? images : [],
      branchIds: Array.isArray(branchIds)
        ? branchIds.filter(isValidObjectId).map((id) => new mongoose.Types.ObjectId(id))
        : [],
      tierIds: Array.isArray(tierIds)
        ? tierIds.filter(isValidObjectId).map((id) => new mongoose.Types.ObjectId(id))
        : [],
      priority: Number(priority) || 0,
      status: status || "DRAFT",
      isActive: true,
      createdBy: req.user.sub,
      updatedBy: req.user.sub,
    });

    flashSale.updateStatus && flashSale.updateStatus();

    await flashSale.save();

    if (flashSale.status === "ACTIVE") {
      await syncFlashSaleToProductsAndVariants(flashSale);
    }

    res.status(201).json({ ok: true, message: "FLASH_SALE_CREATED", flashSale });
  })
);

// ===============================
// ADMIN: PUT /api/flashsales/:id (update)
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

    const flashSale = await FlashSale.findById(flashSaleId);
    if (!flashSale) return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });

    const {
      name,
      code,
      description,
      startDate,
      endDate,
      variants,
      banner,
      images,
      branchIds,
      tierIds,
      priority,
      status,
      isActive,
    } = req.body;

    if (name) flashSale.name = String(name).trim();

    if (code) {
      const codeUpper = String(code).toUpperCase().trim();
      if (codeUpper !== flashSale.code) {
        const existing = await FlashSale.findOne({ code: codeUpper, _id: { $ne: flashSaleId } });
        if (existing) return res.status(400).json({ ok: false, message: "CODE_ALREADY_EXISTS" });
        flashSale.code = codeUpper;
      }
    }

    if (description !== undefined) flashSale.description = String(description).trim();
    if (startDate) flashSale.startDate = new Date(startDate);
    if (endDate) flashSale.endDate = new Date(endDate);

    if (flashSale.endDate <= flashSale.startDate) {
      return res.status(400).json({ ok: false, message: "END_DATE_MUST_BE_AFTER_START_DATE" });
    }

    if (banner !== undefined) flashSale.banner = String(banner).trim();
    if (Array.isArray(images)) flashSale.images = images;
    if (priority !== undefined) flashSale.priority = Number(priority) || 0;
    if (status) flashSale.status = status;
    if (isActive !== undefined) flashSale.isActive = isActive;

    if (Array.isArray(branchIds)) {
      flashSale.branchIds = branchIds.filter(isValidObjectId).map((id) => new mongoose.Types.ObjectId(id));
    }

    if (Array.isArray(tierIds)) {
      flashSale.tierIds = tierIds.filter(isValidObjectId).map((id) => new mongoose.Types.ObjectId(id));
    }

    if (Array.isArray(variants)) {
      const validatedVariants = [];
      for (const v of variants) {
        if (!v.variantId || !isValidObjectId(v.variantId)) continue;
        const variant = await ProductVariant.findById(v.variantId);
        if (!variant) continue;

        validatedVariants.push({
          variantId: new mongoose.Types.ObjectId(v.variantId),
          flashPrice: Number(v.flashPrice) || 0,
          discountPercent: Number(v.discountPercent) || 0,
          limitedQuantity: v.limitedQuantity ? Number(v.limitedQuantity) : null,
          soldQuantity: Number(v.soldQuantity) || 0,
          maxPerCustomer: v.maxPerCustomer ? Number(v.maxPerCustomer) : null,
          isActive: v.isActive !== false,
          order: Number(v.order) || 0,
          badge: String(v.badge || "").trim(),
        });
      }
      flashSale.variants = validatedVariants;
    }

    flashSale.updatedBy = req.user.sub;
    await flashSale.save();

    if (flashSale.status === "ACTIVE") await syncFlashSaleToProductsAndVariants(flashSale);
    else await clearFlashSaleFromProductsAndVariants(flashSaleId);

    res.json({ ok: true, message: "FLASH_SALE_UPDATED", flashSale });
  })
);

// ===============================
// ADMIN: POST /:id/variants (UPSERT add/update variants)
// ===============================
router.post(
  "/:id/variants",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const flashSaleId = req.params.id;
    if (!isValidObjectId(flashSaleId)) {
      return res.status(400).json({ ok: false, message: "INVALID_FLASH_SALE_ID" });
    }

    const { variants } = req.body;
    if (!Array.isArray(variants) || variants.length === 0) {
      return res.status(400).json({ ok: false, message: "VARIANTS_REQUIRED" });
    }

    const flashSale = await FlashSale.findById(flashSaleId);
    if (!flashSale) return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });

    const existing = new Map((flashSale.variants || []).map((v) => [String(v.variantId), v]));

    const inputIds = variants
      .map((v) => String(v?.variantId || ""))
      .filter((id) => isValidObjectId(id));

    if (inputIds.length === 0) {
      return res.status(400).json({ ok: false, message: "NO_VALID_VARIANT_IDS" });
    }

    const dbVariants = await ProductVariant.find({ _id: { $in: inputIds } }).select("_id price").lean();
    const dbMap = new Map(dbVariants.map((v) => [String(v._id), v]));

    let added = 0;
    let updated = 0;

    for (const v of variants) {
      const vid = String(v?.variantId || "");
      if (!isValidObjectId(vid)) continue;

      const dbv = dbMap.get(vid);
      if (!dbv) continue;

      const flashPrice = Number(v.flashPrice) || 0;
      if (flashPrice <= 0) continue;

      let discountPercent = Number(v.discountPercent) || 0;
      if (!discountPercent && Number(dbv.price || 0) > 0) {
        discountPercent = Math.round(((Number(dbv.price) - flashPrice) / Number(dbv.price)) * 100);
      }
      discountPercent = Math.max(0, Math.min(100, discountPercent));

      const patch = {
        variantId: new mongoose.Types.ObjectId(vid),
        flashPrice,
        discountPercent,
        limitedQuantity: v.limitedQuantity != null ? Number(v.limitedQuantity) : null,
        soldQuantity: 0,
        maxPerCustomer: v.maxPerCustomer != null ? Number(v.maxPerCustomer) : null,
        isActive: v.isActive !== false,
        order: Number(v.order) || 0,
        badge: String(v.badge || "").trim(),
      };

      const exists = existing.get(vid);
      if (exists) {
        exists.flashPrice = patch.flashPrice;
        exists.discountPercent = patch.discountPercent;
        exists.limitedQuantity = patch.limitedQuantity;
        exists.maxPerCustomer = patch.maxPerCustomer;
        exists.isActive = patch.isActive;
        exists.order = patch.order;
        exists.badge = patch.badge;
        updated++;
      } else {
        flashSale.variants = flashSale.variants || [];
        flashSale.variants.push(patch);
        added++;
      }
    }

    flashSale.variants = (flashSale.variants || []).sort((a, b) => (a.order || 0) - (b.order || 0));
    flashSale.updatedBy = req.user.sub;
    await flashSale.save();

    if (flashSale.status === "ACTIVE") await syncFlashSaleToProductsAndVariants(flashSale);

    res.json({
      ok: true,
      message: "FLASH_SALE_VARIANTS_UPSERTED",
      added,
      updated,
      totalVariants: (flashSale.variants || []).length,
    });
  })
);

// ===============================
// ADMIN: DELETE /:id/variants/:variantId (xoá hẳn)
// ===============================
router.delete(
  "/:id/variants/:variantId",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const { id: flashSaleId, variantId } = req.params;

    if (!isValidObjectId(flashSaleId) || !isValidObjectId(variantId)) {
      return res.status(400).json({ ok: false, message: "INVALID_ID" });
    }

    const flashSale = await FlashSale.findById(flashSaleId);
    if (!flashSale) return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });

    const beforeCount = (flashSale.variants || []).length;

    flashSale.variants = (flashSale.variants || []).filter(
      (v) => String(v.variantId) !== String(variantId)
    );

    if (flashSale.variants.length === beforeCount) {
      return res.status(404).json({ ok: false, message: "VARIANT_NOT_IN_FLASH_SALE" });
    }

    flashSale.updatedBy = req.user.sub;
    await flashSale.save();

    // clear variant flash fields
    await ProductVariant.updateOne(
      { _id: new mongoose.Types.ObjectId(variantId) },
      {
        $set: {
          activeFlashSaleId: null,
          flashSalePrice: null,
          flashSaleStartDate: null,
          flashSaleEndDate: null,
        },
      }
    );

    // re-sync product min price if needed
    if (flashSale.status === "ACTIVE") {
      const v = await ProductVariant.findById(variantId).select("productId").lean();
      if (v?.productId) {
        const now = new Date();

        const productVariants = await ProductVariant.find({
          productId: v.productId,
          isActive: true,
          activeFlashSaleId: flashSale._id,
          flashSaleEndDate: { $gte: now },
        }).lean();

        if (!productVariants.length) {
          await Product.updateOne(
            { _id: v.productId },
            {
              $set: {
                activeFlashSaleId: null,
                flashSalePrice: null,
                flashSaleStartDate: null,
                flashSaleEndDate: null,
              },
            }
          );
        } else {
          const minFlashPrice = Math.min(...productVariants.map((x) => x.flashSalePrice || x.price));
          await Product.updateOne(
            { _id: v.productId },
            { $set: { flashSalePrice: minFlashPrice } }
          );
        }
      }
    }

    res.json({
      ok: true,
      message: "FLASH_SALE_VARIANT_REMOVED",
      flashSaleId,
      variantId,
      totalVariants: (flashSale.variants || []).length,
    });
  })
);

// ===============================
// ADMIN: DELETE /api/flashsales/:id (xoá flashsale)
// ===============================
router.delete(
  "/:id",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const flashSaleId = req.params.id;
    if (!isValidObjectId(flashSaleId)) {
      return res.status(400).json({ ok: false, message: "INVALID_FLASH_SALE_ID" });
    }

    const flashSale = await FlashSale.findById(flashSaleId);
    if (!flashSale) return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });

    await clearFlashSaleFromProductsAndVariants(flashSaleId);
    await flashSale.deleteOne();

    res.json({ ok: true, message: "FLASH_SALE_DELETED" });
  })
);

// ===============================
// ADMIN: activate / deactivate
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
    if (!flashSale) return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });

    flashSale.status = "ACTIVE";
    flashSale.isActive = true;
    flashSale.updatedBy = req.user.sub;
    await flashSale.save();

    await syncFlashSaleToProductsAndVariants(flashSale);

    res.json({ ok: true, message: "FLASH_SALE_ACTIVATED", flashSale });
  })
);

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
    if (!flashSale) return res.status(404).json({ ok: false, message: "FLASH_SALE_NOT_FOUND" });

    flashSale.status = "CANCELLED";
    flashSale.isActive = false;
    flashSale.updatedBy = req.user.sub;
    await flashSale.save();

    await clearFlashSaleFromProductsAndVariants(flashSaleId);

    res.json({ ok: true, message: "FLASH_SALE_DEACTIVATED", flashSale });
  })
);

// =====================================================
// Helpers sync/clear
// =====================================================
async function syncFlashSaleToProductsAndVariants(flashSale) {
  const now = new Date();

  if (
    String(flashSale.status || "").toUpperCase() !== "ACTIVE" ||
    !flashSale.isActive ||
    flashSale.startDate > now ||
    flashSale.endDate < now
  ) {
    return;
  }

  const variantIds = (flashSale.variants || [])
    .filter((v) => v.isActive)
    .map((v) => v.variantId);

  if (!variantIds.length) return;

  for (const fsVariant of flashSale.variants || []) {
    if (!fsVariant.isActive) continue;

    await ProductVariant.updateOne(
      { _id: fsVariant.variantId },
      {
        $set: {
          activeFlashSaleId: flashSale._id,
          flashSalePrice: fsVariant.flashPrice,
          flashSaleStartDate: flashSale.startDate,
          flashSaleEndDate: flashSale.endDate,
        },
      }
    );
  }

  const variants = await ProductVariant.find({ _id: { $in: variantIds } })
    .select("productId flashSalePrice price activeFlashSaleId flashSaleEndDate")
    .lean();

  const productIds = [...new Set(variants.map((v) => String(v.productId)))];

  for (const productId of productIds) {
    const productVariants = await ProductVariant.find({
      productId: new mongoose.Types.ObjectId(productId),
      isActive: true,
    }).lean();

    const flashPrices = productVariants
      .filter((v) => v.activeFlashSaleId && v.flashSaleEndDate >= now)
      .map((v) => v.flashSalePrice || v.price);

    if (flashPrices.length > 0) {
      const minFlashPrice = Math.min(...flashPrices);
      await Product.updateOne(
        { _id: new mongoose.Types.ObjectId(productId) },
        {
          $set: {
            activeFlashSaleId: flashSale._id,
            flashSalePrice: minFlashPrice,
            flashSaleStartDate: flashSale.startDate,
            flashSaleEndDate: flashSale.endDate,
          },
        }
      );
    }
  }
}

async function clearFlashSaleFromProductsAndVariants(flashSaleId) {
  await ProductVariant.updateMany(
    { activeFlashSaleId: new mongoose.Types.ObjectId(flashSaleId) },
    {
      $set: {
        activeFlashSaleId: null,
        flashSalePrice: null,
        flashSaleStartDate: null,
        flashSaleEndDate: null,
      },
    }
  );

  await Product.updateMany(
    { activeFlashSaleId: new mongoose.Types.ObjectId(flashSaleId) },
    {
      $set: {
        activeFlashSaleId: null,
        flashSalePrice: null,
        flashSaleStartDate: null,
        flashSaleEndDate: null,
      },
    }
  );
}

// Auto update (optional)
async function autoUpdateFlashSaleStatus() {
  try {
    const flashSales = await FlashSale.find({
      isActive: true,
      status: { $in: ["SCHEDULED", "ACTIVE"] },
    });

    for (const fs of flashSales) {
      const oldStatus = fs.status;
      fs.updateStatus && fs.updateStatus();

      if (oldStatus !== fs.status) {
        await fs.save();

        if (fs.status === "ACTIVE") await syncFlashSaleToProductsAndVariants(fs);
        else if (fs.status === "ENDED") await clearFlashSaleFromProductsAndVariants(fs._id);
      }
    }
  } catch (error) {
    console.error("Auto update flash sale status error:", error);
  }
}

setInterval(autoUpdateFlashSaleStatus, 60 * 1000);

module.exports = router;
