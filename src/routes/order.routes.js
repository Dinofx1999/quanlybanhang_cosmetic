// src/routes/orders.routes.js
const router = require("express").Router();
const { z } = require("zod");

const Order = require("../models/Order");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const Stock = require("../models/Stock");

const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const { genOrderCode } = require("../utils/code");
const { allocateOnlineStock } = require("../utils/stockAllocator");

/**
 * Helper: build items snapshot from DB products
 * itemsIn: [{ productId, qty }]
 * returns: [{ productId, sku, name, qty, price, total }]
 */
async function buildOrderItems(itemsIn) {
  const ids = itemsIn.map((i) => i.productId);
  const products = await Product.find({ _id: { $in: ids }, isActive: true }).lean();
  const mapP = new Map(products.map((p) => [String(p._id), p]));

  const items = itemsIn.map((i) => {
    const p = mapP.get(String(i.productId));
    if (!p) {
      const err = new Error("PRODUCT_NOT_FOUND");
      err.code = "PRODUCT_NOT_FOUND";
      err.detail = `productId=${i.productId}`;
      throw err;
    }
    const qty = Number(i.qty || 0);
    const price = Number(p.price || 0);
    return {
      productId: i.productId,
      sku: p.sku || "",
      name: p.name || "",
      qty,
      price,
      total: qty * price,
    };
  });

  return items;
}

/**
 * Helper: allocate for POS (single branch only)
 * Ensures stock in that branch is enough for each product
 * returns allocations: [{ branchId, productId, qty }]
 */
async function allocatePosStockSingleBranch({ branchId, items }) {
  const allocations = [];
  for (const it of items) {
    const need = Number(it.qty || 0);
    const st = await Stock.findOne({ branchId, productId: it.productId }).lean();
    const avail = Number(st?.qty || 0);
    if (avail < need) {
      const err = new Error(`OUT_OF_STOCK_POS productId=${it.productId} need=${need} avail=${avail}`);
      err.code = "OUT_OF_STOCK";
      throw err;
    }
    allocations.push({ branchId, productId: it.productId, qty: need });
  }
  return allocations;
}

/**
 * Helper: subtract stock by allocations
 */
async function applyStockDelta(allocations, sign /* -1 subtract, +1 restore */) {
  for (const al of allocations || []) {
    const qty = Number(al.qty || 0) * Number(sign || 0);
    if (!al.branchId || !al.productId || !qty) continue;

    await Stock.findOneAndUpdate(
      { branchId: al.branchId, productId: al.productId },
      { $inc: { qty } },
      { upsert: true, new: true }
    );
  }
}

/**
 * GET /api/orders
 */
router.get(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || "").trim();
    const channel = String(req.query.channel || "").trim();
    const status = String(req.query.status || "").trim();
    const branchId = String(req.query.branchId || "").trim();

    const dateFrom = String(req.query.dateFrom || "").trim();
    const dateTo = String(req.query.dateTo || "").trim();

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const filter = {};
    if (channel) filter.channel = channel;
    if (status) filter.status = status;
    if (branchId) filter.branchId = branchId;

    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) filter.createdAt.$lte = new Date(dateTo);
    }

    if (q) {
      filter.$or = [
        { code: { $regex: q, $options: "i" } },
        { "delivery.receiverPhone": { $regex: q, $options: "i" } },
        { "delivery.receiverName": { $regex: q, $options: "i" } },
      ];
    }

    const [items, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Order.countDocuments(filter),
    ]);

    res.json({
      ok: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      items,
    });
  })
);

/**
 * GET /api/orders/:id
 */
router.get(
  "/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ ok: false, message: "Order not found" });
    res.json({ ok: true, order });
  })
);

