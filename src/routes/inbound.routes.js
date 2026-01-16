// src/routes/inbounds.routes.js
const router = require("express").Router();
const { z } = require("zod");
const mongoose = require("mongoose");

const GoodsReceipt = require("../models/GoodsReceipt");
const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");
const VariantStock = require("../models/VariantStock"); // ✅ IMPORTANT: use variant stock

const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const { genReceiptCode } = require("../utils/code");

// ----------------- helpers
const isValidObjectId = (v) => mongoose.isValidObjectId(String(v || ""));
const toObjId = (v) => new mongoose.Types.ObjectId(String(v));

function moneyInt(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x);
}

async function ensureDefaultVariantForProduct(productId) {
  const p = await Product.findById(productId)
    .select("_id sku name price cost price_tier thumbnail images isActive defaultVariantId")
    .lean();

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

  // ưu tiên variant isDefault
  let v = await ProductVariant.findOne({ productId: p._id, isActive: true })
    .sort({ isDefault: -1, createdAt: 1 })
    .lean();

  if (!v) {
    const baseSku = String(p.sku || "").trim().toUpperCase() || String(p._id).slice(-6).toUpperCase();
    const defaultSku = `${baseSku}-DEFAULT`;

    // phòng conflict sku global (nếu bạn có index sku global)
    let finalSku = defaultSku;
    const skuConflict = await ProductVariant.findOne({ sku: finalSku }).lean();
    if (skuConflict) finalSku = `${defaultSku}-${Date.now()}`;

    const created = await ProductVariant.create({
      productId: p._id,
      isDefault: true,
      sku: finalSku,
      barcode: "",
      name: p.name || "",
      attributes: [],
      price: Number(p.price || 0),
      cost: Number(p.cost || 0),
      price_tier: Array.isArray(p.price_tier) ? p.price_tier : [],
      thumbnail: p.thumbnail || "",
      images: Array.isArray(p.images) ? p.images : [],
      isActive: true,
    });

    v = created.toObject();
  }

  // ✅ set defaultVariantId + hasVariants
  await Product.updateOne(
    { _id: p._id },
    { $set: { defaultVariantId: v._id, hasVariants: true } }
  );

  return v;
}

async function pickVariantForInbound({ productId, variantId }) {
  // if variantId provided -> validate it belongs to productId
  if (variantId) {
    const v = await ProductVariant.findById(variantId)
      .select("_id productId sku name attributes isActive cost")
      .lean();

    if (!v || v.isActive === false) {
      const err = new Error("VARIANT_NOT_FOUND");
      err.code = "VARIANT_NOT_FOUND";
      throw err;
    }
    if (String(v.productId) !== String(productId)) {
      const err = new Error("VARIANT_PRODUCT_MISMATCH");
      err.code = "VARIANT_PRODUCT_MISMATCH";
      throw err;
    }
    return v;
  }

  // variantId not provided: find any active variants of product
  const variants = await ProductVariant.find({ productId, isActive: true })
    .select("_id sku name attributes cost")
    .sort({ sku: 1 })
    .lean();

  if (variants.length > 0) {
    // ✅ choose best default: attributes empty first, else first
    const emptyAttr = variants.find((x) => !x.attributes || x.attributes.length === 0);
    return emptyAttr || variants[0];
  }

  // no variants in DB -> ensure default variant
  const v = await ensureDefaultVariantForProduct(productId);
  return v;
}

// ----------------- routes

/**
 * POST /api/inbounds
 * Create DRAFT receipt - NOT add stock yet
 * items: [{ productId, variantId?, qty, cost }]
 */
