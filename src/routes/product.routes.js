// src/routes/product.routes.js
const router = require("express").Router();
const { z } = require("zod");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");
const ChangeLog = require("../models/ChangeLog");

const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

const { upload, buildFileUrl, UPLOAD_DIR } = require("../middlewares/uploadProductImages");
const { applyRulesToVariant } = require("../services/pricing.service");

// ⭐ COLLECTION NAMES - SỬ DỤNG TÊN THỰC TẾ TRONG DB
const VARIANT_STOCKS_COLLECTION = "variantstocks"; // ⭐ KHÔNG có dấu gạch dưới
const PRODUCT_VARIANTS_COLLECTION = "productvariants"; // ⭐ KHÔNG có dấu gạch dưới

// ===============================
// Helpers
// ===============================
function getRole(req) {
  return String(req.user?.role || "").toUpperCase();
}
function isValidObjectId(id) {
  return mongoose.isValidObjectId(String(id || ""));
}
function toObjectIdOrNull(id) {
  const s = String(id || "");
  if (!s) return null;
  if (!isValidObjectId(s)) return null;
  return new mongoose.Types.ObjectId(s);
}
function toObjId(id) {
  return new mongoose.Types.ObjectId(String(id));
}
async function nextVersion() {
  const last = await ChangeLog.findOne().sort({ version: -1 }).lean();
  return (last?.version || 0) + 1;
}

function resolveBranchId(req) {
  const role = getRole(req);
  const tokenBranchId = req.user?.branchId ? String(req.user.branchId) : null;

  if (role === "STAFF") return tokenBranchId;

  const q = req.query.branchId !== undefined ? String(req.query.branchId) : "";
  if (!q) return "all";
  if (q === "all") return "all";
  return q;
}

function normalizeUrl(u) {
  return String(u || "").trim();
}

function ensureOnePrimary(images, primaryUrl) {
  const list = (images || []).map((x) => (x.toObject?.() ? x.toObject() : x));
  let found = false;

  const next = list.map((img) => {
    const hit = normalizeUrl(img.url) === normalizeUrl(primaryUrl);
    if (hit) found = true;
    return { ...img, isPrimary: hit };
  });

  return { next, found };
}

function tryDeleteLocalUploadByUrl(url) {
  try {
    const u = new URL(url);
    const pathname = decodeURIComponent(u.pathname || "");
    const filename = pathname.split("/").pop();
    if (!filename) return;

    const localPath = path.join(UPLOAD_DIR, filename);
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
  } catch {}
}

// ===============================
// ✅ PRICE TIER HELPERS
// ===============================
function normalizePriceTier(input) {
  const arr = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();

  for (const x of arr) {
    const tierId = String(x?.tierId || "").trim();
    if (!tierId) continue;
    if (!isValidObjectId(tierId)) {
      const err = new Error("INVALID_TIER_ID");
      err.code = "INVALID_TIER_ID";
      throw err;
    }

    const priceNum = Number(x?.price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      const err = new Error("INVALID_TIER_PRICE");
      err.code = "INVALID_TIER_PRICE";
      throw err;
    }

    if (seen.has(tierId)) {
      const err = new Error("DUPLICATE_TIER_PRICE");
      err.code = "DUPLICATE_TIER_PRICE";
      throw err;
    }
    seen.add(tierId);

    out.push({
      tierId: new mongoose.Types.ObjectId(tierId),
      price: Math.round(priceNum),
    });
  }

  return out;
}

// ===============================
// ✅ VARIANT HELPERS
// ===============================
function normalizeKey(s) {
  return String(s || "").toLowerCase().trim();
}
function normalizeToken(s) {
  return String(s || "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_]/g, "");
}
function buildVariantName(masterName, attrs) {
  const parts = [String(masterName || "")];
  for (const a of attrs || []) parts.push(`${String(a.key || "").toUpperCase()}: ${String(a.value || "")}`);
  return parts.filter(Boolean).join(" - ");
}
function skuFrom(masterSku, attrs) {
  return [String(masterSku || ""), ...(attrs || []).map((a) => normalizeToken(a.value))].join("-");
}
function cartesianOptions(options) {
  let acc = [[]];
  for (const opt of options || []) {
    const key = normalizeKey(opt.key);
    const values = Array.isArray(opt.values) ? opt.values : [];
    if (!key || values.length === 0) continue;

    const next = [];
    for (const base of acc) {
      for (const val of values) {
        next.push([...base, { key, value: String(val) }]);
      }
    }
    acc = next;
  }
  return acc;
}

// ===============================
// ✅ Ensure default variant for "product-only" items
// Mục tiêu: Product tạo mới -> luôn có defaultVariantId
// ===============================
async function ensureDefaultVariantForProduct(productDoc, { force = false } = {}) {
  if (!productDoc?._id) return null;

  // nếu đã có defaultVariantId và không force thì thôi
  if (!force && productDoc.defaultVariantId && isValidObjectId(productDoc.defaultVariantId)) {
    const v = await ProductVariant.findById(productDoc.defaultVariantId).lean();
    if (v && v.isActive) return v;
  }

  // ưu tiên: variant isDefault=true, sau đó oldest
  let existed = await ProductVariant.findOne({ productId: productDoc._id, isActive: true })
    .sort({ isDefault: -1, createdAt: 1 })
    .lean();

  if (!existed) {
    const baseSku = String(productDoc.sku || "").trim() || String(productDoc._id).slice(-6);
    const defaultSku = `${baseSku}-DEFAULT`;

    let finalSku = defaultSku;
    const skuConflict = await ProductVariant.findOne({ sku: finalSku }).lean();
    if (skuConflict) finalSku = `${defaultSku}-${Date.now()}`;

    const created = await ProductVariant.create({
      productId: productDoc._id,
      isDefault: true,
      sku: finalSku,
      barcode: "",
      name: String(productDoc.name || "").trim() || "Variant mặc định",
      attributes: [],

      price: Math.round(Number(productDoc.price || 0)),
      cost: Math.round(Number(productDoc.cost || 0)),
      price_tier: Array.isArray(productDoc.price_tier) ? productDoc.price_tier : [],

      thumbnail: productDoc.thumbnail || "",
      images: Array.isArray(productDoc.images) ? productDoc.images : [],

      isActive: true,
    });

    existed = created.toObject ? created.toObject() : created;
  }

  await Product.updateOne(
    { _id: productDoc._id },
    {
      $set: {
        defaultVariantId: existed._id,
        hasVariants: true,
      },
    }
  );

  return existed;
}

// ===============================
// IMAGES - PRODUCT
// ===============================
router.post(
  "/:id/images",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  upload.array("files", 8),
  asyncHandler(async (req, res) => {
    const productId = req.params.id;

    if (!isValidObjectId(productId)) {
      for (const f of req.files || []) {
        try {
          fs.unlinkSync(path.join(UPLOAD_DIR, f.filename));
        } catch {}
      }
      return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });
    }

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, message: "MISSING_FILES" });

    const primaryIndexRaw = req.query.primaryIndex;
    const primaryIndex = primaryIndexRaw === undefined ? -1 : Number(primaryIndexRaw);

    const p = await Product.findById(productId);
    if (!p) {
      for (const f of files) {
        try {
          fs.unlinkSync(path.join(UPLOAD_DIR, f.filename));
        } catch {}
      }
      return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });
    }

    const newImages = files.map((f, idx) => ({
      url: buildFileUrl(req, f.filename),
      isPrimary: idx === primaryIndex,
      order: 0,
    }));

    if (primaryIndex >= 0 && primaryIndex < newImages.length) {
      p.images = (p.images || []).map((x) => ({
        ...(x.toObject?.() || x),
        isPrimary: false,
      }));
      p.thumbnail = newImages[primaryIndex].url;
    }

    p.images = p.images || [];
    p.images.push(...newImages);

    if (!p.thumbnail && newImages[0]) p.thumbnail = newImages[0].url;

    if (p.thumbnail) {
      const { next } = ensureOnePrimary(p.images, p.thumbnail);
      p.images = next;
    }

    await p.save();

    const v = await nextVersion();
    await ChangeLog.create({
      branchId: null,
      collection: "products",
      docId: p._id,
      action: "UPSERT",
      version: v,
    });

    res.json({
      ok: true,
      productId: String(p._id),
      thumbnail: p.thumbnail,
      images: p.images,
      addedCount: newImages.length,
      version: v,
    });
  })
);

