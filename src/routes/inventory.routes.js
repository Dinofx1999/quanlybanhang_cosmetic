// src/routes/inventory.routes.js
const router = require("express").Router();
const mongoose = require("mongoose");

const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");
const VariantStock = require("../models/VariantStock");

const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

// ---------------- helpers
const isValidObjectId = (v) => mongoose.isValidObjectId(String(v || ""));
const toObjId = (v) => new mongoose.Types.ObjectId(String(v));

function int(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return 0;
  return Math.trunc(x);
}

// ✅ bảo đảm product luôn có defaultVariantId
async function ensureDefaultVariantForProduct(productId) {
  const p = await Product.findById(productId).select("_id sku name price cost price_tier thumbnail images isActive defaultVariantId").lean();
  if (!p || p.isActive === false) {
    const err = new Error("PRODUCT_NOT_FOUND");
    err.code = "PRODUCT_NOT_FOUND";
    throw err;
  }

  // đã có defaultVariantId -> verify
  if (p.defaultVariantId && isValidObjectId(p.defaultVariantId)) {
    const v0 = await ProductVariant.findById(p.defaultVariantId).lean();
    if (v0 && v0.isActive !== false) return v0;
  }

  // tìm variant default hợp lý: isDefault true ưu tiên, rồi attributes rỗng, rồi tạo mới
  let v =
    (await ProductVariant.findOne({ productId: p._id, isActive: true }).sort({ isDefault: -1, createdAt: 1 }).lean()) ||
    null;

  if (!v) {
    const baseSku = String(p.sku || "").trim().toUpperCase() || String(p._id).slice(-6).toUpperCase();
    const defaultSku = `${baseSku}-DEFAULT`;

    let finalSku = defaultSku;
    const skuConflict = await ProductVariant.findOne({ sku: finalSku }).lean();
    if (skuConflict) finalSku = `${defaultSku}-${Date.now()}`;

    const created = await ProductVariant.create({
      productId: p._id,
      isDefault: true,
      sku: finalSku,
      barcode: "",
      name: String(p.name || "").trim() || "Variant mặc định",
      attributes: [],

      price: Math.round(Number(p.price || 0)),
      cost: Math.round(Number(p.cost || 0)),
      price_tier: Array.isArray(p.price_tier) ? p.price_tier : [],

      thumbnail: p.thumbnail || "",
      images: Array.isArray(p.images) ? p.images : [],

      isActive: true,
    });

    v = created.toObject();
  }

  // set defaultVariantId + hasVariants cho product
  await Product.updateOne(
    { _id: p._id },
    {
      $set: {
        defaultVariantId: v._id,
        hasVariants: true,
      },
    }
  );

  return v;
}

async function resolveVariantIdFromParams({ productId, variantId }) {
  if (variantId) {
    if (!isValidObjectId(variantId)) {
      const err = new Error("INVALID_VARIANT_ID");
      err.code = "INVALID_VARIANT_ID";
      throw err;
    }
    const v = await ProductVariant.findById(variantId).select("_id productId isActive").lean();
    if (!v || v.isActive === false) {
      const err = new Error("VARIANT_NOT_FOUND");
      err.code = "VARIANT_NOT_FOUND";
      throw err;
    }
    if (productId && String(v.productId) !== String(productId)) {
      const err = new Error("VARIANT_PRODUCT_MISMATCH");
      err.code = "VARIANT_PRODUCT_MISMATCH";
      throw err;
    }
    return v._id;
  }

  if (!productId || !isValidObjectId(productId)) {
    const err = new Error("INVALID_PRODUCT_ID");
    err.code = "INVALID_PRODUCT_ID";
    throw err;
  }

  const dv = await ensureDefaultVariantForProduct(productId);
  return dv._id;
}

// ======================================================
// ✅ SET STOCK (đặt tồn kho = quantity) theo productId/defaultVariantId
// PUT /api/inventory/:branchId/:productId  { quantity }
// (giữ nguyên URL để frontend khỏi sửa)
// ======================================================
router.put(
  "/:branchId/:productId",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const { branchId, productId } = req.params;
    if (!isValidObjectId(branchId) || !isValidObjectId(productId)) {
      return res.status(400).json({ ok: false, message: "INVALID_ID" });
    }

    const quantity = int(req.body.quantity);
    if (quantity < 0) return res.status(400).json({ ok: false, message: "INVALID_QTY" });

    // resolve to variantId (default)
    const variantId = await resolveVariantIdFromParams({ productId: toObjId(productId), variantId: null });

    // set qty theo variant stock
    const doc = await VariantStock.findOneAndUpdate(
      { branchId: toObjId(branchId), variantId: toObjId(variantId) },
      { $set: { qty: quantity }, $setOnInsert: { reserved: 0 } },
      { upsert: true, new: true }
    ).lean();

    res.json({
      ok: true,
      branchId: String(branchId),
      productId: String(productId),
      variantId: String(variantId),
      stock: doc,
    });
  })
);

// ======================================================
// ✅ ADJUST STOCK (cộng/trừ tồn kho) theo variantId hoặc productId
// POST /api/inventory/adjust  { branchId, productId?, variantId?, delta, note? }
// ======================================================
router.post(
  "/adjust",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const branchId = String(req.body.branchId || "");
    const productId = req.body.productId ? String(req.body.productId) : null;
    const variantIdRaw = req.body.variantId ? String(req.body.variantId) : null;

    if (!isValidObjectId(branchId)) return res.status(400).json({ ok: false, message: "INVALID_BRANCH_ID" });

    const delta = int(req.body.delta);
    if (!delta) return res.status(400).json({ ok: false, message: "DELTA_REQUIRED" });

    const resolvedVariantId = await resolveVariantIdFromParams({
      productId: productId ? toObjId(productId) : null,
      variantId: variantIdRaw ? toObjId(variantIdRaw) : null,
    });

    const note = String(req.body.note || "").trim();

    const doc = await VariantStock.findOneAndUpdate(
      { branchId: toObjId(branchId), variantId: toObjId(resolvedVariantId) },
      {
        $inc: { qty: delta },
        $set: note ? { note } : {},
        $setOnInsert: { reserved: 0 },
      },
      { upsert: true, new: true }
    ).lean();

    res.json({
      ok: true,
      branchId,
      productId,
      variantId: String(resolvedVariantId),
      stock: doc,
    });
  })
);

module.exports = router;
