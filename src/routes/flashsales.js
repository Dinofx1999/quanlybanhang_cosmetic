// routes/flashsales.js
const router = require("express").Router();
const mongoose = require("mongoose");

const FlashSale = require("../models/FlashSale");
const Product = require("../models/Product"); // <-- đổi path nếu khác

// ===== Helpers
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id));
const now = () => new Date();

// placeholder auth middleware (tự thay bằng auth của bạn)
const requireAdmin = (req, res, next) => next();

// ===== Build match for branch/tier
function buildScopeMatch({ branchId, tierId }) {
  const and = [];

  if (branchId && isValidObjectId(branchId)) {
    and.push({
      $or: [{ branchIds: { $size: 0 } }, { branchIds: new mongoose.Types.ObjectId(branchId) }],
    });
  }

  if (tierId && isValidObjectId(tierId)) {
    and.push({
      $or: [{ tierIds: { $size: 0 } }, { tierIds: new mongoose.Types.ObjectId(tierId) }],
    });
  }

  return and.length ? { $and: and } : {};
}

// ===== Convert flash product rule -> effective price
function calcFlashPrice({ basePrice, flashPrice, discountPercent }) {
  const bp = Number(basePrice || 0);
  const fp = Number(flashPrice || 0);
  const dp = Number(discountPercent || 0);

  // ưu tiên flashPrice nếu có
  if (fp > 0) return fp;

  // nếu dùng discountPercent
  if (bp > 0 && dp > 0) {
    const discounted = Math.round(bp * (1 - dp / 100));
    return Math.max(0, discounted);
  }

  return 0;
}

/**
 * =========================================================
 * PUBLIC APIs  ✅ ĐẶT TRƯỚC /:id để tránh bị nuốt route
 * =========================================================
 */

// [GET] /api/flashsales/public/active?branchId=&tierId=
router.get("/public/active", async (req, res) => {
  try {
    const { branchId, tierId } = req.query;

    const query = {
      isActive: true,
      status: "ACTIVE",
      startDate: { $lte: now() },
      endDate: { $gte: now() },
      ...buildScopeMatch({ branchId, tierId }),
    };

    const sales = await FlashSale.find(query).sort({ priority: -1, startDate: 1 });
    return res.json({ ok: true, items: sales });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "SERVER_ERROR" });
  }
});

// [GET] /api/flashsales/public/active-products?branchId=&tierId=&limit=20
// trả về list sản phẩm flash sale (join Product)
router.get("/public/active-products", async (req, res) => {
  try {
    const { branchId, tierId, limit = 20 } = req.query;

    const query = {
      isActive: true,
      status: "ACTIVE",
      startDate: { $lte: now() },
      endDate: { $gte: now() },
      ...buildScopeMatch({ branchId, tierId }),
    };

    const sale = await FlashSale.findOne(query).sort({ priority: -1, startDate: 1 });
    if (!sale) return res.json({ ok: true, sale: null, items: [] });

    const productIds = (sale.products || []).filter((x) => x.isActive).map((x) => x.productId);
    const products = await Product.find({ _id: { $in: productIds }, isActive: true }).limit(Number(limit));

    // map rule
    const ruleMap = new Map();
    for (const r of sale.products) ruleMap.set(String(r.productId), r);

    const items = products.map((p) => {
      const r = ruleMap.get(String(p._id));
      const base = Number(p.basePrice ?? p.price ?? 0);
      const flash = calcFlashPrice({
        basePrice: base,
        flashPrice: r?.flashPrice,
        discountPercent: r?.discountPercent,
      });

      return {
        product: p,
        flashSale: {
          flashSaleId: sale._id,
          name: sale.name,
          endDate: sale.endDate,
          flashPrice: flash,
          discountPercent: r?.discountPercent || 0,
          limitedQuantity: r?.limitedQuantity ?? null,
          soldQuantity: r?.soldQuantity || 0,
          badge: r?.badge || "",
        },
      };
    });

    return res.json({
      ok: true,
      sale: { _id: sale._id, name: sale.name, endDate: sale.endDate },
      items,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "SERVER_ERROR" });
  }
});

