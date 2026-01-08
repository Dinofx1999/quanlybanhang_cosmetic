const router = require("express").Router();
const { z } = require("zod");

const Product = require("../models/Product");
const ChangeLog = require("../models/ChangeLog");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

const mongoose = require("mongoose"); // ✅ ADD
const fs = require("fs");
const path = require("path");
const { upload, buildFileUrl, UPLOAD_DIR,getFilenameFromUrl } = require("../middlewares/uploadProductImages"); // ✅ ADD


async function nextVersion() {
  const last = await ChangeLog.findOne().sort({ version: -1 }).lean();
  return (last?.version || 0) + 1;
}

// Upload nhiều ảnh cho 1 product
// POST /api/products/:id/images?primaryIndex=0
// form-data: files (multi)
router.post(
  "/:id/images",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  upload.array("files", 8),
  asyncHandler(async (req, res) => {
    const productId = req.params.id;

    // validate objectId
    if (!mongoose.isValidObjectId(productId)) {
      for (const f of req.files || []) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, f.filename)); } catch {}
      }
      return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });
    }

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, message: "MISSING_FILES" });

    // primaryIndex: mặc định 0 (luôn có ảnh chính trong batch mới)
    const primaryIndexRaw = req.query.primaryIndex;
    let primaryIndex = primaryIndexRaw === undefined ? 0 : Number(primaryIndexRaw);
    if (Number.isNaN(primaryIndex)) primaryIndex = 0;
    if (primaryIndex < 0) primaryIndex = 0;
    if (primaryIndex >= files.length) primaryIndex = 0;

    const p = await Product.findById(productId);
    if (!p) {
      for (const f of files) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, f.filename)); } catch {}
      }
      return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });
    }

    // tạo new images
    const newImages = files.map((f, idx) => ({
      url: buildFileUrl(req, f.filename),
      isPrimary: idx === primaryIndex,
      order: 0,
    }));

    // ✅ đảm bảo chỉ 1 primary trong toàn bộ product:
    // 1) clear primary cũ
    p.images = (p.images || []).map((x) => ({
      ...(x.toObject?.() || x),
      isPrimary: false,
    }));

    // 2) push ảnh mới
    p.images.push(...newImages);

    // 3) set thumbnail theo ảnh primary của batch mới
    p.thumbnail = newImages[primaryIndex].url;

    // 4) nếu vì lý do nào đó vẫn chưa có primary => set ảnh đầu tiên làm primary
    const hasPrimary = (p.images || []).some((x) => x.isPrimary);
    if (!hasPrimary && (p.images || []).length > 0) {
      p.images = p.images.map((x, idx) => ({
        ...(x.toObject?.() || x),
        isPrimary: idx === 0,
      }));
      p.thumbnail = p.images[0].url;
    }

    await p.save();

    // changelog
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

// UPDATE product
// PUT /api/products/:id
router.put(
  "/:id",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });
    }

    const body = z
      .object({
        sku: z.string().min(2).optional(),
        name: z.string().min(2).optional(),
        price: z.number().int().nonnegative().optional(),
        cost: z.number().int().nonnegative().optional(),
        barcode: z.string().optional(),
        brand: z.string().optional(),
        categoryId: z.string().optional().nullable(),
        categoryName: z.string().optional(),
        thumbnail: z.string().optional(),
        isActive: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({ ok: false, error: body.error.flatten() });
    }

    const data = body.data;

    // categoryId nếu có thì validate ObjectId, còn null thì cho phép xoá
    if (data.categoryId !== undefined && data.categoryId !== null) {
      if (!mongoose.isValidObjectId(data.categoryId)) {
        return res.status(400).json({ ok: false, message: "INVALID_CATEGORY_ID" });
      }
    }

    const update = {};
    for (const k of Object.keys(data)) {
      if (data[k] !== undefined) update[k] = data[k];
    }

    // ✅ đảm bảo sku upper
    if (update.sku) update.sku = String(update.sku).trim().toUpperCase();
    if (update.name) update.name = String(update.name).trim();
    if (update.brand !== undefined) update.brand = String(update.brand || "").trim();
    if (update.barcode !== undefined) update.barcode = String(update.barcode || "").trim();
    if (update.categoryName !== undefined) update.categoryName = String(update.categoryName || "").trim();

    // nếu categoryId null => clear luôn categoryName (tuỳ bạn)
    if (update.categoryId === null) {
      update.categoryName = "";
    }

    const p = await Product.findByIdAndUpdate(productId, update, {
      new: true,
      runValidators: true,
    });

    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    // ✅ changelog version
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



router.get("/", authRequired, asyncHandler(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const barcode = String(req.query.barcode || "").trim();

  const categoryId = req.query.categoryId;
  const brand = String(req.query.brand || "").trim();

  const minPrice = req.query.minPrice ? Number(req.query.minPrice) : null;
  const maxPrice = req.query.maxPrice ? Number(req.query.maxPrice) : null;

  const isActive = req.query.isActive !== undefined
    ? req.query.isActive === "true"
    : true;

  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const skip = (page - 1) * limit;

  const sortBy = req.query.sortBy || "updatedAt";
  const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

  const filter = { isActive };

  // ===== filters =====
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

  // ===== query =====
  const [items, total] = await Promise.all([
    Product.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(limit)
      .lean(),
    Product.countDocuments(filter),
  ]);

  res.json({
    ok: true,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    items,
  });
}));