/**
 * POST /api/orders
 * Tạo đơn nội bộ (POS hoặc ONLINE-admin).
 *
 * ✅ PATCH theo yêu cầu:
 * - Cho phép body.status: "PENDING" | "CONFIRM" (optional)
 * - POS:
 *    - PENDING: TRỪ KHO NGAY (theo branchId) ✅
 *    - CONFIRM: TRỪ KHO NGAY + lưu confirmedAt + validate payment ✅
 * - ONLINE:
 *    - luôn tạo PENDING (không trừ kho), nếu gửi status=CONFIRM thì sẽ bị chặn (bắt dùng /confirm)
 *
 * - Pricing: discount/extraFee => total = subtotal - discount + extraFee ✅
 */
router.post(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        channel: z.enum(["POS", "ONLINE"]),
        status: z.enum(["PENDING", "CONFIRM"]).optional(),

        branchId: z.string().optional(),

        customer: z
          .object({
            phone: z.string().optional(), // ✅ cho phép vãng lai (không cần phone)
            name: z.string().optional(),
            email: z.string().optional(),
          })
          .optional(),

        delivery: z
          .object({
            method: z.enum(["SHIP", "PICKUP"]).optional(),
            address: z.string().optional(),
            note: z.string().optional(),
          })
          .optional(),

        // ✅ NEW PRICING
        discount: z.number().nonnegative().optional(),
        extraFee: z.number().nonnegative().optional(),
        pricingNote: z.string().optional(),

        payment: z
          .object({
            method: z.enum(["CASH", "BANK", "CARD", "COD", "WALLET", "PENDING"]).optional(),
            amount: z.number().nonnegative().optional(),
          })
          .optional(),

        items: z
          .array(
            z.object({
              productId: z.string(),
              qty: z.number().int().positive(),
            })
          )
          .min(1),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });
    const data = body.data;

    // defaults
    const requestedStatus = data.status || "PENDING";

    // POS requires branchId
    if (data.channel === "POS" && !data.branchId) {
      return res.status(400).json({ ok: false, message: "POS order requires branchId" });
    }

    // ONLINE: không cho create CONFIRM ở endpoint này để tránh bypass rule trừ kho
    if (data.channel === "ONLINE" && requestedStatus === "CONFIRM") {
      return res.status(409).json({ ok: false, message: "ONLINE cannot be created as CONFIRM here. Create PENDING then POST /api/orders/:id/confirm" });
    }

    // Delivery normalize
    const delMethod = data.delivery?.method || "SHIP";
    const receiverName = String(data.customer?.name || "").trim();
    const receiverPhone = String(data.customer?.phone || "").trim();

    // ✅ Rule: nếu SHIP thì bắt buộc phone + address (cho cả POS/ONLINE nếu bạn dùng ship)
    if (delMethod === "SHIP") {
      const addr = String(data.delivery?.address || "").trim();
      if (!addr) return res.status(400).json({ ok: false, message: "SHIP requires delivery.address" });
      if (!receiverPhone) return res.status(400).json({ ok: false, message: "SHIP requires customer.phone" });
    }

    // upsert customer if provided phone
    let customerId = null;
    if (data.customer?.phone) {
      const c = await Customer.findOneAndUpdate(
        { phone: data.customer.phone },
        { $set: { name: data.customer.name || "", email: data.customer.email || "" } },
        { upsert: true, new: true }
      ).lean();
      customerId = c?._id || null;
    }

    const items = await buildOrderItems(data.items);
    const subtotal = items.reduce((s, it) => s + Number(it.total || 0), 0);

    const discount = Number(data.discount || 0);
    const extraFee = Number(data.extraFee || 0);

    if (discount > subtotal) {
      return res.status(400).json({ ok: false, message: `discount cannot exceed subtotal (${subtotal})` });
    }

    const total = subtotal - discount + extraFee;

    // ✅ payments snapshot
    const payments = [];
    const incomingPayment = data.payment || null;

    // POS CONFIRM: phải có payment CASH/BANK/CARD/WALLET và amount == total
    // POS PENDING: cho phép payment.method = PENDING hoặc không gửi
    if (data.channel === "POS") {
      if (requestedStatus === "CONFIRM") {
        if (!incomingPayment?.method) {
          return res.status(400).json({ ok: false, message: "POS CONFIRM requires payment.method" });
        }
        if (incomingPayment.method === "COD") {
          return res.status(400).json({ ok: false, message: "POS không dùng COD" });
        }
        if (incomingPayment.method === "PENDING") {
          return res.status(400).json({ ok: false, message: "POS CONFIRM cannot use PENDING payment method" });
        }

        const amt = Number(incomingPayment.amount || 0);
        if (amt !== total) {
          return res.status(400).json({ ok: false, message: `POS payment requires amount == order.total (${total})` });
        }
        payments.push({ method: incomingPayment.method, amount: amt });
      } else {
        // PENDING
        // nếu bạn muốn lưu payment pending:
        if (incomingPayment?.method && incomingPayment.method !== "PENDING") {
          // không cho nhét CASH/BANK vào PENDING tránh báo cáo sai
          return res.status(400).json({ ok: false, message: "POS PENDING chỉ cho payment.method=PENDING hoặc bỏ trống" });
        }
        if (incomingPayment?.method === "PENDING") {
          payments.push({ method: "PENDING", amount: Number(incomingPayment.amount || 0) });
        }
      }
    } else {
      // ONLINE create: luôn PENDING và không cần payment
      // (payment sẽ được xử lý ở /confirm)
    }

    // ✅ create order first
    const order = await Order.create({
      code: genOrderCode(data.channel === "POS" ? "POS" : "ADM"),
      channel: data.channel,

      // ✅ status by request (POS only)
      status: requestedStatus,

      branchId: data.branchId || null,
      customerId,

      subtotal,
      discount,
      extraFee,
      total,
      pricingNote: data.pricingNote || "",

      items,
      payments,

      delivery: {
        method: delMethod,
        address: data.delivery?.address || "",
        receiverName,
        receiverPhone,
        note: data.delivery?.note || "",
      },

      createdById: req.user.sub || null,

      // will be filled if POS subtract stock now
      stockAllocations: [],
      confirmedAt: null,
      confirmedById: null,
      shippedAt: null,
      refundedAt: null,
      refundNote: "",
    });

    // =========================
    // ✅ STOCK RULES (PATCH)
    // =========================
    // POS: PENDING cũng trừ kho, CONFIRM cũng trừ kho.
    // ONLINE: create PENDING không trừ kho.
    if (data.channel === "POS") {
      const needItems = order.items.map((x) => ({ productId: x.productId, qty: x.qty }));

      const allocations = await allocatePosStockSingleBranch({
        branchId: String(order.branchId),
        items: needItems,
      });

      // subtract now
      await applyStockDelta(allocations, -1);

      order.stockAllocations = allocations;

      if (requestedStatus === "CONFIRM") {
        order.confirmedAt = new Date();
        order.confirmedById = req.user.sub || null;
      }

      await order.save();
    }

    res.json({ ok: true, order: order.toObject() });
  })
);

