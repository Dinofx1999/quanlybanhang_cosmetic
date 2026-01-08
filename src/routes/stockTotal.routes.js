const router = require("express").Router();
const mongoose = require("mongoose");
const { z } = require("zod");

const Product = require("../models/Product");
const Stock = require("../models/Stock");

const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

// Helper: safe ObjectId
function toObjectId(id) {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch (_e) {
    return null;
  }
}

/**
 * GET /api/stock-total?productId=...
 * Trả tồn tổng + tồn MAIN + tồn theo từng branch
 * (dùng cho web product detail / barcode scan)
 */
router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const productId = String(req.query.productId || "").trim();
    if (!productId) return res.status(400).json({ ok: false, message: "Missing productId" });

    const pid = toObjectId(productId);
    if (!pid) return res.status(400).json({ ok: false, message: "Invalid productId" });

    const mainBranchIdStr = String(process.env.MAIN_BRANCH_ID || "").trim();
    if (!mainBranchIdStr) return res.status(500).json({ ok: false, message: "Missing MAIN_BRANCH_ID in .env" });

    const mainId = toObjectId(mainBranchIdStr);
    if (!mainId) return res.status(500).json({ ok: false, message: "Invalid MAIN_BRANCH_ID in .env" });

    const p = await Product.findById(pid).lean();
    if (!p || !p.isActive) return res.status(404).json({ ok: false, message: "Product not found" });

    const stocks = await Stock.find({ productId: pid }).lean();

    const totalQty = stocks.reduce((s, it) => s + (Number(it.qty) || 0), 0);
    const mainQty = stocks
      .filter((s) => String(s.branchId) === String(mainId))
      .reduce((sum, it) => sum + (Number(it.qty) || 0), 0);

    const byBranch = stocks
      .map((s) => ({
        branchId: String(s.branchId),
        qty: Number(s.qty) || 0,
      }))
      .sort((a, b) => b.qty - a.qty);

    res.json({
      ok: true,
      product: {
        _id: String(p._id),
        sku: p.sku || "",
        name: p.name || "",
        barcode: p.barcode || "",
        price: p.price || 0,
        categoryId: p.categoryId || null,
        categoryName: p.categoryName || "",
      },
      totalQty,
      mainQty,
      subQty: totalQty - mainQty,
      byBranch,
    });
  })
);

/**
 * POST /api/stock-total/bulk
 * body: { productIds: ["id1","id2",...] }
 * Trả tồn tổng + mainQty + subQty cho nhiều sản phẩm (dùng cho giỏ hàng)
 */
router.post(
  "/bulk",
  authRequired,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        productIds: z.array(z.string()).min(1).max(200),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const mainBranchIdStr = String(process.env.MAIN_BRANCH_ID || "").trim();
    if (!mainBranchIdStr) return res.status(500).json({ ok: false, message: "Missing MAIN_BRANCH_ID in .env" });

    const mainId = toObjectId(mainBranchIdStr);
    if (!mainId) return res.status(500).json({ ok: false, message: "Invalid MAIN_BRANCH_ID in .env" });

    const productIds = body.data.productIds.map(String);
    const objIds = productIds.map(toObjectId);

    if (objIds.some((x) => !x)) {
      return res.status(400).json({ ok: false, message: "Invalid productIds (must be ObjectId)" });
    }

    const agg = await Stock.aggregate([
      { $match: { productId: { $in: objIds } } },
      {
        $group: {
          _id: "$productId",
          totalQty: { $sum: "$qty" },
          mainQty: { $sum: { $cond: [{ $eq: ["$branchId", mainId] }, "$qty", 0] } },
        },
      },
    ]);

    const map = new Map(agg.map((x) => [String(x._id), { totalQty: x.totalQty || 0, mainQty: x.mainQty || 0 }]));

    const items = productIds.map((pid) => {
      const it = map.get(pid) || { totalQty: 0, mainQty: 0 };
      return {
        productId: pid,
        totalQty: it.totalQty,
        mainQty: it.mainQty,
        subQty: it.totalQty - it.mainQty,
      };
    });

    res.json({ ok: true, items });
  })
);