router.post("/", authRequired, requireRole(["ADMIN", "MANAGER"]), asyncHandler(async (req, res) => {
  const body = z.object({
    sku: z.string().min(2),
    name: z.string().min(2),
    price: z.number().int().nonnegative(),
    cost: z.number().int().nonnegative().optional(),
    barcode: z.string().optional(),
    brand: z.string().optional(),

    // 👇 THÊM 2 FIELD NÀY
    categoryId: z.string().optional(),
    categoryName: z.string().optional()
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  const p = await Product.create({
    ...body.data,
  categoryId: body.data.categoryId || null,
  categoryName: body.data.categoryName || "",
  });

  const v = await nextVersion();
  await ChangeLog.create({ branchId: null, collection: "products", docId: p._id, action: "UPSERT", version: v });

  res.json({ ok: true, product: p, version: v });
}));

// DELETE /api/products/:id/images
// body: { url: "http://localhost:3000/uploads/products/xxx.jpg" }
router.delete(
  "/:id/images",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });
    }

    const body = z.object({ url: z.string().min(5) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const url = String(body.data.url).trim();

    const p = await Product.findById(productId);
    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    const removed = (p.images || []).find((x) => x.url === url);
    if (!removed) return res.status(404).json({ ok: false, message: "IMAGE_NOT_FOUND" });

    // remove from db
    p.images = (p.images || []).filter((x) => x.url !== url);

    // nếu xoá thumbnail
    if (p.thumbnail === url) {
      const primary = (p.images || []).find((x) => x.isPrimary);
      p.thumbnail = primary?.url || (p.images?.[0]?.url || "");
    }

    // nếu xoá mất primary => set ảnh đầu làm primary
    const stillHasPrimary = (p.images || []).some((x) => x.isPrimary);
    if (!stillHasPrimary && (p.images || []).length > 0) {
      p.images = p.images.map((x, idx) => ({
        ...(x.toObject?.() || x),
        isPrimary: idx === 0,
      }));
      p.thumbnail = p.images[0].url;
    }

    await p.save();

    // delete file (best-effort)
    const filename = getFilenameFromUrl(url);
    if (filename) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, filename)); } catch {}
    }

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
      removedUrl: url,
      thumbnail: p.thumbnail,
      images: p.images,
      version: v,
    });
  })
);

// SET PRIMARY image by url
// PATCH /api/products/:id/images/primary
// body: { url: "http://localhost:3000/uploads/products/xxx.jpg" }
router.patch(
  "/:id/images/primary",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });
    }

    const body = z.object({ url: z.string().min(5) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const url = String(body.data.url).trim();

    const p = await Product.findById(productId);
    if (!p) return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });

    const exists = (p.images || []).some((x) => x.url === url);
    if (!exists) return res.status(404).json({ ok: false, message: "IMAGE_NOT_FOUND" });

    p.images = (p.images || []).map((x) => ({
      ...(x.toObject?.() || x),
      isPrimary: x.url === url,
    }));
    p.thumbnail = url;

    await p.save();

    const v = await nextVersion();
    await ChangeLog.create({
      branchId: null,
      collection: "products",
      docId: p._id,
      action: "UPSERT",
      version: v,
    });

    res.json({ ok: true, thumbnail: p.thumbnail, images: p.images, version: v });
  })
);



module.exports = router;
