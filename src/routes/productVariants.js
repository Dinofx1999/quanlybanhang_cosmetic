// routes/productVariants.js
const router = require("express").Router();
const mongoose = require("mongoose");
const { z } = require("zod");

const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");

// Optional: nếu bạn có VariantStock thì bật lên ở dưới
// const VariantStock = require("../models/VariantStock");

const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

// ===============================
// Helpers
// ===============================
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id || "").trim());
const toObjectId = (id) => new mongoose.Types.ObjectId(String(id || "").trim());

// ===============================
// GET /api/product-variants?productId=...
// ✅ BASIC LIST (không join stock) để nhập kho luôn đúng
// ===============================
router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const productId = String(req.query.productId || "").trim();
    if (!productId) return res.status(400).json({ ok: false, message: "MISSING_PRODUCT_ID" });
    if (!isValidObjectId(productId)) return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });

    // đảm bảo product tồn tại (tránh trả list rỗng gây hiểu nhầm)
    const p = await Product.findById(toObjectId(productId)).select("_id isActive").lean();
    if (!p || p.isActive === false) {
      return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });
    }

    const items = await ProductVariant.find({
      productId: toObjectId(productId),
      isActive: { $ne: false },
    })
      .sort({ isDefault: -1, createdAt: 1 })
      .lean();

    return res.json({
      ok: true,
      productId,
      total: items.length,
      items: items.map((v) => ({
        _id: String(v._id),
        productId: String(v.productId),
        isDefault: !!v.isDefault,
        sku: v.sku || "",
        barcode: v.barcode || "",
        name: v.name || "",
        attributes: Array.isArray(v.attributes) ? v.attributes : [],
        price: Number(v.price || 0),
        cost: Number(v.cost || 0),
        price_tier: Array.isArray(v.price_tier) ? v.price_tier : [],
        thumbnail: v.thumbnail || "",
        images: Array.isArray(v.images) ? v.images : [],
        isActive: v.isActive !== false,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      })),
    });
  })
);

// ===============================
// POST /api/product-variants/default
// Tạo variant mặc định nếu product chưa có variant
// ===============================
router.post(
  "/default",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        productId: z.string().min(1),
        // branchId: z.string().optional(), // nếu bạn muốn tạo stock record
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const productIdRaw = String(body.data.productId || "").trim();
    if (!isValidObjectId(productIdRaw)) return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });

    const productId = toObjectId(productIdRaw);

    // ✅ dùng findById chắc chắn, tránh mismatch string
    const p = await Product.findById(productId).lean();
    if (!p || p.isActive === false) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    // 1) Nếu đã có variant isDefault -> trả về
    const existedDefault = await ProductVariant.findOne({
      productId: p._id,
      isDefault: true,
      isActive: { $ne: false },
    })
      .sort({ createdAt: 1 })
      .lean();

    if (existedDefault) {
      // (tuỳ chọn) nếu Product có defaultVariantId thì update
      try {
        await Product.updateOne({ _id: p._id }, { $set: { defaultVariantId: existedDefault._id, hasVariants: true } });
      } catch (_e) {}

      return res.json({ ok: true, reused: true, variant: existedDefault });
    }

    // 2) Nếu có variant nhưng chưa có default -> lấy cái đầu tiên làm default
    const existedAny = await ProductVariant.findOne({
      productId: p._id,
      isActive: { $ne: false },
    })
      .sort({ createdAt: 1 })
      .lean();

    if (existedAny) {
      await ProductVariant.updateOne({ _id: existedAny._id }, { $set: { isDefault: true } });

      try {
        await Product.updateOne({ _id: p._id }, { $set: { defaultVariantId: existedAny._id, hasVariants: true } });
      } catch (_e) {}

      const v2 = await ProductVariant.findById(existedAny._id).lean();
      return res.json({ ok: true, patched: true, variant: v2 });
    }

    // 3) Không có variant nào -> tạo default variant mới
    const baseSku = String(p.sku || "").trim().toUpperCase() || String(p._id).slice(-6).toUpperCase();
    const defaultSku = `${baseSku}-DEFAULT`;

    let finalSku = defaultSku;
    const conflict = await ProductVariant.findOne({ sku: finalSku }).lean();
    if (conflict) finalSku = `${defaultSku}-${Date.now()}`;

    const created = await ProductVariant.create({
      productId: p._id,
      isDefault: true,

      sku: finalSku,
      barcode: "",

      name: String(p.name || "").trim() || "Variant mặc định",
      attributes: [],

      price: Number(p.price || 0),
      cost: Number(p.cost || 0),

      price_tier: Array.isArray(p.price_tier) ? p.price_tier : [],
      thumbnail: p.thumbnail || "",
      images: Array.isArray(p.images) ? p.images : [],

      isActive: true,
      createdById: req.user?.sub, // nếu schema variant không có field này cũng không sao (mongoose sẽ ignore)
    });

    // ✅ update Product: hasVariants + defaultVariantId
    try {
      await Product.updateOne(
        { _id: p._id },
        { $set: { hasVariants: true, defaultVariantId: created._id } }
      );
    } catch (_e) {}

    return res.json({ ok: true, created: true, variant: created.toObject() });
  })
);

module.exports = router;