/**
 * GET /api/stock-total/all?q=&categoryId=&branchId=&page=&limit=
 * - Không có branchId: trả tồn tổng + mainQty + subQty cho toàn bộ sản phẩm (phân trang)
 * - Có branchId: trả tồn theo 1 chi nhánh (qty) cho toàn bộ sản phẩm (phân trang)
 *
 * 권: ADMIN/MANAGER (vì đây là dữ liệu kho)
 */
router.get(
  "/all",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || "").trim();
    const categoryId = String(req.query.categoryId || "").trim();
    const branchIdStr = String(req.query.branchId || "").trim(); // optional
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    // lowStock mode
    const lowStock = String(req.query.lowStock || "").trim() === "1";
    const threshold = Math.max(parseInt(req.query.threshold) || 5, 0);

    const mainBranchIdStr = String(process.env.MAIN_BRANCH_ID || "").trim();
    if (!mainBranchIdStr) return res.status(500).json({ ok: false, message: "Missing MAIN_BRANCH_ID in .env" });

    const mainId = toObjectId(mainBranchIdStr);
    if (!mainId) return res.status(500).json({ ok: false, message: "Invalid MAIN_BRANCH_ID in .env" });

    // Branch target để check low stock:
    // - nếu branchId truyền vào -> check branch đó
    // - nếu không -> check MAIN
    let targetBranchId = mainId;
    let branchId = null;
    if (branchIdStr) {
      branchId = toObjectId(branchIdStr);
      if (!branchId) return res.status(400).json({ ok: false, message: "Invalid branchId" });
      targetBranchId = branchId;
    }

    // 1) Filter sản phẩm chung
    const pFilter = { isActive: true };
    if (categoryId) pFilter.categoryId = categoryId;

    if (q) {
      pFilter.$or = [
        { name: { $regex: q, $options: "i" } },
        { sku: { $regex: q, $options: "i" } },
        { barcode: { $regex: q, $options: "i" } },
      ];
    }
    
    /**
     * ✅ Nếu lowStock=1: lọc theo qty của targetBranch (MAIN hoặc branchId)
     * - dùng $lookup từ products -> stocks (targetBranch)
     * - nếu không có stock row => qty = 0 (vẫn tính là low stock)
     * - rồi mới paginate
     */
    if (lowStock) {
      const pipeline = [
        { $match: pFilter },

        // Lookup stock của targetBranch
        {
          $lookup: {
            from: "stocks",
            let: { pid: "$_id" },
            pipeline: [
              { $match: { $expr: { $and: [{ $eq: ["$productId", "$$pid"] }, { $eq: ["$branchId", targetBranchId] }] } } },
              { $project: { qty: 1 } },
            ],
            as: "stTarget",
          },
        },
        {
          $addFields: {
            qty: {
              $ifNull: [{ $sum: "$stTarget.qty" }, 0],
            },
          },
        },
        // Filter low stock
        { $match: { qty: { $lte: threshold } } },

        // Sort: sắp hết trước -> qty tăng dần
        { $sort: { qty: 1, updatedAt: -1 } },

        // Facet để lấy total + items đúng chuẩn phân trang
        {
          $facet: {
            meta: [{ $count: "total" }],
            items: [{ $skip: skip }, { $limit: limit }],
          },
        },
      ];

      const out = await Product.aggregate(pipeline);

      const total = out?.[0]?.meta?.[0]?.total || 0;
      const products = out?.[0]?.items || [];

      // Nếu đang xem lowStock của MAIN (không truyền branchId)
      // thì trả thêm totalQty/mainQty/subQty để bạn nhìn tổng quát
      if (!branchId) {
        // Lấy totalQty cho các product trong page hiện tại (nhẹ hơn nhiều)
        const productIds = products.map((p) => p._id);
        const stockAgg = await Stock.aggregate([
          { $match: { productId: { $in: productIds } } },
          {
            $group: {
              _id: "$productId",
              totalQty: { $sum: "$qty" },
              mainQty: { $sum: { $cond: [{ $eq: ["$branchId", mainId] }, "$qty", 0] } },
            },
          },
        ]);
        const mapStock = new Map(stockAgg.map((x) => [String(x._id), x]));

        const items = products.map((p) => {
          const s = mapStock.get(String(p._id));
          const totalQty = s?.totalQty || 0;
          const mainQty = s?.mainQty || 0;
          return {
            productId: String(p._id),
            sku: p.sku || "",
            name: p.name || "",
            barcode: p.barcode || "",
            price: p.price || 0,
            categoryId: p.categoryId || null,
            categoryName: p.categoryName || "",
            totalQty,
            mainQty,
            subQty: totalQty - mainQty,
            // qtyLowStock đang check theo MAIN
            qty: mainQty,
          };
        });

        return res.json({
          ok: true,
          mode: "LOW_STOCK_MAIN",
          threshold,
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          items,
        });
      }

      // lowStock theo 1 branch cụ thể
      const items = products.map((p) => ({
        productId: String(p._id),
        sku: p.sku || "",
        name: p.name || "",
        barcode: p.barcode || "",
        price: p.price || 0,
        categoryId: p.categoryId || null,
        categoryName: p.categoryName || "",
        qty: Number(p.qty) || 0, // qty low-stock của branchId
      }));

      return res.json({
        ok: true,
        mode: "LOW_STOCK_BRANCH",
        branchId: String(branchId),
        threshold,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        items,
      });
    }

    /**
     * ✅ Mode bình thường (không lowStock): trả tồn tổng + mainQty + subQty
     * hoặc nếu có branchId => trả tồn theo branchId
     */

    const [products, total] = await Promise.all([
      Product.find(pFilter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      Product.countDocuments(pFilter),
    ]);

    const productIds = products.map((p) => p._id);
    if (productIds.length === 0) {
      return res.json({ ok: true, page, limit, total, totalPages: Math.ceil(total / limit), items: [] });
    }

    const match = { productId: { $in: productIds } };

    let stockAgg = [];
    if (branchId) {
      match.branchId = branchId;
      stockAgg = await Stock.aggregate([
        { $match: match },
        { $group: { _id: "$productId", qty: { $sum: "$qty" } } },
      ]);
    } else {
      stockAgg = await Stock.aggregate([
        { $match: match },
        {
          $group: {
            _id: "$productId",
            totalQty: { $sum: "$qty" },
            mainQty: { $sum: { $cond: [{ $eq: ["$branchId", mainId] }, "$qty", 0] } },
          },
        },
      ]);
    }

    const mapStock = new Map(stockAgg.map((x) => [String(x._id), x]));

    const items = products.map((p) => {
      const s = mapStock.get(String(p._id));

      if (branchId) {
        return {
          productId: String(p._id),
          sku: p.sku || "",
          name: p.name || "",
          barcode: p.barcode || "",
          price: p.price || 0,
          categoryId: p.categoryId || null,
          categoryName: p.categoryName || "",
          qty: s?.qty || 0,
        };
      }

      const totalQty = s?.totalQty || 0;
      const mainQty = s?.mainQty || 0;

      return {
        productId: String(p._id),
        sku: p.sku || "",
        name: p.name || "",
        barcode: p.barcode || "",
        price: p.price || 0,
        categoryId: p.categoryId || null,
        categoryName: p.categoryName || "",
        totalQty,
        mainQty,
        subQty: totalQty - mainQty,
      };
    });

    res.json({ ok: true, page, limit, total, totalPages: Math.ceil(total / limit), items });
  })
);


module.exports = router;