router.put(
  "/:id/images/primary",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!isValidObjectId(productId)) return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });

    const url = normalizeUrl(req.body?.url);
    if (!url) return res.status(400).json({ ok: false, message: "MISSING_URL" });

    const p = await Product.findById(productId);
    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    const { next, found } = ensureOnePrimary(p.images || [], url);
    if (!found) return res.status(404).json({ ok: false, message: "IMAGE_NOT_FOUND" });

    p.images = next;
    p.thumbnail = url;

    await p.save();

    const v = await nextVersion();
    await ChangeLog.create({ branchId: null, collection: "products", docId: p._id, action: "UPSERT", version: v });

    res.json({ ok: true, productId: String(p._id), thumbnail: p.thumbnail, images: p.images, version: v });
  })
);

router.delete(
  "/:id/images",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!isValidObjectId(productId)) return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });

    const url = normalizeUrl(req.query.url || req.body?.url);
    if (!url) return res.status(400).json({ ok: false, message: "MISSING_URL" });

    const p = await Product.findById(productId);
    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    const before = (p.images || []).map((x) => x.toObject?.() || x);
    const kept = before.filter((x) => normalizeUrl(x.url) !== url);
    if (kept.length === before.length) return res.status(404).json({ ok: false, message: "IMAGE_NOT_FOUND" });

    tryDeleteLocalUploadByUrl(url);

    const removedWasPrimary = before.some((x) => normalizeUrl(x.url) === url && !!x.isPrimary);

    let nextImages = kept;

    if (removedWasPrimary && nextImages.length > 0) {
      nextImages = nextImages.map((x, idx) => ({ ...x, isPrimary: idx === 0 }));
      p.thumbnail = nextImages[0].url;
    } else {
      if (normalizeUrl(p.thumbnail) === url) {
        const primary = nextImages.find((x) => x.isPrimary) || nextImages[0];
        p.thumbnail = primary ? primary.url : "";
        if (p.thumbnail) {
          const { next } = ensureOnePrimary(nextImages, p.thumbnail);
          nextImages = next;
        }
      }
    }

    p.images = nextImages;
    await p.save();

    const v = await nextVersion();
    await ChangeLog.create({ branchId: null, collection: "products", docId: p._id, action: "UPSERT", version: v });

    res.json({ ok: true, productId: String(p._id), thumbnail: p.thumbnail, images: p.images, version: v });
  })
);

// ===============================
// IMAGES - VARIANT
// ===============================
router.post(
  "/variants/:id/images",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  upload.array("files", 8),
  asyncHandler(async (req, res) => {
    const variantId = req.params.id;

    if (!isValidObjectId(variantId)) {
      for (const f of req.files || []) {
        try {
          fs.unlinkSync(path.join(UPLOAD_DIR, f.filename));
        } catch {}
      }
      return res.status(400).json({ ok: false, message: "INVALID_VARIANT_ID" });
    }

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, message: "MISSING_FILES" });

    const primaryIndexRaw = req.query.primaryIndex;
    const primaryIndex = primaryIndexRaw === undefined ? -1 : Number(primaryIndexRaw);

    const vdoc = await ProductVariant.findById(variantId);
    if (!vdoc) {
      for (const f of files) {
        try {
          fs.unlinkSync(path.join(UPLOAD_DIR, f.filename));
        } catch {}
      }
      return res.status(404).json({ ok: false, message: "VARIANT_NOT_FOUND" });
    }

    const newImages = files.map((f, idx) => ({
      url: buildFileUrl(req, f.filename),
      isPrimary: idx === primaryIndex,
      order: 0,
    }));

    if (primaryIndex >= 0 && primaryIndex < newImages.length) {
      vdoc.images = (vdoc.images || []).map((x) => ({
        ...(x.toObject?.() || x),
        isPrimary: false,
      }));
      vdoc.thumbnail = newImages[primaryIndex].url;
    }

    vdoc.images = vdoc.images || [];
    vdoc.images.push(...newImages);

    if (!vdoc.thumbnail && newImages[0]) vdoc.thumbnail = newImages[0].url;

    if (vdoc.thumbnail) {
      const { next } = ensureOnePrimary(vdoc.images, vdoc.thumbnail);
      vdoc.images = next;
    }

    await vdoc.save();

    const ver = await nextVersion();
    await ChangeLog.create({
      branchId: null,
      collection: PRODUCT_VARIANTS_COLLECTION,
      docId: vdoc._id,
      action: "UPSERT",
      version: ver,
    });

    res.json({
      ok: true,
      variantId: String(vdoc._id),
      thumbnail: vdoc.thumbnail,
      images: vdoc.images,
      addedCount: newImages.length,
      version: ver,
    });
  })
);

router.put(
  "/variants/:id/images/primary",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const variantId = req.params.id;
    if (!isValidObjectId(variantId)) return res.status(400).json({ ok: false, message: "INVALID_VARIANT_ID" });

    const url = normalizeUrl(req.body?.url);
    if (!url) return res.status(400).json({ ok: false, message: "MISSING_URL" });

    const vdoc = await ProductVariant.findById(variantId);
    if (!vdoc) return res.status(404).json({ ok: false, message: "VARIANT_NOT_FOUND" });

    const { next, found } = ensureOnePrimary(vdoc.images || [], url);
    if (!found) return res.status(404).json({ ok: false, message: "IMAGE_NOT_FOUND" });

    vdoc.images = next;
    vdoc.thumbnail = url;

    await vdoc.save();

    const ver = await nextVersion();
    await ChangeLog.create({
      branchId: null,
      collection: PRODUCT_VARIANTS_COLLECTION,
      docId: vdoc._id,
      action: "UPSERT",
      version: ver,
    });

    res.json({ ok: true, variantId: String(vdoc._id), thumbnail: vdoc.thumbnail, images: vdoc.images, version: ver });
  })
);

router.delete(
  "/variants/:id/images",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const variantId = req.params.id;
    if (!isValidObjectId(variantId)) return res.status(400).json({ ok: false, message: "INVALID_VARIANT_ID" });

    const url = normalizeUrl(req.query.url || req.body?.url);
    if (!url) return res.status(400).json({ ok: false, message: "MISSING_URL" });

    const vdoc = await ProductVariant.findById(variantId);
    if (!vdoc) return res.status(404).json({ ok: false, message: "VARIANT_NOT_FOUND" });

    const before = (vdoc.images || []).map((x) => x.toObject?.() || x);
    const kept = before.filter((x) => normalizeUrl(x.url) !== url);
    if (kept.length === before.length) return res.status(404).json({ ok: false, message: "IMAGE_NOT_FOUND" });

    tryDeleteLocalUploadByUrl(url);

    const removedWasPrimary = before.some((x) => normalizeUrl(x.url) === url && !!x.isPrimary);
    let nextImages = kept;

    if (removedWasPrimary && nextImages.length > 0) {
      nextImages = nextImages.map((x, idx) => ({ ...x, isPrimary: idx === 0 }));
      vdoc.thumbnail = nextImages[0].url;
    } else {
      if (normalizeUrl(vdoc.thumbnail) === url) {
        const primary = nextImages.find((x) => x.isPrimary) || nextImages[0];
        vdoc.thumbnail = primary ? primary.url : "";
        if (vdoc.thumbnail) {
          const { next } = ensureOnePrimary(nextImages, vdoc.thumbnail);
          nextImages = next;
        }
      }
    }

    vdoc.images = nextImages;
    await vdoc.save();

    const ver = await nextVersion();
    await ChangeLog.create({
      branchId: null,
      collection: PRODUCT_VARIANTS_COLLECTION,
      docId: vdoc._id,
      action: "UPSERT",
      version: ver,
    });

    res.json({ ok: true, variantId: String(vdoc._id), thumbnail: vdoc.thumbnail, images: vdoc.images, version: ver });
  })
);