/**
 * POST /api/orders/:id/confirm
 * ✅ PENDING -> CONFIRM: TRỪ KHO
 * - ONLINE: allocate MAIN trước, thiếu trừ kho phụ
 * - POS: trừ đúng branchId của order (idempotent)
 */
router.post(
  "/:id/confirm",
  authRequired,
  requireRole(["ADMIN", "MANAGER", "CASHIER", "STAFF"]),
  asyncHandler(async (req, res) => {
    const mainBranchId = String(process.env.MAIN_BRANCH_ID || "").trim();
    if (!mainBranchId) return res.status(500).json({ ok: false, message: "Missing MAIN_BRANCH_ID in .env" });

    const body = z
      .object({
        payment: z
          .object({
            method: z.enum(["CASH", "BANK", "CARD", "COD", "WALLET"]),
            amount: z.number().positive(),
          })
          .optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, message: "Order not found" });

    // idempotent
    if (order.status === "CONFIRM") {
      return res.json({ ok: true, order: order.toObject(), alreadyConfirmed: true });
    }
    if (order.status !== "PENDING") {
      return res.status(409).json({ ok: false, message: `Only PENDING can be confirmed. Current=${order.status}` });
    }

    const totalAmount = Number(order.total || 0);
    const incomingPayment = body.data.payment;
    order.payments = Array.isArray(order.payments) ? order.payments : [];

    // =========================
    // 1) PAYMENT RULES
    // =========================
    if (order.channel === "ONLINE") {
      if (incomingPayment) {
        if (incomingPayment.method === "CASH") {
          return res.status(400).json({ ok: false, message: "ONLINE không dùng CASH" });
        }
        if (incomingPayment.method === "COD") {
          return res.status(400).json({ ok: false, message: "ONLINE COD sẽ auto khi CONFIRM" });
        }
        if (Number(incomingPayment.amount) !== totalAmount) {
          return res.status(400).json({
            ok: false,
            message: `ONLINE prepay requires amount == order.total (${totalAmount})`,
          });
        }
        if (order.payments.length === 0) {
          order.payments.push({ method: incomingPayment.method, amount: incomingPayment.amount });
        }
      }
      if (order.payments.length === 0) {
        order.payments.push({ method: "COD", amount: totalAmount });
      }
    } else {
      // POS confirm: nếu tạo PENDING trước mà đã trừ kho, confirm chỉ cần validate payment
      if (order.payments.length === 0) {
        if (!incomingPayment) {
          return res.status(400).json({
            ok: false,
            message: "POS confirm requires payment in body (or create payment first via /api/orders/:id/payment)",
          });
        }
        if (incomingPayment.method === "COD") {
          return res.status(400).json({ ok: false, message: "POS không dùng COD" });
        }
        if (Number(incomingPayment.amount) !== totalAmount) {
          return res.status(400).json({
            ok: false,
            message: `POS payment requires amount == order.total (${totalAmount})`,
          });
        }
        order.payments.push({ method: incomingPayment.method, amount: incomingPayment.amount });
      } else {
        const sumPaid = order.payments.reduce((s, p) => s + Number(p.amount || 0), 0);
        if (sumPaid !== totalAmount) {
          return res.status(400).json({
            ok: false,
            message: `POS order đã có payment nhưng tổng (${sumPaid}) != order.total (${totalAmount}). Vui lòng sửa payment trước khi confirm.`,
          });
        }
      }
    }

    // =========================
    // 2) ALLOCATE & SUBTRACT STOCK
    // =========================
    // ✅ PATCH: nếu POS đã trừ kho ngay lúc create (stockAllocations có rồi) thì KHÔNG trừ lại
    const hasAlloc = Array.isArray(order.stockAllocations) && order.stockAllocations.length > 0;

    if (!hasAlloc) {
      const needItems = order.items.map((x) => ({ productId: x.productId, qty: x.qty }));
      let allocations = [];

      if (order.channel === "ONLINE") {
        allocations = await allocateOnlineStock({ mainBranchId, items: needItems });
      } else {
        if (!order.branchId) return res.status(400).json({ ok: false, message: "POS order missing branchId" });
        allocations = await allocatePosStockSingleBranch({
          branchId: order.branchId,
          items: needItems,
        });
      }

      await applyStockDelta(allocations, -1);
      order.stockAllocations = allocations;
    }

    // =========================
    // 3) UPDATE ORDER STATUS
    // =========================
    order.status = "CONFIRM";
    order.confirmedAt = new Date();
    order.confirmedById = req.user.sub || null;

    await order.save();
    res.json({ ok: true, order: order.toObject() });
  })
);

