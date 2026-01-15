// routes/products.js
const router = require("express").Router();
const { z } = require("zod");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const Product = require("../models/Product");
const ChangeLog = require("../models/ChangeLog");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

const { upload, buildFileUrl, UPLOAD_DIR } = require("../middlewares/uploadProductImages");

// ✅ collection stocks thực tế
const STOCKS_COLLECTION = "stocks";

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
async function nextVersion() {
  const last = await ChangeLog.findOne().sort({ version: -1 }).lean();
  return (last?.version || 0) + 1;
}

// STAFF: luôn lấy branchId trong token
// ADMIN/MANAGER: query branchId (all / id), default all
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

  // nếu url không tồn tại -> không sửa
  return { next, found };
}

function tryDeleteLocalUploadByUrl(url) {
  // chỉ xoá nếu url thuộc uploads/products (cùng host cũng ok)
  try {
    const u = new URL(url);
    const pathname = decodeURIComponent(u.pathname || "");
    const filename = pathname.split("/").pop();
    if (!filename) return;

    const localPath = path.join(UPLOAD_DIR, filename);
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
  } catch {
    // nếu url không parse được, bỏ qua
  }
}

// ===============================
// ✅ PRICE TIER HELPERS (NEW)
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
// IMAGES
// ===============================

// Upload nhiều ảnh cho 1 product
// POST /api/products/:id/images?primaryIndex=0
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

    // nếu có primaryIndex hợp lệ -> clear primary cũ, set thumbnail theo ảnh mới
    if (primaryIndex >= 0 && primaryIndex < newImages.length) {
      p.images = (p.images || []).map((x) => ({
        ...(x.toObject?.() || x),
        isPrimary: false,
      }));
      p.thumbnail = newImages[primaryIndex].url;
    }

    p.images = p.images || [];
    p.images.push(...newImages);

    // nếu chưa có thumbnail -> lấy ảnh đầu
    if (!p.thumbnail && newImages[0]) p.thumbnail = newImages[0].url;

    // đảm bảo chỉ 1 primary (nếu thumbnail trùng 1 ảnh)
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

// Set primary theo URL
// PUT /api/products/:id/images/primary  body { url }
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

// Delete image theo URL
// DELETE /api/products/:id/images?url=...
router.delete(
  "/:id/images",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!isValidObjectId(productId)) return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });

    // nhận từ query hoặc body
    const url = normalizeUrl(req.query.url || req.body?.url);
    if (!url) return res.status(400).json({ ok: false, message: "MISSING_URL" });

    const p = await Product.findById(productId);
    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    const before = (p.images || []).map((x) => x.toObject?.() || x);
    const kept = before.filter((x) => normalizeUrl(x.url) !== url);
    if (kept.length === before.length) return res.status(404).json({ ok: false, message: "IMAGE_NOT_FOUND" });

    // xoá file local (nếu thuộc uploads)
    tryDeleteLocalUploadByUrl(url);

    const removedWasPrimary = before.some((x) => normalizeUrl(x.url) === url && !!x.isPrimary);

    let nextImages = kept;

    if (removedWasPrimary && nextImages.length > 0) {
      // đôn ảnh đầu làm primary
      nextImages = nextImages.map((x, idx) => ({ ...x, isPrimary: idx === 0 }));
      p.thumbnail = nextImages[0].url;
    } else {
      // nếu thumbnail bị xoá -> chọn primary còn lại hoặc ảnh đầu
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
// LIST PRODUCTS + STOCK
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

    /** ✅ filter product */
    const filter = { isActive };

    // categoryId: hỗ trợ cả ObjectId và string tuỳ DB đang lưu kiểu nào
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
        // nếu đã có $or (do categoryId), gộp thành $and để không phá logic
        filter.$and = [{ $or: filter.$or }, { $or: or }];
        delete filter.$or;
      } else {
        filter.$or = or;
      }
    }

    const isAll = branchResolved === "all";
    const branchObjId = isAll ? null : toObjectIdOrNull(branchResolved);

    if (!isAll && !branchObjId) {
      return res.status(400).json({ ok: false, message: "INVALID_BRANCH_ID" });
    }

    const lookupPipeline = isAll
      ? [
          { $match: { $expr: { $eq: ["$productId", "$$pid"] } } },
          { $group: { _id: "$productId", totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
        ]
      : [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ["$productId", "$$pid"] }, { $eq: ["$branchId", branchObjId] }],
              },
            },
          },
          { $group: { _id: "$productId", totalQty: { $sum: { $ifNull: ["$qty", 0] } } } },
        ];

    const agg = await Product.aggregate([
      { $match: filter },
      {
        $facet: {
          items: [
            { $sort: { [sortBy]: sortOrder } },
            { $skip: skip },
            { $limit: limit },
            {
              $lookup: {
                from: STOCKS_COLLECTION,
                let: { pid: "$_id" },
                pipeline: lookupPipeline,
                as: "_stock",
              },
            },
            { $addFields: { _s0: { $arrayElemAt: ["$_stock", 0] } } },
            { $addFields: { stock: { $ifNull: ["$_s0.totalQty", 0] } } },
            { $project: { _stock: 0, _s0: 0 } },
          ],
          total: [{ $count: "count" }],
        },
      },
    ]);

    const items = agg?.[0]?.items || [];
    const total = agg?.[0]?.total?.[0]?.count || 0;

    res.json({
      ok: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      branchId: isAll ? null : String(branchObjId),
      items,
    });
  })
);