// ===============================
// ✅ LIST PRODUCTS + STOCK (GHÉP FULL LIST)
// - mode=pos: trả sellables (luôn là variant) + stock theo variantstocks
// - mode=variant: list variant + stock theo branch
// - mode=product: list product + stock = sum variantstocks của tất cả variants thuộc product (theo branch)
// ===============================
router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const role = getRole(req);
    const branchResolved = resolveBranchId(req);

    if (role === "STAFF" && !branchResolved) {
      return res.status(400).json({ ok: false, message: "STAFF_MISSING_BRANCH_ID" });
    }

    const mode = String(req.query.mode || "product").toLowerCase();

    const q = String(req.query.q || "").trim();
    const barcode = String(req.query.barcode || "").trim();
    const brand = String(req.query.brand || "").trim();
    const categoryIdRaw = req.query.categoryId ? String(req.query.categoryId) : "";

    const minPrice = req.query.minPrice !== undefined ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice !== undefined ? Number(req.query.maxPrice) : null;

    const isActive = req.query.isActive !== undefined ? String(req.query.isActive) === "true" : true;

    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const sortBy = String(req.query.sortBy || "updatedAt");
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

    const isAll = branchResolved === "all";
    const branchObjId = isAll ? null : toObjectIdOrNull(branchResolved);

    if (!isAll && !branchObjId) {
      return res.status(400).json({ ok: false, message: "INVALID_BRANCH_ID" });
    }

    // =========================================
    // MODE POS (sellables)
    // =========================================
    if (mode === "pos") {
      const baseProductFilter = { isActive };

      if (barcode) baseProductFilter.barcode = barcode;
      if (brand) baseProductFilter.brand = brand;

      if (categoryIdRaw) {
        if (isValidObjectId(categoryIdRaw)) {
          baseProductFilter.$or = [
            ...(baseProductFilter.$or || []),
            { categoryId: new mongoose.Types.ObjectId(categoryIdRaw) },
            { categoryId: categoryIdRaw },
          ];
        } else {
          baseProductFilter.categoryId = categoryIdRaw;
        }
      }

      if (q) {
        const or = [
          { name: { $regex: q, $options: "i" } },
          { sku: { $regex: q, $options: "i" } },
          { barcode: { $regex: q, $options: "i" } },
        ];
        if (baseProductFilter.$or) {
          baseProductFilter.$and = [{ $or: baseProductFilter.$or }, { $or: or }];
          delete baseProductFilter.$or;
        } else {
          baseProductFilter.$or = or;
        }
      }

      const lookupVariantStock = isAll
        ? [
            { $match: { $expr: { $eq: ["$variantId", "$$vid"] } } },
            { $group: { _id: "$variantId", totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
          ]
        : [
            {
              $match: {
                $expr: {
                  $and: [{ $eq: ["$variantId", "$$vid"] }, { $eq: ["$branchId", branchObjId] }],
                },
              },
            },
            { $group: { _id: "$variantId", totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
          ];

      const agg = await Product.aggregate([
        { $match: baseProductFilter },

        // join variants
        {
          $lookup: {
            from: PRODUCT_VARIANTS_COLLECTION,
            let: { pid: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [{ $eq: ["$productId", "$$pid"] }, { $eq: ["$isActive", true] }],
                  },
                },
              },
            ],
            as: "_variants",
          },
        },

        // build sellables: ALWAYS variant
        {
          $addFields: {
            _sellables: {
              $cond: [
                { $gt: [{ $size: { $ifNull: ["$_variants", []] } }, 0] },
                {
                  $map: {
                    input: "$_variants",
                    as: "v",
                    in: {
                      _id: "$$v._id",
                      isVariant: true,
                      productId: "$$v.productId",
                      sku: "$$v.sku",
                      name: { $ifNull: ["$$v.name", "$name"] },
                      barcode: { $ifNull: ["$$v.barcode", ""] },
                      cost: { $ifNull: ["$$v.cost", "$cost"] },
                      price: { $ifNull: ["$$v.price", "$price"] },
                      price_tier: {
                        $cond: [
                          { $gt: [{ $size: { $ifNull: ["$$v.price_tier", []] } }, 0] },
                          "$$v.price_tier",
                          { $ifNull: ["$price_tier", []] },
                        ],
                      },
                      thumbnail: {
                        $cond: [
                          { $and: [{ $ne: ["$$v.thumbnail", null] }, { $ne: ["$$v.thumbnail", ""] }] },
                          "$$v.thumbnail",
                          { $ifNull: ["$thumbnail", ""] },
                        ],
                      },
                      images: {
                        $cond: [
                          { $gt: [{ $size: { $ifNull: ["$$v.images", []] } }, 0] },
                          "$$v.images",
                          { $ifNull: ["$images", []] },
                        ],
                      },
                      brand: { $ifNull: ["$brand", ""] },
                      categoryId: { $ifNull: ["$categoryId", null] },
                      categoryName: { $ifNull: ["$categoryName", ""] },
                      attributes: { $ifNull: ["$$v.attributes", []] },
                    },
                  },
                },
                [
                  {
                    _id: "$defaultVariantId", // ✅ default variant
                    isVariant: true,
                    productId: "$_id",
                    sku: "$sku",
                    name: "$name",
                    barcode: { $ifNull: ["$barcode", ""] },
                    cost: { $ifNull: ["$cost", 0] },
                    price: { $ifNull: ["$price", 0] },
                    price_tier: { $ifNull: ["$price_tier", []] },
                    thumbnail: { $ifNull: ["$thumbnail", ""] },
                    images: { $ifNull: ["$images", []] },
                    brand: { $ifNull: ["$brand", ""] },
                    categoryId: { $ifNull: ["$categoryId", null] },
                    categoryName: { $ifNull: ["$categoryName", ""] },
                    attributes: [],
                  },
                ],
              ],
            },
          },
        },

        { $unwind: "$_sellables" },

        // ✅ stock theo variantstocks
        {
          $lookup: {
            from: VARIANT_STOCKS_COLLECTION,
            let: { vid: "$_sellables._id" },
            pipeline: lookupVariantStock,
            as: "_vstock",
          },
        },
        { $addFields: { _vs0: { $arrayElemAt: ["$_vstock", 0] } } },
        { $addFields: { stock: { $ifNull: ["$_vs0.totalQty", 0] } } },

        // nếu defaultVariantId null -> loại bỏ khỏi list (tránh _id = null)
        { $match: { "_sellables._id": { $ne: null } } },

        {
          $project: {
            _id: "$_sellables._id",
            isVariant: "$_sellables.isVariant",
            productId: "$_sellables.productId",
            sku: "$_sellables.sku",
            name: "$_sellables.name",
            brand: "$_sellables.brand",
            categoryId: "$_sellables.categoryId",
            categoryName: "$_sellables.categoryName",
            barcode: "$_sellables.barcode",
            cost: "$_sellables.cost",
            price: "$_sellables.price",
            price_tier: "$_sellables.price_tier",
            thumbnail: "$_sellables.thumbnail",
            images: "$_sellables.images",
            attributes: "$_sellables.attributes",
            isActive: "$isActive",
            stock: 1,
            updatedAt: "$updatedAt",
            createdAt: "$createdAt",
          },
        },

        ...(minPrice !== null || maxPrice !== null
          ? [
              {
                $match: {
                  price: {
                    ...(minPrice !== null && !Number.isNaN(minPrice) ? { $gte: minPrice } : {}),
                    ...(maxPrice !== null && !Number.isNaN(maxPrice) ? { $lte: maxPrice } : {}),
                  },
                },
              },
            ]
          : []),

        ...(q
          ? [
              {
                $match: {
                  $or: [
                    { name: { $regex: q, $options: "i" } },
                    { sku: { $regex: q, $options: "i" } },
                    { barcode: { $regex: q, $options: "i" } },
                  ],
                },
              },
            ]
          : []),

        {
          $facet: {
            items: [{ $sort: { [sortBy]: sortOrder } }, { $skip: skip }, { $limit: limit }],
            total: [{ $count: "count" }],
          },
        },
      ]);

      const items = agg?.[0]?.items || [];
      const total = agg?.[0]?.total?.[0]?.count || 0;

      // ✅ optional: tự heal defaultVariantId nếu có item thiếu (thường do dữ liệu cũ)
      // (không bắt buộc; nếu bạn muốn bỏ cho nhẹ thì xoá đoạn này)
      const missingDefault = items.some((x) => !x._id);
      if (missingDefault) {
        // noop
      }

      return res.json({
        ok: true,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        branchId: isAll ? null : String(branchObjId),
        items,
        mode: "pos",
      });
    }

    // =========================================
    // MODE VARIANT (quản trị variant)
    // =========================================
    if (mode === "variant") {
      const filterV = { isActive };

      if (barcode) filterV.barcode = barcode;

      if (q) {
        filterV.$or = [
          { name: { $regex: q, $options: "i" } },
          { sku: { $regex: q, $options: "i" } },
          { barcode: { $regex: q, $options: "i" } },
        ];
      }

      const priceMatch = {};
      if (minPrice !== null && !Number.isNaN(minPrice)) priceMatch.$gte = minPrice;
      if (maxPrice !== null && !Number.isNaN(maxPrice)) priceMatch.$lte = maxPrice;

      const lookupStockPipeline = isAll
        ? [
            { $match: { $expr: { $eq: ["$variantId", "$$vid"] } } },
            { $group: { _id: "$variantId", totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
          ]
        : [
            {
              $match: {
                $expr: {
                  $and: [{ $eq: ["$variantId", "$$vid"] }, { $eq: ["$branchId", branchObjId] }],
                },
              },
            },
            { $group: { _id: "$variantId", totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
          ];

      const aggV = await ProductVariant.aggregate([
        { $match: filterV },

        {
          $lookup: {
            from: "products",
            localField: "productId",
            foreignField: "_id",
            as: "_p",
          },
        },
        { $addFields: { _p0: { $arrayElemAt: ["$_p", 0] } } },

        ...(brand ? [{ $match: { "_p0.brand": brand } }] : []),

        ...(categoryIdRaw
          ? [
              {
                $match: {
                  $or: isValidObjectId(categoryIdRaw)
                    ? [{ "_p0.categoryId": new mongoose.Types.ObjectId(categoryIdRaw) }, { "_p0.categoryId": categoryIdRaw }]
                    : [{ "_p0.categoryId": categoryIdRaw }],
                },
              },
            ]
          : []),

        ...(Object.keys(priceMatch).length ? [{ $match: { price: priceMatch } }] : []),

        {
          $facet: {
            items: [
              { $sort: { [sortBy]: sortOrder } },
              { $skip: skip },
              { $limit: limit },

              {
                $lookup: {
                  from: VARIANT_STOCKS_COLLECTION,
                  let: { vid: "$_id" },
                  pipeline: lookupStockPipeline,
                  as: "_stock",
                },
              },
              { $addFields: { _s0: { $arrayElemAt: ["$_stock", 0] } } },
              { $addFields: { stock: { $ifNull: ["$_s0.totalQty", 0] } } },

              {
                $project: {
                  _id: 1,
                  productId: 1,
                  attributes: 1,
                  sku: 1,
                  name: 1,
                  barcode: 1,
                  cost: 1,
                  price: 1,
                  price_tier: 1,
                  isActive: 1,
                  stock: 1,
                  brand: { $ifNull: ["$_p0.brand", ""] },
                  categoryId: { $ifNull: ["$_p0.categoryId", null] },
                  categoryName: { $ifNull: ["$_p0.categoryName", ""] },
                  thumbnail: {
                    $cond: [
                      { $and: [{ $ne: ["$thumbnail", null] }, { $ne: ["$thumbnail", ""] }] },
                      "$thumbnail",
                      { $ifNull: ["$_p0.thumbnail", ""] },
                    ],
                  },
                  images: {
                    $cond: [
                      { $gt: [{ $size: { $ifNull: ["$images", []] } }, 0] },
                      "$images",
                      { $ifNull: ["$_p0.images", []] },
                    ],
                  },
                },
              },
            ],
            total: [{ $count: "count" }],
          },
        },
      ]);

      const items = aggV?.[0]?.items || [];
      const total = aggV?.[0]?.total?.[0]?.count || 0;

      return res.json({
        ok: true,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        branchId: isAll ? null : String(branchObjId),
        items,
        mode: "variant",
      });
    }

    // =========================================
    // DEFAULT MODE: PRODUCT (stock = sum variantstocks)
    // =========================================
    const filter = { isActive };

    if (categoryIdRaw) {
      if (isValidObjectId(categoryIdRaw)) {
        filter.$or = [
          ...(filter.$or || []),
          { categoryId: new mongoose.Types.ObjectId(categoryIdRaw) },
          { categoryId: categoryIdRaw },
        ];
      } else {
        filter.categoryId = categoryIdRaw;
      }
    }

    if (barcode) filter.barcode = barcode;
    if (brand) filter.brand = brand;

    if (minPrice !== null || maxPrice !== null) {
      filter.price = {};
      if (minPrice !== null && !Number.isNaN(minPrice)) filter.price.$gte = minPrice;
      if (maxPrice !== null && !Number.isNaN(maxPrice)) filter.price.$lte = maxPrice;
    }

    if (q) {
      const or = [
        { name: { $regex: q, $options: "i" } },
        { sku: { $regex: q, $options: "i" } },
        { barcode: { $regex: q, $options: "i" } },
      ];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: or }];
        delete filter.$or;
      } else {
        filter.$or = or;
      }
    }

    // lookup variants of product
    const lookupVariants = [
      {
        $match: {
          $expr: { $and: [{ $eq: ["$productId", "$$pid"] }, { $eq: ["$isActive", true] }] },
        },
      },
      { $project: { _id: 1 } },
    ];

    // lookup variantstocks by variantIds
    const lookupVariantStocksByVariantIds = isAll
      ? [
          {
            $match: {
              $expr: { $in: ["$variantId", "$$vids"] },
            },
          },
          { $group: { _id: null, totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
        ]
      : [
          {
            $match: {
              $expr: {
                $and: [{ $in: ["$variantId", "$$vids"] }, { $eq: ["$branchId", branchObjId] }],
              },
            },
          },
          { $group: { _id: null, totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
        ];

    const aggP = await Product.aggregate([
      { $match: filter },
      {
        $facet: {
          items: [
            { $sort: { [sortBy]: sortOrder } },
            { $skip: skip },
            { $limit: limit },

            // join variants -> get variant ids
            {
              $lookup: {
                from: PRODUCT_VARIANTS_COLLECTION,
                let: { pid: "$_id" },
                pipeline: lookupVariants,
                as: "_vids",
              },
            },
            {
              $addFields: {
                _variantIds: {
                  $cond: [
                    { $gt: [{ $size: { $ifNull: ["$_vids", []] } }, 0] },
                    { $map: { input: "$_vids", as: "x", in: "$$x._id" } },
                    [
                      {
                        $cond: [
                          { $and: [{ $ne: ["$defaultVariantId", null] }, { $ne: ["$defaultVariantId", ""] }] },
                          "$defaultVariantId",
                          null,
                        ],
                      },
                    ],
                  ],
                },
              },
            },
            {
              $addFields: {
                _variantIds: {
                  $filter: { input: "$_variantIds", as: "id", cond: { $ne: ["$$id", null] } },
                },
              },
            },

            // sum variantstocks
            {
              $lookup: {
                from: VARIANT_STOCKS_COLLECTION,
                let: { vids: "$_variantIds" },
                pipeline: lookupVariantStocksByVariantIds,
                as: "_stock",
              },
            },
            { $addFields: { _s0: { $arrayElemAt: ["$_stock", 0] } } },
            { $addFields: { stock: { $ifNull: ["$_s0.totalQty", 0] } } },

            { $project: { _vids: 0, _variantIds: 0, _stock: 0, _s0: 0 } },
          ],
          total: [{ $count: "count" }],
        },
      },
    ]);

    const items = aggP?.[0]?.items || [];
    const total = aggP?.[0]?.total?.[0]?.count || 0;

    res.json({
      ok: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      branchId: isAll ? null : String(branchObjId),
      items,
      mode: "product",
    });
  })
);

// ===============================
// GET /:id/variants
// ===============================
router.get(
  "/:id/variants",
  authRequired,
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!isValidObjectId(productId)) return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });

    const items = await ProductVariant.find({ productId: new mongoose.Types.ObjectId(productId), isActive: true })
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ ok: true, items });
  })
);