router.post(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        branchId: z.string(),
        supplier: z.string().optional(),
        note: z.string().optional(),
        clientMutationId: z.string().optional(),
        items: z
          .array(
            z.object({
              productId: z.string(),
              variantId: z.string().optional(), // ✅ NEW
              qty: z.number().int().positive(),
              cost: z.number().int().nonnegative(),
            })
          )
          .min(1),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const data = body.data;

    // validate branchId
    if (!isValidObjectId(data.branchId)) return res.status(400).json({ ok: false, message: "INVALID_BRANCH_ID" });

    // dedupe
    if (data.clientMutationId) {
      const existed = await GoodsReceipt.findOne({ clientMutationId: data.clientMutationId }).lean();
      if (existed) return res.json({ ok: true, receipt: existed, deduped: true });
    }

    // validate productIds
    for (const it of data.items) {
      if (!isValidObjectId(it.productId)) return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });
      if (it.variantId && !isValidObjectId(it.variantId)) {
        return res.status(400).json({ ok: false, message: "INVALID_VARIANT_ID" });
      }
    }

    // load products snapshot
    const productIds = [...new Set(data.items.map((i) => String(i.productId)))];
    const products = await Product.find({ _id: { $in: productIds }, isActive: true })
      .select("_id sku name isActive")
      .lean();

    const mapP = new Map(products.map((p) => [String(p._id), p]));
    if (products.length !== productIds.length) {
      return res.status(400).json({ ok: false, message: "Có productId không tồn tại / không active" });
    }

    // build receipt items with variant resolution + snapshot
    const receiptItems = [];
    for (const raw of data.items) {
      const pid = String(raw.productId);
      const p = mapP.get(pid);
      if (!p) return res.status(400).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

      const resolvedVariant = await pickVariantForInbound({
        productId: toObjId(pid),
        variantId: raw.variantId ? toObjId(raw.variantId) : null,
      });

      const qty = moneyInt(raw.qty);
      const cost = moneyInt(raw.cost);
      const total = moneyInt(qty * cost);

      receiptItems.push({
        productId: toObjId(pid),
        variantId: resolvedVariant?._id ? toObjId(resolvedVariant._id) : null,

        sku: String(p.sku || ""),
        name: String(p.name || ""),

        variantSku: String(resolvedVariant?.sku || ""),
        variantName: String(resolvedVariant?.name || ""),
        attributes: Array.isArray(resolvedVariant?.attributes) ? resolvedVariant.attributes : [],

        qty,
        cost,
        total,
      });
    }

    const subtotal = moneyInt(receiptItems.reduce((s, it) => s + Number(it.total || 0), 0));

    const receipt = await GoodsReceipt.create({
      code: genReceiptCode("GR"),
      branchId: toObjId(data.branchId),
      supplier: data.supplier || "",
      note: data.note || "",
      status: "DRAFT",
      items: receiptItems,
      subtotal,
      createdById: req.user.sub || null,
      clientMutationId: data.clientMutationId || undefined,
    });

    res.json({ ok: true, receipt: receipt.toObject() });
  })
);

/**
 * GET /api/inbounds
 */
router.get(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const branchId = String(req.query.branchId || "").trim();
    const status = String(req.query.status || "").trim();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const filter = {};
    if (branchId) {
      if (!isValidObjectId(branchId)) return res.status(400).json({ ok: false, message: "INVALID_BRANCH_ID" });
      filter.branchId = toObjId(branchId);
    }
    if (status) filter.status = status;

    const [items, total] = await Promise.all([
      GoodsReceipt.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      GoodsReceipt.countDocuments(filter),
    ]);

    res.json({ ok: true, page, limit, total, totalPages: Math.ceil(total / limit), items });
  })
);

/**
 * GET /api/inbounds/:id
 */
router.get(
  "/:id",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ ok: false, message: "INVALID_ID" });
    const r = await GoodsReceipt.findById(req.params.id).lean();
    if (!r) return res.status(404).json({ ok: false, message: "Receipt not found" });
    res.json({ ok: true, receipt: r });
  })
);

/**
 * POST /api/inbounds/:id/confirm
 * CONFIRMED -> add VariantStock
 */
router.post(
  "/:id/confirm",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ ok: false, message: "INVALID_ID" });

    const receipt = await GoodsReceipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ ok: false, message: "Receipt not found" });

    if (receipt.status === "CONFIRMED") return res.status(409).json({ ok: false, message: "Receipt already confirmed" });
    if (receipt.status === "CANCELLED") return res.status(409).json({ ok: false, message: "Receipt cancelled" });

    // ✅ add stock per variant
    for (const it of receipt.items || []) {
      const qty = moneyInt(it.qty || 0);
      if (!qty) continue;

      if (!it.variantId) {
        // safety: resolve again if missing
        const v = await pickVariantForInbound({ productId: it.productId, variantId: null });
        it.variantId = v?._id || null;
        it.variantSku = v?.sku || it.variantSku || "";
        it.variantName = v?.name || it.variantName || "";
        it.attributes = Array.isArray(v?.attributes) ? v.attributes : (it.attributes || []);
      }

      await VariantStock.findOneAndUpdate(
        { branchId: receipt.branchId, variantId: it.variantId },
        {
          $inc: { qty },
          $set: {
            updatedBy: req.user.sub || null,
            note: `INBOUND ${receipt.code}`,
          },
        },
        { upsert: true, new: true }
      );
    }

    receipt.status = "CONFIRMED";
    receipt.confirmedById = req.user.sub || null;
    receipt.confirmedAt = new Date();
    await receipt.save();

    // emit socket
    const io = req.app.get("io");
    io?.to(`branch:${String(receipt.branchId)}`).emit("inboundConfirmed", {
      branchId: String(receipt.branchId),
      receiptId: String(receipt._id),
      code: receipt.code,
      subtotal: receipt.subtotal,
    });

    res.json({ ok: true, receipt: receipt.toObject() });
  })
);

/**
 * POST /api/inbounds/:id/cancel
 */
router.post(
  "/:id/cancel",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(400).json({ ok: false, message: "INVALID_ID" });

    const receipt = await GoodsReceipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ ok: false, message: "Receipt not found" });

    if (receipt.status !== "DRAFT") return res.status(409).json({ ok: false, message: "Only DRAFT can be cancelled" });

    receipt.status = "CANCELLED";
    await receipt.save();

    res.json({ ok: true, receipt: receipt.toObject() });
  })
);

module.exports = router;
