const router = require("express").Router();
const { z } = require("zod");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const Product = require("../models/Product");
const ChangeLog = require("../models/ChangeLog");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

const {
  upload,
  buildFileUrl,
  UPLOAD_DIR,
} = require("../middlewares/uploadProductImages");

// ✅ Collection thực tế của bạn
const STOCKS_COLLECTION = "stocks";

async function nextVersion() {
  const last = await ChangeLog.findOne().sort({ version: -1 }).lean();
  return (last?.version || 0) + 1;
}

function getRole(req) {
  return String(req.user?.role || "").toUpperCase();
}
function isValidObjectId(id) {
  return mongoose.isValidObjectId(String(id || ""));
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

function toObjectIdOrNull(id) {
  const s = String(id || "");
  if (!s) return null;
  if (!isValidObjectId(s)) return null;
  return new mongoose.Types.ObjectId(s);
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
    if (!files.length) return res.status(400).json({ ok: false, message: "Missing files" });

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

    const url = String(req.body?.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, message: "MISSING_URL" });

    const p = await Product.findById(productId);
    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    const imgs = p.images || [];
    let found = false;

    p.images = imgs.map((img) => {
      const obj = img.toObject?.() || img;
      const isHit = String(obj.url) === url;
      if (isHit) found = true;
      return { ...obj, isPrimary: isHit };
    });

    if (!found) return res.status(404).json({ ok: false, message: "IMAGE_NOT_FOUND" });

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

    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, message: "MISSING_URL" });

    const p = await Product.findById(productId);
    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    const before = (p.images || []).map((x) => x.toObject?.() || x);
    const kept = before.filter((x) => String(x.url) !== url);
    if (kept.length === before.length) return res.status(404).json({ ok: false, message: "IMAGE_NOT_FOUND" });

    // xoá file local nếu url thuộc uploads/products
    try {
      const u = new URL(url);
      const pathname = decodeURIComponent(u.pathname || "");
      const filename = pathname.split("/").pop();
      if (filename) {
        const localPath = path.join(UPLOAD_DIR, filename);
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      }
    } catch {}

    const removedWasPrimary = before.some((x) => String(x.url) === url && !!x.isPrimary);

    let nextImages = kept;
    if (removedWasPrimary && nextImages.length > 0) {
      nextImages = nextImages.map((x, idx) => ({ ...x, isPrimary: idx === 0 }));
      p.thumbnail = nextImages[0].url;
    } else {
      if (String(p.thumbnail || "") === url) {
        const primary = nextImages.find((x) => x.isPrimary) || nextImages[0];
        p.thumbnail = primary ? primary.url : "";
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
// LIST PRODUCTS + STOCK (SUM qty from "stocks")
// ===============================
// GET /api/products?branchId=<id|all>&q=&barcode=&brand=&categoryId=&minPrice=&maxPrice=&page=&limit=
router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const role = getRole(req);
    const branchResolved = resolveBranchId(req);

    // STAFF mà thiếu branchId -> lỗi
    if (role === "STAFF" && !branchResolved) {
      return res.status(400).json({ ok: false, message: "STAFF_MISSING_BRANCH_ID" });
    }

    const q = String(req.query.q || "").trim();
    const barcode = String(req.query.barcode || "").trim();
    const categoryId = req.query.categoryId ? String(req.query.categoryId) : "";
    const brand = String(req.query.brand || "").trim();

    const minPrice = req.query.minPrice ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice ? Number(req.query.maxPrice) : null;

    const isActive =
      req.query.isActive !== undefined ? String(req.query.isActive) === "true" : true;

    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const sortBy = String(req.query.sortBy || "updatedAt");
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

    // product filter
    const filter = { isActive };

    if (categoryId) filter.categoryId = categoryId;
    if (barcode) filter.barcode = barcode;
    if (brand) filter.brand = brand;

    if (minPrice !== null || maxPrice !== null) {
      filter.price = {};
      if (minPrice !== null) filter.price.$gte = minPrice;
      if (maxPrice !== null) filter.price.$lte = maxPrice;
    }

    if (q) {
      filter.$or = [
        { name: { $regex: q, $options: "i" } },
        { sku: { $regex: q, $options: "i" } },
        { barcode: { $regex: q, $options: "i" } },
      ];
    }

    const isAll = branchResolved === "all";
    const branchObjId = isAll ? null : toObjectIdOrNull(branchResolved);

    // ADMIN/MANAGER truyền branchId sai => báo rõ
    if (!isAll && !branchObjId) {
      return res.status(400).json({ ok: false, message: "INVALID_BRANCH_ID" });
    }

    // lookup stocks:
    // stocks.productId:ObjectId == products._id
    // stocks.branchId:ObjectId == branchObjId (nếu không all)
    const lookupPipeline = isAll
      ? [
          { $match: { $expr: { $eq: ["$productId", "$$pid"] } } },
          {
            $group: {
              _id: "$productId",
              totalQty: { $sum: { $ifNull: ["$qty", 0] } },
            },
          },
        ]
      : [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$productId", "$$pid"] },
                  { $eq: ["$branchId", branchObjId] },
                ],
              },
            },
          },
          {
            $group: {
              _id: "$productId",
              totalQty: { $sum: { $ifNull: ["$qty", 0] } },
            },
          },
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
                let: { pid: "$_id" }, // ObjectId
                pipeline: lookupPipeline,
                as: "_stock",
              },
            },
            { $addFields: { _s0: { $arrayElemAt: ["$_stock", 0] } } },
            {
              $addFields: {
                stock: { $ifNull: ["$_s0.totalQty", 0] }, // ✅ output stock
              },
            },
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
// CREATE PRODUCT
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
        price: z.number().int().nonnegative(),
        cost: z.number().int().nonnegative().optional(),
        barcode: z.string().optional(),
        brand: z.string().optional(),
        categoryId: z.string().optional(),
        categoryName: z.string().optional(),
      })
      .safeParse(req.body);

    if (!body.success)
      return res.status(400).json({ ok: false, error: body.error.flatten() });

    const p = await Product.create({
      ...body.data,
      categoryId: body.data.categoryId || null,
      categoryName: body.data.categoryName || "",
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
// UPDATE PRODUCT
// ===============================
router.put(
  "/:id",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!isValidObjectId(productId))
      return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });

    const body = z
      .object({
        sku: z.string().min(2).optional(),
        name: z.string().min(2).optional(),
        price: z.number().int().nonnegative().optional(),
        cost: z.number().int().nonnegative().optional(),
        barcode: z.string().optional(),
        brand: z.string().optional(),
        categoryId: z.string().nullable().optional(),
        categoryName: z.string().optional(),
        isActive: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!body.success)
      return res.status(400).json({ ok: false, error: body.error.flatten() });

    const p = await Product.findByIdAndUpdate(productId, { $set: body.data }, { new: true });
    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    const v = await nextVersion();
    await ChangeLog.create({ branchId: null, collection: "products", docId: p._id, action: "UPSERT", version: v });

    res.json({ ok: true, product: p, version: v });
  })
);

module.exports = router;