// ===============================
// POST /:id/variants/generate
// ===============================
router.post(
  "/:id/variants/generate",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!isValidObjectId(productId)) return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });

    const body = z
      .object({
        overwrite: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const overwrite = !!body.data.overwrite;

    const p = await Product.findById(productId);
    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    const combos = cartesianOptions(p.options || []);
    if (!combos.length) return res.status(400).json({ ok: false, message: "NO_OPTIONS_TO_GENERATE" });

    if (overwrite) {
      await ProductVariant.deleteMany({ productId: p._id });
    }

    const exist = await ProductVariant.find({ productId: p._id }, { sku: 1 }).lean();
    const existSkus = new Set(exist.map((x) => String(x.sku)));

    const docs = [];
    for (const attrs of combos) {
      const sku = skuFrom(p.sku, attrs);
      if (existSkus.has(sku)) continue;

      const attrsKV = (attrs || [])
        .map((a) => ({
          k: String(a.key || "").trim(),
          v: String(a.value || "").trim(),
        }))
        .filter((x) => x.k && x.v);

      docs.push({
        productId: p._id,
        sku,
        barcode: "",
        name: buildVariantName(p.name, attrs),
        attributes: attrsKV,
        cost: Math.round(Number(p.cost || 0)),
        price: Math.round(Number(p.basePrice || p.price || 0)),
        price_tier: (p.baseTier && p.baseTier.length ? p.baseTier : p.price_tier) || [],
        isActive: true,
        thumbnail: "",
        images: [],
      });
    }

    const inserted = docs.length ? await ProductVariant.insertMany(docs) : [];

    p.hasVariants = true;
    if (!p.basePrice) p.basePrice = Math.round(Number(p.price || 0));
    if (!p.baseTier?.length && p.price_tier?.length) p.baseTier = p.price_tier;

    // ✅ nếu generate variants rồi: set defaultVariantId
    const anyVariant = await ProductVariant.findOne({ productId: p._id, isActive: true })
      .sort({ isDefault: -1, createdAt: 1 })
      .lean();
    if (anyVariant) p.defaultVariantId = anyVariant._id;

    await p.save();

    const v = await nextVersion();
    await ChangeLog.create({
      branchId: null,
      collection: PRODUCT_VARIANTS_COLLECTION,
      docId: p._id,
      action: "UPSERT",
      version: v,
    });

    res.json({ ok: true, created: inserted.length, defaultVariantId: anyVariant ? String(anyVariant._id) : null, version: v });
  })
);