/**
 * PATCH /api/orders/:id/status
 * PATCH theo yêu cầu:
 * - POS: nếu đơn đã trừ kho (stockAllocations có) và chuyển -> CANCELLED => HOÀN KHO ✅
 * - ONLINE: giữ như cũ: PENDING->CANCELLED không đụng kho (vì chưa trừ) ✅
 *
 * Note: không cho set CONFIRM ở đây (phải dùng /confirm hoặc create status=CONFIRM với POS).
 */
router.patch(
  "/:id/status",
  authRequired,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        status: z.enum(["PENDING", "CONFIRM", "SHIPPED", "CANCELLED", "REFUNDED"]),
        refundNote: z.string().optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, message: "Order not found" });

    const prev = order.status;
    const next = body.data.status;

    // terminal states
    if (prev === "CANCELLED" || prev === "REFUNDED") {
      if (prev === next) return res.json({ ok: true, order: order.toObject() });
      return res.status(409).json({ ok: false, message: `Cannot change status from ${prev}` });
    }

    // CONFIRM must go through /confirm (or create POS with status=CONFIRM)
    if (next === "CONFIRM") {
      return res.status(409).json({
        ok: false,
        message: "Use POST /api/orders/:id/confirm to CONFIRM (it subtracts stock) OR create POS order with status=CONFIRM",
      });
    }

    // Allowed transitions
    const allow =
      (prev === "PENDING" && next === "CANCELLED") ||
      (prev === "CONFIRM" && next === "SHIPPED") ||
      (prev === "SHIPPED" && next === "REFUNDED") ||
      (prev === next);

    if (!allow) {
      return res.status(409).json({ ok: false, message: `Invalid transition ${prev} -> ${next}` });
    }

    // =========================
    // ✅ STOCK RESTORE on CANCELLED for POS if already allocated
    // =========================
    if (next === "CANCELLED") {
      const isPOS = String(order.channel || "").toUpperCase() === "POS";
      const hasAlloc = Array.isArray(order.stockAllocations) && order.stockAllocations.length > 0;

      if (isPOS && hasAlloc) {
        // restore stock
        await applyStockDelta(order.stockAllocations, +1);
        // clear allocations to avoid double-restore
        order.stockAllocations = [];
      }
    }

    order.status = next;

    if (next === "SHIPPED") {
      order.shippedAt = new Date();
    }

    if (next === "REFUNDED") {
      order.refundedAt = new Date();
      order.refundNote = body.data.refundNote || "";
      // giữ đúng yêu cầu: REFUNDED không auto hoàn kho
    }

    await order.save();
    res.json({ ok: true, order: order.toObject() });
  })
);