/**
 * =========================================================
 * "APPLY" flash sale onto a product list
 * - dùng để bạn gộp vào response list products theo category
 * =========================================================
 *
 * [POST] /api/flashsales/public/apply
 * body: { productIds:[], branchId?, tierId? }
 * return: map { [productId]: { isFlashSale, flashSalePrice, flashSaleEndDate, maxDiscount, badge, flashSaleId } }
 */
router.post("/public/apply", async (req, res) => {
  try {
    const { productIds = [], branchId, tierId } = req.body || {};
    const ids = (Array.isArray(productIds) ? productIds : []).filter(isValidObjectId);

    if (!ids.length) return res.json({ ok: true, map: {} });

    const query = {
      isActive: true,
      status: "ACTIVE",
      startDate: { $lte: now() },
      endDate: { $gte: now() },
      ...buildScopeMatch({ branchId, tierId }),
      "products.productId": { $in: ids.map((x) => new mongoose.Types.ObjectId(x)) },
    };

    // sale ưu tiên cao nhất
    const sales = await FlashSale.find(query).sort({ priority: -1, startDate: 1 });
    if (!sales.length) return res.json({ ok: true, map: {} });

    // Lấy basePrice products
    const products = await Product.find({ _id: { $in: ids }, isActive: true }).select("_id basePrice price");
    const baseMap = new Map(products.map((p) => [String(p._id), Number(p.basePrice ?? p.price ?? 0)]));

    const out = {};
    for (const sale of sales) {
      for (const r of sale.products || []) {
        const pid = String(r.productId);
        if (!ids.includes(pid)) continue;
        if (!r.isActive) continue;
        if (out[pid]) continue; // đã set bởi sale priority cao hơn

        const base = baseMap.get(pid) || 0;
        const fp = calcFlashPrice({
          basePrice: base,
          flashPrice: r.flashPrice,
          discountPercent: r.discountPercent,
        });

        out[pid] = {
          isFlashSale: fp > 0,
          flashSaleId: sale._id,
          flashSalePrice: fp > 0 ? fp : null,
          flashSaleEndDate: sale.endDate,
          maxDiscount: Number(r.discountPercent || 0),
          badge: r.badge || "",
        };
      }
    }

    return res.json({ ok: true, map: out });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "SERVER_ERROR" });
  }
});

/**
 * =========================================================
 * ADMIN APIs
 * =========================================================
 */

// [POST] /api/flashsales  (create)
router.post("/", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};

    if (!body.name || !body.code || !body.startDate || !body.endDate) {
      return res
        .status(400)
        .json({ ok: false, message: "Missing required fields (name, code, startDate, endDate)." });
    }

    const doc = new FlashSale({
      name: String(body.name).trim(),
      code: String(body.code).trim().toUpperCase(),
      description: body.description || "",
      startDate: new Date(body.startDate),
      endDate: new Date(body.endDate),
      banner: body.banner || "",
      images: Array.isArray(body.images) ? body.images : [],
      branchIds: Array.isArray(body.branchIds) ? body.branchIds : [],
      tierIds: Array.isArray(body.tierIds) ? body.tierIds : [],
      priority: Number(body.priority || 0),
      status: body.status || "DRAFT",
      isActive: body.isActive !== false,
      products: Array.isArray(body.products) ? body.products : [],
      createdBy: req.user?._id,
      updatedBy: req.user?._id,
    });

    doc.updateStatus?.();
    await doc.save();

    return res.json({ ok: true, flashSale: doc });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "SERVER_ERROR" });
  }
});

// [GET] /api/flashsales (list)
router.get("/", requireAdmin, async (req, res) => {
  try {
    const { status, q, isActive, page = 1, limit = 20, sort = "-priority,startDate" } = req.query;

    const query = {};
    if (status) query.status = String(status);
    if (isActive != null) query.isActive = String(isActive) === "true";
    if (q) query.$or = [{ name: new RegExp(String(q), "i") }, { code: new RegExp(String(q), "i") }];

    const p = Math.max(1, Number(page || 1));
    const l = Math.min(100, Math.max(1, Number(limit || 20)));

    const sortObj = {};
    String(sort)
      .split(",")
      .filter(Boolean)
      .forEach((s) => {
        const key = s.startsWith("-") ? s.slice(1) : s;
        sortObj[key] = s.startsWith("-") ? -1 : 1;
      });

    const [items, total] = await Promise.all([
      FlashSale.find(query).sort(sortObj).skip((p - 1) * l).limit(l),
      FlashSale.countDocuments(query),
    ]);

    return res.json({
      ok: true,
      items,
      total,
      page: p,
      limit: l,
      totalPages: Math.ceil(total / l),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "SERVER_ERROR" });
  }
});