// ===============================
// PUT /:id/pricing
// ===============================
router.put(
  "/:id/pricing",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!isValidObjectId(productId)) return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });

    const body = z
      .object({
        basePrice: z.number().nonnegative().optional(),
        baseTier: z.array(z.object({ tierId: z.string(), price: z.number().nonnegative() })).optional(),

        pricingRules: z
          .array(
            z.object({
              name: z.string().optional(),
              priority: z.number().optional(),
              when: z
                .array(
                  z.object({
                    key: z.string(),
                    op: z.string().optional(),
                    value: z.string(),
                  })
                )
                .optional(),
              actionRetail: z
                .object({
                  type: z.enum(["NONE", "SET", "ADD"]).optional(),
                  amount: z.number().optional(),
                })
                .optional(),
              actionTiers: z
                .array(
                  z.object({
                    tierId: z.string(),
                    type: z.enum(["NONE", "SET", "ADD"]).optional(),
                    amount: z.number().optional(),
                  })
                )
                .optional(),
            })
          )
          .optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const patch = {};

    if (body.data.basePrice !== undefined) patch.basePrice = Math.round(Number(body.data.basePrice || 0));
    if (body.data.baseTier !== undefined) {
      try {
        patch.baseTier = normalizePriceTier(body.data.baseTier);
      } catch (e) {
        return res.status(400).json({ ok: false, message: String(e?.code || e?.message || "INVALID_BASE_TIER") });
      }
    }

    if (body.data.pricingRules !== undefined) {
      const rules = Array.isArray(body.data.pricingRules) ? body.data.pricingRules : [];
      patch.pricingRules = rules.map((r) => ({
        name: r.name || "",
        priority: r.priority !== undefined ? Number(r.priority) : 100,
        when: (r.when || []).map((c) => ({ key: normalizeKey(c.key), op: c.op || "eq", value: String(c.value || "") })),
        actionRetail: { type: r.actionRetail?.type || "NONE", amount: Number(r.actionRetail?.amount || 0) },
        actionTiers: (r.actionTiers || []).map((t) => ({
          tierId: new mongoose.Types.ObjectId(String(t.tierId)),
          type: t.type || "NONE",
          amount: Number(t.amount || 0),
        })),
      }));
    }

    const p = await Product.findByIdAndUpdate(productId, { $set: patch }, { new: true });
    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    // ✅ ensure default variant
    const dv = await ensureDefaultVariantForProduct(p);

    const v = await nextVersion();
    await ChangeLog.create({ branchId: null, collection: "products", docId: p._id, action: "UPSERT", version: v });

    res.json({ ok: true, product: p, defaultVariantId: dv ? String(dv._id) : null, version: v });
  })
);

// ===============================
// POST /:id/pricing/apply
// ===============================
router.post(
  "/:id/pricing/apply",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!isValidObjectId(productId)) return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });

    const p = await Product.findById(productId).lean();
    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    const variants = await ProductVariant.find({ productId: p._id }).lean();

    const ops = variants.map((v) => {
      const out = applyRulesToVariant(p, v);
      return {
        updateOne: {
          filter: { _id: v._id },
          update: { $set: { price: out.price, price_tier: out.price_tier } },
        },
      };
    });

    if (ops.length) await ProductVariant.bulkWrite(ops);

    const ver = await nextVersion();
    await ChangeLog.create({
      branchId: null,
      collection: PRODUCT_VARIANTS_COLLECTION,
      docId: p._id,
      action: "UPSERT",
      version: ver,
    });

    res.json({ ok: true, updated: ops.length, version: ver });
  })
);

// ===============================
// POST / (CREATE PRODUCT)  ✅ tạo xong -> tạo default variant + set defaultVariantId
// ===============================
router.post(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        sku: z.string().min(2),
        name: z.string().min(2),
        price: z.number().nonnegative(),
        cost: z.number().nonnegative().optional(),
        barcode: z.string().optional(),
        brand: z.string().optional(),
        categoryId: z.union([z.string(), z.null()]).optional(),
        categoryName: z.string().optional(),

        price_tier: z.array(z.object({ tierId: z.string(), price: z.number().nonnegative() })).optional(),

        options: z
          .array(
            z.object({
              key: z.string(),
              label: z.string().optional(),
              values: z.array(z.string()).optional(),
              order: z.number().optional(),
            })
          )
          .optional(),
        basePrice: z.number().nonnegative().optional(),
        baseTier: z.array(z.object({ tierId: z.string(), price: z.number().nonnegative() })).optional(),
        pricingRules: z.array(z.any()).optional(),

        thumbnail: z.string().optional(),
        images: z.array(z.object({ url: z.string(), isPrimary: z.boolean().optional(), order: z.number().optional() })).optional(),
        isActive: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const data = body.data;

    let categoryId = null;
    if (data.categoryId === null) categoryId = null;
    else if (typeof data.categoryId === "string" && data.categoryId.trim()) {
      const s = data.categoryId.trim();
      categoryId = isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : s;
    }

    let price_tier = [];
    try {
      price_tier = normalizePriceTier(data.price_tier);
    } catch (e) {
      return res.status(400).json({ ok: false, message: String(e?.code || e?.message || "INVALID_PRICE_TIER") });
    }

    let baseTier = [];
    if (data.baseTier !== undefined) {
      try {
        baseTier = normalizePriceTier(data.baseTier);
      } catch (e) {
        return res.status(400).json({ ok: false, message: String(e?.code || e?.message || "INVALID_BASE_TIER") });
      }
    }

    let images = Array.isArray(data.images) ? data.images : [];
    images = images
      .map((img) => ({
        url: normalizeUrl(img.url),
        isPrimary: !!img.isPrimary,
        order: Number(img.order || 0),
      }))
      .filter((x) => x.url);

    let thumbnail = normalizeUrl(data.thumbnail);

    if (!thumbnail && images.length) {
      const primary = images.find((x) => x.isPrimary) || images[0];
      thumbnail = primary.url;
    }

    if (thumbnail && images.length) {
      const { next } = ensureOnePrimary(images, thumbnail);
      images = next;
    }

    const options = (data.options || []).map((o) => ({
      key: normalizeKey(o.key),
      label: o.label || "",
      values: Array.isArray(o.values) ? o.values.map(String) : [],
      order: Number(o.order || 0),
    }));

    const p = await Product.create({
      sku: data.sku,
      name: data.name,
      price: Math.round(Number(data.price || 0)),
      cost: data.cost !== undefined ? Math.round(Number(data.cost || 0)) : undefined,
      barcode: data.barcode || "",
      brand: data.brand || "",
      categoryId,
      categoryName: data.categoryName || "",

      price_tier,

      hasVariants: true,
      options,
      basePrice: data.basePrice !== undefined ? Math.round(Number(data.basePrice || 0)) : Math.round(Number(data.price || 0)),
      baseTier: baseTier.length ? baseTier : price_tier,
      pricingRules: Array.isArray(data.pricingRules) ? data.pricingRules : [],

      thumbnail,
      images,
      isActive: data.isActive !== undefined ? !!data.isActive : true,

      defaultVariantId: null,
    });

    // ✅ tạo default variant ngay lập tức
    const dv = await ensureDefaultVariantForProduct(p);

    const v = await nextVersion();
    await ChangeLog.create({ branchId: null, collection: "products", docId: p._id, action: "UPSERT", version: v });

    res.json({ ok: true, product: p, defaultVariantId: dv ? String(dv._id) : null, version: v });
  })
);

