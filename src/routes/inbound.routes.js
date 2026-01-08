const router = require("express").Router();
const { z } = require("zod");

const GoodsReceipt = require("../models/GoodsReceipt");
const Product = require("../models/Product");
const Stock = require("../models/Stock");

const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const { genReceiptCode } = require("../utils/code");

/**
 * POST /api/inbounds
 * Tạo phiếu nhập (DRAFT) - CHƯA cộng tồn
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
              qty: z.number().int().positive(),
              cost: z.number().int().nonnegative(),
            })
          )
          .min(1),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const data = body.data;

    // dedupe (nếu client gửi)
    if (data.clientMutationId) {
      const existed = await GoodsReceipt.findOne({ clientMutationId: data.clientMutationId }).lean();
      if (existed) return res.json({ ok: true, receipt: existed, deduped: true });
    }

    // load products snapshot
    const productIds = data.items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds }, isActive: true }).lean();
    const mapP = new Map(products.map((p) => [String(p._id), p]));

    const items = data.items.map((it) => {
      const p = mapP.get(String(it.productId));
      if (!p) {
        return null;
      }
      const total = it.qty * it.cost;
      return {
        productId: it.productId,
        sku: p.sku || "",
        name: p.name || "",
        qty: it.qty,
        cost: it.cost,
        total,
      };
    });

    if (items.some((x) => !x)) {
      return res.status(400).json({ ok: false, message: "Có productId không tồn tại / không active" });
    }

    const subtotal = items.reduce((s, it) => s + it.total, 0);

    const receipt = await GoodsReceipt.create({
      code: genReceiptCode("GR"),
      branchId: data.branchId,
      supplier: data.supplier || "",
      note: data.note || "",
      status: "DRAFT",
      items,
      subtotal,
      createdById: req.user.sub,
      clientMutationId: data.clientMutationId || undefined,
    });

    res.json({ ok: true, receipt });
  })
);

/**
 * GET /api/inbounds
 * List phiếu nhập (lọc theo branch, status)
 */
router.get(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const branchId = String(req.query.branchId || "").trim();
    const status = String(req.query.status || "").trim(); // DRAFT/CONFIRMED/CANCELLED
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const filter = {};
    if (branchId) filter.branchId = branchId;
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
 * Chi tiết phiếu
 */
router.get(
  "/:id",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const r = await GoodsReceipt.findById(req.params.id).lean();
    if (!r) return res.status(404).json({ ok: false, message: "Receipt not found" });
    res.json({ ok: true, receipt: r });
  })
);

/**
 * POST /api/inbounds/:id/confirm
 * Xác nhận phiếu -> CỘNG TỒN KHO THẬT
 */
router.post(
  "/:id/confirm",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const receipt = await GoodsReceipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ ok: false, message: "Receipt not found" });

    if (receipt.status === "CONFIRMED") {
      return res.status(409).json({ ok: false, message: "Receipt already confirmed" });
    }
    if (receipt.status === "CANCELLED") {
      return res.status(409).json({ ok: false, message: "Receipt cancelled" });
    }

    // cộng tồn theo items
    for (const it of receipt.items) {
      await Stock.findOneAndUpdate(
        { branchId: receipt.branchId, productId: it.productId },
        { $inc: { qty: it.qty }, $set: { updatedBy: req.user.sub, note: `INBOUND ${receipt.code}` } },
        { upsert: true, new: true }
      );
    }

    receipt.status = "CONFIRMED";
    receipt.confirmedById = req.user.sub;
    receipt.confirmedAt = new Date();
    await receipt.save();

    // (optional) emit socket cho branch
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
 * Huỷ phiếu (chỉ khi DRAFT)
 */
router.post(
  "/:id/cancel",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const receipt = await GoodsReceipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ ok: false, message: "Receipt not found" });

    if (receipt.status !== "DRAFT") {
      return res.status(409).json({ ok: false, message: "Only DRAFT can be cancelled" });
    }

    receipt.status = "CANCELLED";
    await receipt.save();

    res.json({ ok: true, receipt: receipt.toObject() });
  })
);

module.exports = router;