// [PATCH] /api/flashsales/:id (update)
router.patch("/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ ok: false, message: "INVALID_ID" });

    const doc = await FlashSale.findById(id);
    if (!doc) return res.status(404).json({ ok: false, message: "NOT_FOUND" });

    const body = req.body || {};
    const fields = [
      "name",
      "code",
      "description",
      "startDate",
      "endDate",
      "banner",
      "images",
      "branchIds",
      "tierIds",
      "priority",
      "status",
      "isActive",
      "products",
    ];

    for (const k of fields) {
      if (body[k] !== undefined) {
        if (k === "code") doc.code = String(body.code).trim().toUpperCase();
        else if (k === "startDate" || k === "endDate") doc[k] = new Date(body[k]);
        else doc[k] = body[k];
      }
    }

    doc.updatedBy = req.user?._id;
    doc.updateStatus?.();

    await doc.save();
    return res.json({ ok: true, flashSale: doc });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "SERVER_ERROR" });
  }
});

// [POST] /api/flashsales/:id/products (add/replace one product rule)
router.post("/:id/products", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { productId, flashPrice, discountPercent, limitedQuantity, maxPerCustomer, badge, order, isActive } =
      req.body || {};

    if (!isValidObjectId(id) || !isValidObjectId(productId)) {
      return res.status(400).json({ ok: false, message: "INVALID_ID" });
    }

    const doc = await FlashSale.findById(id);
    if (!doc) return res.status(404).json({ ok: false, message: "NOT_FOUND" });

    const idx = doc.products.findIndex((p) => String(p.productId) === String(productId));

    const rule = {
      productId,
      flashPrice: Number(flashPrice || 0),
      discountPercent: Number(discountPercent || 0),
      limitedQuantity: limitedQuantity === null || limitedQuantity === undefined ? null : Number(limitedQuantity),
      soldQuantity: idx >= 0 ? Number(doc.products[idx].soldQuantity || 0) : 0,
      maxPerCustomer: maxPerCustomer === null || maxPerCustomer === undefined ? null : Number(maxPerCustomer),
      isActive: isActive !== false,
      order: Number(order || 0),
      badge: String(badge || ""),
    };

    if (idx >= 0) doc.products[idx] = rule;
    else doc.products.push(rule);

    doc.updatedBy = req.user?._id;
    await doc.save();

    return res.json({ ok: true, flashSale: doc });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "SERVER_ERROR" });
  }
});

// [POST] /api/flashsales/:id/recalc-status
router.post("/:id/recalc-status", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ ok: false, message: "INVALID_ID" });

    const doc = await FlashSale.findById(id);
    if (!doc) return res.status(404).json({ ok: false, message: "NOT_FOUND" });

    doc.updateStatus?.();
    await doc.save();

    return res.json({ ok: true, status: doc.status, isCurrentlyActive: doc.isCurrentlyActive });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "SERVER_ERROR" });
  }
});

// [GET] /api/flashsales/:id (detail)  ✅ đặt sau public để không nuốt /public/*
router.get("/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ ok: false, message: "INVALID_ID" });

    const doc = await FlashSale.findById(id);
    if (!doc) return res.status(404).json({ ok: false, message: "NOT_FOUND" });

    return res.json({ ok: true, flashSale: doc });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "SERVER_ERROR" });
  }
});

// [DELETE] /api/flashsales/:id
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) return res.status(400).json({ ok: false, message: "INVALID_ID" });

    const doc = await FlashSale.findByIdAndDelete(id);
    if (!doc) return res.status(404).json({ ok: false, message: "NOT_FOUND" });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message || "SERVER_ERROR" });
  }
});

module.exports = router;