// ===============================
// PUT /:id (UPDATE PRODUCT) -> đảm bảo defaultVariantId
// ===============================
router.put(
  "/:id",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!isValidObjectId(productId)) return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });

    const body = z
      .object({
        sku: z.string().min(2).optional(),
        name: z.string().min(2).optional(),
        price: z.number().nonnegative().optional(),
        cost: z.number().nonnegative().optional(),
        barcode: z.string().optional(),
        brand: z.string().optional(),
        categoryId: z.union([z.string(), z.null()]).optional(),
        categoryName: z.string().optional(),
        isActive: z.boolean().optional(),

        price_tier: z.array(z.object({ tierId: z.string(), price: z.number().nonnegative() })).optional(),

        options: z
          .array(
            z.object({
              key: z.string(),
              label: z.string().optional(),
              values: z.array(z.string()).optional(),
              order: z.number().optional(),
            })
          )
          .optional(),
        basePrice: z.number().nonnegative().optional(),
        baseTier: z.array(z.object({ tierId: z.string(), price: z.number().nonnegative() })).optional(),
        pricingRules: z.array(z.any()).optional(),

        thumbnail: z.string().optional(),
        images: z.array(z.object({ url: z.string(), isPrimary: z.boolean().optional(), order: z.number().optional() })).optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const patch = { ...body.data };

    if ("categoryId" in patch) {
      if (patch.categoryId === null) patch.categoryId = null;
      else if (typeof patch.categoryId === "string") {
        const s = patch.categoryId.trim();
        patch.categoryId = s ? (isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : s) : null;
      }
    }

    if ("price_tier" in patch) {
      try {
        patch.price_tier = normalizePriceTier(patch.price_tier);
      } catch (e) {
        return res.status(400).json({ ok: false, message: String(e?.code || e?.message || "INVALID_PRICE_TIER") });
      }
    }

    if ("baseTier" in patch) {
      try {
        patch.baseTier = normalizePriceTier(patch.baseTier);
      } catch (e) {
        return res.status(400).json({ ok: false, message: String(e?.code || e?.message || "INVALID_BASE_TIER") });
      }
    }

    if ("options" in patch) {
      const opts = (patch.options || []).map((o) => ({
        key: normalizeKey(o.key),
        label: o.label || "",
        values: Array.isArray(o.values) ? o.values.map(String) : [],
        order: Number(o.order || 0),
      }));
      patch.options = opts;
      patch.hasVariants = true; // bạn bán theo variant
    }

    if (patch.images) {
      let images = patch.images
        .map((img) => ({
          url: normalizeUrl(img.url),
          isPrimary: !!img.isPrimary,
          order: Number(img.order || 0),
        }))
        .filter((x) => x.url);

      let thumbnail = "thumbnail" in patch ? normalizeUrl(patch.thumbnail) : "";

      if (!thumbnail && images.length) {
        const primary = images.find((x) => x.isPrimary) || images[0];
        thumbnail = primary.url;
      }

      if (thumbnail && images.length) {
        const { next } = ensureOnePrimary(images, thumbnail);
        images = next;
      }

      patch.images = images;
      if ("thumbnail" in patch) patch.thumbnail = thumbnail;
    } else if ("thumbnail" in patch) {
      patch.thumbnail = normalizeUrl(patch.thumbnail);
    }

    if (patch.price !== undefined) patch.price = Math.round(Number(patch.price || 0));
    if (patch.cost !== undefined) patch.cost = Math.round(Number(patch.cost || 0));
    if (patch.basePrice !== undefined) patch.basePrice = Math.round(Number(patch.basePrice || 0));

    patch.hasVariants = true; // ✅ luôn

    const p = await Product.findByIdAndUpdate(productId, { $set: patch }, { new: true });
    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    const dv = await ensureDefaultVariantForProduct(p);

    const v = await nextVersion();
    await ChangeLog.create({ branchId: null, collection: "products", docId: p._id, action: "UPSERT", version: v });

    res.json({ ok: true, product: p, defaultVariantId: dv ? String(dv._id) : null, version: v });
  })
);

//NEW
// src/routes/product.routes.js

// ===============================
// ✅ Helper: Lấy tất cả category con (copy từ categories.js)
// ===============================
async function getAllDescendantCategories(categoryId) {
  const Category = require("../models/Category");
  const descendants = [];
  const queue = [categoryId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const children = await Category.find({ parentId: currentId })
      .select("_id")
      .lean();

    for (const child of children) {
      descendants.push(child._id);
      queue.push(child._id);
    }
  }

  return descendants;
}