/**
 * POST /api/orders/:id/payment
 * Thêm payment record (không tự đổi status)
 */
router.post(
  "/:id/payment",
  authRequired,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        method: z.enum(["CASH", "BANK", "CARD", "COD", "WALLET"]),
        amount: z.number().positive(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, message: "Order not found" });

    if (order.status === "CANCELLED" || order.status === "REFUNDED") {
      return res.status(409).json({ ok: false, message: `Cannot add payment to ${order.status} order` });
    }

    const totalAmount = Number(order.total || 0);
    const method = body.data.method;
    const amount = Number(body.data.amount);

    order.payments = Array.isArray(order.payments) ? order.payments : [];

    if (order.channel === "ONLINE") {
      if (method === "CASH") return res.status(400).json({ ok: false, message: "ONLINE không hỗ trợ CASH" });
      if (method === "COD") return res.status(400).json({ ok: false, message: "ONLINE COD sẽ tự set khi CONFIRM (không set qua /payment)" });

      if (order.payments.length > 0) {
        return res.status(409).json({ ok: false, message: "ONLINE order đã có payment, không thể thêm nữa" });
      }

      if (amount !== totalAmount) {
        return res.status(400).json({ ok: false, message: `ONLINE prepay requires amount == order.total (${totalAmount})` });
      }

      order.payments.push({ method, amount });
      await order.save();
      return res.json({ ok: true, order: order.toObject() });
    }

    // POS
    if (method === "COD") return res.status(400).json({ ok: false, message: "POS không dùng COD" });

    if (amount !== totalAmount) {
      return res.status(400).json({ ok: false, message: `POS payment requires amount == order.total (${totalAmount})` });
    }

    if (order.payments.length > 0) {
      return res.status(409).json({ ok: false, message: "POS order đã có payment, không thể thêm nữa" });
    }

    order.payments.push({ method, amount });
    await order.save();

    res.json({ ok: true, order: order.toObject() });
  })
);

module.exports = router;