// ===============================
// CREATE PRODUCT  ✅ add price_tier
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

        // ✅ NEW: price_tier
        price_tier: z
          .array(
            z.object({
              tierId: z.string(),
              price: z.number().nonnegative(),
            })
          )
          .optional(),

        // images / thumbnail
        thumbnail: z.string().optional(),
        images: z
          .array(
            z.object({
              url: z.string(),
              isPrimary: z.boolean().optional(),
              order: z.number().optional(),
            })
          )
          .optional(),
        isActive: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const data = body.data;

    // normalize categoryId: cho phép null, ObjectId, hoặc string
    let categoryId = null;
    if (data.categoryId === null) categoryId = null;
    else if (typeof data.categoryId === "string" && data.categoryId.trim()) {
      const s = data.categoryId.trim();
      categoryId = isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : s;
    }

    // ✅ normalize price_tier
    let price_tier = [];
    try {
      price_tier = normalizePriceTier(data.price_tier);
    } catch (e) {
      return res.status(400).json({ ok: false, message: String(e?.code || e?.message || "INVALID_PRICE_TIER") });
    }

    // normalize images
    let images = Array.isArray(data.images) ? data.images : [];
    images = images
      .map((img) => ({
        url: normalizeUrl(img.url),
        isPrimary: !!img.isPrimary,
        order: Number(img.order || 0),
      }))
      .filter((x) => x.url);

    let thumbnail = normalizeUrl(data.thumbnail);

    // nếu có images mà chưa có thumbnail -> lấy primary hoặc ảnh đầu
    if (!thumbnail && images.length) {
      const primary = images.find((x) => x.isPrimary) || images[0];
      thumbnail = primary.url;
    }

    // đảm bảo only one primary theo thumbnail
    if (thumbnail && images.length) {
      const { next } = ensureOnePrimary(images, thumbnail);
      images = next;
    }

    const p = await Product.create({
      sku: data.sku,
      name: data.name,
      price: Math.round(Number(data.price || 0)),
      cost: data.cost !== undefined ? Math.round(Number(data.cost || 0)) : undefined,
      barcode: data.barcode || "",
      brand: data.brand || "",
      categoryId,
      categoryName: data.categoryName || "",

      // ✅
      price_tier,

      thumbnail,
      images,
      isActive: data.isActive !== undefined ? !!data.isActive : true,
    });

    const v = await nextVersion();
    await ChangeLog.create({
      branchId: null,
      collection: "products",
      docId: p._id,
      action: "UPSERT",
      version: v,
    });

    res.json({ ok: true, product: p, version: v });
  })
);

// ===============================
// UPDATE PRODUCT ✅ add price_tier
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

        // ✅ NEW: price_tier
        price_tier: z
          .array(
            z.object({
              tierId: z.string(),
              price: z.number().nonnegative(),
            })
          )
          .optional(),

        // thumbnail/images
        thumbnail: z.string().optional(),
        images: z
          .array(
            z.object({
              url: z.string(),
              isPrimary: z.boolean().optional(),
              order: z.number().optional(),
            })
          )
          .optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const patch = { ...body.data };

    // normalize categoryId
    if ("categoryId" in patch) {
      if (patch.categoryId === null) patch.categoryId = null;
      else if (typeof patch.categoryId === "string") {
        const s = patch.categoryId.trim();
        patch.categoryId = s ? (isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : s) : null;
      }
    }

    // ✅ normalize price_tier (if present)
    if ("price_tier" in patch) {
      try {
        patch.price_tier = normalizePriceTier(patch.price_tier);
      } catch (e) {
        return res.status(400).json({ ok: false, message: String(e?.code || e?.message || "INVALID_PRICE_TIER") });
      }
    }

    // normalize images/thumbnail (nếu có gửi lên)
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

    // round price/cost
    if (patch.price !== undefined) patch.price = Math.round(Number(patch.price || 0));
    if (patch.cost !== undefined) patch.cost = Math.round(Number(patch.cost || 0));

    const p = await Product.findByIdAndUpdate(productId, { $set: patch }, { new: true });
    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    const v = await nextVersion();
    await ChangeLog.create({ branchId: null, collection: "products", docId: p._id, action: "UPSERT", version: v });

    res.json({ ok: true, product: p, version: v });
  })
);

module.exports = router;