// ===============================
// ✅ GET /api/products/by-category/:categoryId
// Lấy products theo category (có option bao gồm category con)
// ===============================
router.get(
  "/by-category/:categoryId",
  authRequired,
  asyncHandler(async (req, res) => {
    const { categoryId } = req.params;
    
    if (!isValidObjectId(categoryId)) {
      return res.status(400).json({ 
        ok: false, 
        message: "INVALID_CATEGORY_ID" 
      });
    }

    const Category = require("../models/Category");
    
    // Kiểm tra category tồn tại
    const category = await Category.findById(categoryId);
    if (!category) {
      return res.status(404).json({ 
        ok: false, 
        message: "CATEGORY_NOT_FOUND" 
      });
    }

    // ✅ Query parameters
    const includeSubcategories = String(req.query.includeSubcategories || "true") === "true";
    const mode = String(req.query.mode || "product").toLowerCase();
    const q = String(req.query.q || "").trim();
    const brand = String(req.query.brand || "").trim();
    const minPrice = req.query.minPrice !== undefined ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice !== undefined ? Number(req.query.maxPrice) : null;
    const isActive = req.query.isActive !== undefined ? String(req.query.isActive) === "true" : true;
    
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;
    
    const sortBy = String(req.query.sortBy || "updatedAt");
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

    // ✅ Resolve branchId
    const role = getRole(req);
    const branchResolved = resolveBranchId(req);
    
    if (role === "STAFF" && !branchResolved) {
      return res.status(400).json({ ok: false, message: "STAFF_MISSING_BRANCH_ID" });
    }

    const isAll = branchResolved === "all";
    const branchObjId = isAll ? null : toObjectIdOrNull(branchResolved);
    
    if (!isAll && !branchObjId) {
      return res.status(400).json({ ok: false, message: "INVALID_BRANCH_ID" });
    }

    // ✅ Build category filter
    let categoryIds = [new mongoose.Types.ObjectId(categoryId)];
    
    if (includeSubcategories) {
      const descendants = await getAllDescendantCategories(categoryId);
      categoryIds = [
        new mongoose.Types.ObjectId(categoryId),
        ...descendants.map(id => new mongoose.Types.ObjectId(id))
      ];
    }

    // ===============================
    // ✅ MODE: PRODUCT
    // ===============================
    if (mode === "product") {
      const filter = { 
        isActive,
        categoryId: { $in: categoryIds }
      };

      if (brand) filter.brand = brand;
      if (q) {
        filter.$or = [
          { name: { $regex: q, $options: "i" } },
          { sku: { $regex: q, $options: "i" } },
          { barcode: { $regex: q, $options: "i" } },
        ];
      }
      
      if (minPrice !== null || maxPrice !== null) {
        filter.price = {};
        if (minPrice !== null && !Number.isNaN(minPrice)) filter.price.$gte = minPrice;
        if (maxPrice !== null && !Number.isNaN(maxPrice)) filter.price.$lte = maxPrice;
      }

      // Lookup variants -> variantstocks
      const lookupVariants = [
        {
          $match: {
            $expr: { 
              $and: [
                { $eq: ["$productId", "$$pid"] }, 
                { $eq: ["$isActive", true] }
              ] 
            },
          },
        },
        { $project: { _id: 1 } },
      ];

      const lookupVariantStocksByVariantIds = isAll
        ? [
            {
              $match: {
                $expr: { $in: ["$variantId", "$$vids"] },
              },
            },
            { $group: { _id: null, totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
          ]
        : [
            {
              $match: {
                $expr: {
                  $and: [
                    { $in: ["$variantId", "$$vids"] }, 
                    { $eq: ["$branchId", branchObjId] }
                  ],
                },
              },
            },
            { $group: { _id: null, totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
          ];

      const aggP = await Product.aggregate([
        { $match: filter },
        {
          $facet: {
            items: [
              { $sort: { [sortBy]: sortOrder } },
              { $skip: skip },
              { $limit: limit },

              // Join variants
              {
                $lookup: {
                  from: PRODUCT_VARIANTS_COLLECTION,
                  let: { pid: "$_id" },
                  pipeline: lookupVariants,
                  as: "_vids",
                },
              },
              {
                $addFields: {
                  _variantIds: {
                    $cond: [
                      { $gt: [{ $size: { $ifNull: ["$_vids", []] } }, 0] },
                      { $map: { input: "$_vids", as: "x", in: "$$x._id" } },
                      [
                        {
                          $cond: [
                            { $and: [{ $ne: ["$defaultVariantId", null] }, { $ne: ["$defaultVariantId", ""] }] },
                            "$defaultVariantId",
                            null,
                          ],
                        },
                      ],
                    ],
                  },
                },
              },
              {
                $addFields: {
                  _variantIds: {
                    $filter: { input: "$_variantIds", as: "id", cond: { $ne: ["$$id", null] } },
                  },
                },
              },

              // Sum variantstocks
              {
                $lookup: {
                  from: VARIANT_STOCKS_COLLECTION,
                  let: { vids: "$_variantIds" },
                  pipeline: lookupVariantStocksByVariantIds,
                  as: "_stock",
                },
              },
              { $addFields: { _s0: { $arrayElemAt: ["$_stock", 0] } } },
              { $addFields: { stock: { $ifNull: ["$_s0.totalQty", 0] } } },

              { $project: { _vids: 0, _variantIds: 0, _stock: 0, _s0: 0 } },
            ],
            total: [{ $count: "count" }],
          },
        },
      ]);

      const items = aggP?.[0]?.items || [];
      const total = aggP?.[0]?.total?.[0]?.count || 0;

      return res.json({
        ok: true,
        category: {
          _id: category._id,
          name: category.name,
          code: category.code,
          level: category.level,
        },
        includeSubcategories,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        branchId: isAll ? null : String(branchObjId),
        items,
        mode: "product",
      });
    }

    // ===============================
    // ✅ MODE: VARIANT
    // ===============================
    if (mode === "variant") {
      const filterV = { isActive };

      if (q) {
        filterV.$or = [
          { name: { $regex: q, $options: "i" } },
          { sku: { $regex: q, $options: "i" } },
          { barcode: { $regex: q, $options: "i" } },
        ];
      }

      const priceMatch = {};
      if (minPrice !== null && !Number.isNaN(minPrice)) priceMatch.$gte = minPrice;
      if (maxPrice !== null && !Number.isNaN(maxPrice)) priceMatch.$lte = maxPrice;

      const lookupStockPipeline = isAll
        ? [
            { $match: { $expr: { $eq: ["$variantId", "$$vid"] } } },
            { $group: { _id: "$variantId", totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
          ]
        : [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$variantId", "$$vid"] }, 
                    { $eq: ["$branchId", branchObjId] }
                  ],
                },
              },
            },
            { $group: { _id: "$variantId", totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
          ];

      const aggV = await ProductVariant.aggregate([
        { $match: filterV },

        // Join product
        {
          $lookup: {
            from: "products",
            localField: "productId",
            foreignField: "_id",
            as: "_p",
          },
        },
        { $addFields: { _p0: { $arrayElemAt: ["$_p", 0] } } },

        // Filter by category
        {
          $match: {
            "_p0.categoryId": { $in: categoryIds }
          }
        },

        ...(brand ? [{ $match: { "_p0.brand": brand } }] : []),
        ...(Object.keys(priceMatch).length ? [{ $match: { price: priceMatch } }] : []),

        {
          $facet: {
            items: [
              { $sort: { [sortBy]: sortOrder } },
              { $skip: skip },
              { $limit: limit },

              // Join stock
              {
                $lookup: {
                  from: VARIANT_STOCKS_COLLECTION,
                  let: { vid: "$_id" },
                  pipeline: lookupStockPipeline,
                  as: "_stock",
                },
              },
              { $addFields: { _s0: { $arrayElemAt: ["$_stock", 0] } } },
              { $addFields: { stock: { $ifNull: ["$_s0.totalQty", 0] } } },

              {
                $project: {
                  _id: 1,
                  productId: 1,
                  attributes: 1,
                  sku: 1,
                  name: 1,
                  barcode: 1,
                  cost: 1,
                  price: 1,
                  price_tier: 1,
                  isActive: 1,
                  stock: 1,
                  brand: { $ifNull: ["$_p0.brand", ""] },
                  categoryId: { $ifNull: ["$_p0.categoryId", null] },
                  categoryName: { $ifNull: ["$_p0.categoryName", ""] },
                  thumbnail: {
                    $cond: [
                      { $and: [{ $ne: ["$thumbnail", null] }, { $ne: ["$thumbnail", ""] }] },
                      "$thumbnail",
                      { $ifNull: ["$_p0.thumbnail", ""] },
                    ],
                  },
                  images: {
                    $cond: [
                      { $gt: [{ $size: { $ifNull: ["$images", []] } }, 0] },
                      "$images",
                      { $ifNull: ["$_p0.images", []] },
                    ],
                  },
                },
              },
            ],
            total: [{ $count: "count" }],
          },
        },
      ]);

      const items = aggV?.[0]?.items || [];
      const total = aggV?.[0]?.total?.[0]?.count || 0;

      return res.json({
        ok: true,
        category: {
          _id: category._id,
          name: category.name,
          code: category.code,
          level: category.level,
        },
        includeSubcategories,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        branchId: isAll ? null : String(branchObjId),
        items,
        mode: "variant",
      });
    }

    // ===============================
    // ✅ MODE: POS
    // ===============================
    if (mode === "pos") {
      const baseProductFilter = { 
        isActive,
        categoryId: { $in: categoryIds }
      };

      if (brand) baseProductFilter.brand = brand;
      if (q) {
        baseProductFilter.$or = [
          { name: { $regex: q, $options: "i" } },
          { sku: { $regex: q, $options: "i" } },
          { barcode: { $regex: q, $options: "i" } },
        ];
      }

      const lookupVariantStock = isAll
        ? [
            { $match: { $expr: { $eq: ["$variantId", "$$vid"] } } },
            { $group: { _id: "$variantId", totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
          ]
        : [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$variantId", "$$vid"] }, 
                    { $eq: ["$branchId", branchObjId] }
                  ],
                },
              },
            },
            { $group: { _id: "$variantId", totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
          ];

      const agg = await Product.aggregate([
        { $match: baseProductFilter },

        // Join variants
        {
          $lookup: {
            from: PRODUCT_VARIANTS_COLLECTION,
            let: { pid: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$productId", "$$pid"] }, 
                      { $eq: ["$isActive", true] }
                    ],
                  },
                },
              },
            ],
            as: "_variants",
          },
        },

        // Build sellables
        {
          $addFields: {
            _sellables: {
              $cond: [
                { $gt: [{ $size: { $ifNull: ["$_variants", []] } }, 0] },
                {
                  $map: {
                    input: "$_variants",
                    as: "v",
                    in: {
                      _id: "$$v._id",
                      isVariant: true,
                      productId: "$$v.productId",
                      sku: "$$v.sku",
                      name: { $ifNull: ["$$v.name", "$name"] },
                      barcode: { $ifNull: ["$$v.barcode", ""] },
                      cost: { $ifNull: ["$$v.cost", "$cost"] },
                      price: { $ifNull: ["$$v.price", "$price"] },
                      price_tier: {
                        $cond: [
                          { $gt: [{ $size: { $ifNull: ["$$v.price_tier", []] } }, 0] },
                          "$$v.price_tier",
                          { $ifNull: ["$price_tier", []] },
                        ],
                      },
                      thumbnail: {
                        $cond: [
                          { $and: [{ $ne: ["$$v.thumbnail", null] }, { $ne: ["$$v.thumbnail", ""] }] },
                          "$$v.thumbnail",
                          { $ifNull: ["$thumbnail", ""] },
                        ],
                      },
                      images: {
                        $cond: [
                          { $gt: [{ $size: { $ifNull: ["$$v.images", []] } }, 0] },
                          "$$v.images",
                          { $ifNull: ["$images", []] },
                        ],
                      },
                      brand: { $ifNull: ["$brand", ""] },
                      categoryId: { $ifNull: ["$categoryId", null] },
                      categoryName: { $ifNull: ["$categoryName", ""] },
                      attributes: { $ifNull: ["$$v.attributes", []] },
                    },
                  },
                },
                [
                  {
                    _id: "$defaultVariantId",
                    isVariant: true,
                    productId: "$_id",
                    sku: "$sku",
                    name: "$name",
                    barcode: { $ifNull: ["$barcode", ""] },
                    cost: { $ifNull: ["$cost", 0] },
                    price: { $ifNull: ["$price", 0] },
                    price_tier: { $ifNull: ["$price_tier", []] },
                    thumbnail: { $ifNull: ["$thumbnail", ""] },
                    images: { $ifNull: ["$images", []] },
                    brand: { $ifNull: ["$brand", ""] },
                    categoryId: { $ifNull: ["$categoryId", null] },
                    categoryName: { $ifNull: ["$categoryName", ""] },
                    attributes: [],
                  },
                ],
              ],
            },
          },
        },

        { $unwind: "$_sellables" },

        // Join stock
        {
          $lookup: {
            from: VARIANT_STOCKS_COLLECTION,
            let: { vid: "$_sellables._id" },
            pipeline: lookupVariantStock,
            as: "_vstock",
          },
        },
        { $addFields: { _vs0: { $arrayElemAt: ["$_vstock", 0] } } },
        { $addFields: { stock: { $ifNull: ["$_vs0.totalQty", 0] } } },

        { $match: { "_sellables._id": { $ne: null } } },

        {
          $project: {
            _id: "$_sellables._id",
            isVariant: "$_sellables.isVariant",
            productId: "$_sellables.productId",
            sku: "$_sellables.sku",
            name: "$_sellables.name",
            brand: "$_sellables.brand",
            categoryId: "$_sellables.categoryId",
            categoryName: "$_sellables.categoryName",
            barcode: "$_sellables.barcode",
            cost: "$_sellables.cost",
            price: "$_sellables.price",
            price_tier: "$_sellables.price_tier",
            thumbnail: "$_sellables.thumbnail",
            images: "$_sellables.images",
            attributes: "$_sellables.attributes",
            isActive: "$isActive",
            stock: 1,
            updatedAt: "$updatedAt",
            createdAt: "$createdAt",
          },
        },

        ...(minPrice !== null || maxPrice !== null
          ? [
              {
                $match: {
                  price: {
                    ...(minPrice !== null && !Number.isNaN(minPrice) ? { $gte: minPrice } : {}),
                    ...(maxPrice !== null && !Number.isNaN(maxPrice) ? { $lte: maxPrice } : {}),
                  },
                },
              },
            ]
          : []),

        {
          $facet: {
            items: [
              { $sort: { [sortBy]: sortOrder } },
              { $skip: skip },
              { $limit: limit }
            ],
            total: [{ $count: "count" }],
          },
        },
      ]);

      const items = agg?.[0]?.items || [];
      const total = agg?.[0]?.total?.[0]?.count || 0;

      return res.json({
        ok: true,
        category: {
          _id: category._id,
          name: category.name,
          code: category.code,
          level: category.level,
        },
        includeSubcategories,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        branchId: isAll ? null : String(branchObjId),
        items,
        mode: "pos",
      });
    }

    // Default fallback
    return res.status(400).json({ 
      ok: false, 
      message: "INVALID_MODE" 
    });
  })
);

// ===============================
// GET /api/products/flash-sale - Lấy products đang flash sale
// ===============================
router.get(
  "/flash-sale",
  authRequired,
  asyncHandler(async (req, res) => {
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const query = {
      isActive: true,
      activeFlashSaleId: { $ne: null },
      flashSaleEndDate: { $gte: new Date() }
    };

    const [items, total] = await Promise.all([
      Product.find(query)
        .populate("activeFlashSaleId", "name code startDate endDate")
        .sort({ flashSaleStartDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Product.countDocuments(query)
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
// ✅ PUT /variants/:id  (UPDATE VARIANT)
// URL: /api/products/variants/:id
// ===============================
router.put(
  "/variants/:id",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const variantId = req.params.id;
    if (!isValidObjectId(variantId)) return res.status(400).json({ ok: false, message: "INVALID_VARIANT_ID" });

    const body = z
      .object({
        sku: z.string().min(2).optional(),
        barcode: z.string().optional(),
        name: z.string().min(1).optional(),

        // attributes: [{k,v}]
        attributes: z.array(z.object({ k: z.string().min(1), v: z.string().min(1) })).optional(),

        price: z.number().nonnegative().optional(),
        cost: z.number().nonnegative().optional(),
        price_tier: z.array(z.object({ tierId: z.string(), price: z.number().nonnegative() })).optional(),

        thumbnail: z.string().optional(),
        images: z.array(z.object({ url: z.string(), isPrimary: z.boolean().optional(), order: z.number().optional() })).optional(),

        isActive: z.boolean().optional(),
        isDefault: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const patch = { ...body.data };

    // normalize money
    if (patch.price !== undefined) patch.price = Math.round(Number(patch.price || 0));
    if (patch.cost !== undefined) patch.cost = Math.round(Number(patch.cost || 0));

    // normalize price_tier
    if ("price_tier" in patch) {
      try {
        patch.price_tier = normalizePriceTier(patch.price_tier);
      } catch (e) {
        return res.status(400).json({ ok: false, message: String(e?.code || e?.message || "INVALID_PRICE_TIER") });
      }
    }

    // normalize attributes
    if ("attributes" in patch) {
      patch.attributes = (patch.attributes || [])
        .map((x) => ({ k: String(x.k || "").trim(), v: String(x.v || "").trim() }))
        .filter((x) => x.k && x.v);
    }

    // normalize images + thumbnail
    if ("images" in patch) {
      let images = (patch.images || [])
        .map((img) => ({
          url: normalizeUrl(img.url),
          isPrimary: !!img.isPrimary,
          order: Number(img.order || 0),
        }))
        .filter((x) => x.url);

      let thumbnail = "thumbnail" in patch ? normalizeUrl(patch.thumbnail) : "";

      if (!thumbnail && images.length) {
        const primary = images.find((x) => x.isPrimary) || images[0];
        thumbnail = primary.url;
      }

      if (thumbnail && images.length) {
        const { next } = ensureOnePrimary(images, thumbnail);
        images = next;
      }

      patch.images = images;
      if ("thumbnail" in patch) patch.thumbnail = thumbnail;
    } else if ("thumbnail" in patch) {
      patch.thumbnail = normalizeUrl(patch.thumbnail);
    }

    // update variant
    const vdoc = await ProductVariant.findByIdAndUpdate(variantId, { $set: patch }, { new: true });
    if (!vdoc) return res.status(404).json({ ok: false, message: "VARIANT_NOT_FOUND" });

    // nếu set isDefault=true => unset default của các variant khác cùng product
    if (patch.isDefault === true && vdoc.productId) {
      await ProductVariant.updateMany(
        { productId: vdoc.productId, _id: { $ne: vdoc._id } },
        { $set: { isDefault: false } }
      );

      // đồng bộ defaultVariantId lên Product
      await Product.updateOne({ _id: vdoc.productId }, { $set: { defaultVariantId: vdoc._id, hasVariants: true } });
    }

    const ver = await nextVersion();
    await ChangeLog.create({
      branchId: null,
      collection: PRODUCT_VARIANTS_COLLECTION,
      docId: vdoc._id,
      action: "UPSERT",
      version: ver,
    });

    res.json({ ok: true, variant: vdoc, version: ver });
  })
);

// ===============================
// ✅ POST /variants/:id/images (UPLOAD IMAGES)
// ===============================
router.post(
  "/variants/:id/images",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  upload.array("files", 8),
  asyncHandler(async (req, res) => {
    const variantId = req.params.id;
    if (!isValidObjectId(variantId)) return res.status(400).json({ ok: false, message: "INVALID_VARIANT_ID" });

    const vdoc = await ProductVariant.findById(variantId);
    if (!vdoc) return res.status(404).json({ ok: false, message: "VARIANT_NOT_FOUND" });

    const uploadedFiles = Array.isArray(req.files) ? req.files : [];
    if (!uploadedFiles || uploadedFiles.length === 0) {
      return res.status(400).json({ ok: false, message: "NO_FILES" });
    }

    const primaryIndex = Number(req.query.primaryIndex || 0);

    const newImages = uploadedFiles.map((file, idx) => ({
      url: `/uploads/${file.filename}`,
      isPrimary: idx === primaryIndex,
      order: idx,
    }));

    const existingImages = Array.isArray(vdoc.images) ? vdoc.images : [];
    const allImages = [...existingImages.map(img => ({ ...img, isPrimary: false })), ...newImages];

    const { next } = ensureOnePrimary(allImages, newImages[primaryIndex]?.url || "");
    const thumbnail = next.find(x => x.isPrimary)?.url || (newImages[primaryIndex]?.url || "");

    vdoc.images = next;
    vdoc.thumbnail = thumbnail;
    await vdoc.save();

    const ver = await nextVersion();
    await ChangeLog.create({
      branchId: null,
      collection: PRODUCT_VARIANTS_COLLECTION,
      docId: vdoc._id,
      action: "UPSERT",
      version: ver,
    });

    res.json({ ok: true, variant: vdoc, images: next, thumbnail, version: ver });
  })
);


module.exports = router;
