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
  // items: [{ productId, qty }]
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
 * GET /api/orders
 * Query:
 * - q: search code/phone/name
 * - channel: POS|ONLINE
 * - status: PENDING|CONFIRM|SHIPPED|CANCELLED|REFUNDED
 * - branchId
 * - dateFrom, dateTo: ISO string
 * - page, limit
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
      // search theo code hoặc delivery.receiverPhone hoặc customer phone (nếu bạn có populate sau)
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
 * Tạo đơn nội bộ (POS hoặc ONLINE-admin). Online khách dùng /api/checkout.
 * Body:
 * {
 *   channel: "POS"|"ONLINE",
 *   branchId?: "...",            // POS bắt buộc; ONLINE thường = MAIN_BRANCH_ID để hiển thị
 *   customer?: { phone, name, email } (optional),
 *   delivery?: { method, address, note } (optional),
 *   items: [{ productId, qty }]
 * }
 *
 * => luôn tạo PENDING (KHÔNG trừ kho)
 */
router.post(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        channel: z.enum(["POS", "ONLINE"]),
        branchId: z.string().optional(),
        customer: z
          .object({
            phone: z.string().min(8),
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

    if (data.channel === "POS" && !data.branchId) {
      return res.status(400).json({ ok: false, message: "POS order requires branchId" });
    }

    // upsert customer if provided
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
    const subtotal = items.reduce((s, it) => s + it.total, 0);

    const order = await Order.create({
      code: genOrderCode(data.channel === "POS" ? "POS" : "ADM"),
      channel: data.channel,
      status: "PENDING",

      branchId: data.branchId || null,
      customerId,

      subtotal,
      discount: 0,
      total: subtotal,

      items,
      payments: [],
      delivery: {
        method: data.delivery?.method || "SHIP",
        address: data.delivery?.address || "",
        receiverName: data.customer?.name || "",
        receiverPhone: data.customer?.phone || "",
        note: data.delivery?.note || "",
      },

      createdById: req.user.sub || null,

      // PENDING => chưa trừ kho
      stockAllocations: [],
      confirmedAt: null,
      confirmedById: null,
      shippedAt: null,
      refundedAt: null,
      refundNote: "",
    });

    res.json({ ok: true, order });
  })
);

/**
 * POST /api/orders/:id/confirm
 * ✅ PENDING -> CONFIRM: TRỪ KHO
 * - ONLINE: allocate MAIN trước, thiếu trừ kho phụ
 * - POS: trừ đúng branchId của order
 */
router.post(
  "/:id/confirm",
  authRequired,
  requireRole(["ADMIN", "MANAGER", "CASHIER", "STAFF"]), // POS nhân viên confirm được
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
    const incomingPayment = body.data.payment; // optional
    order.payments = Array.isArray(order.payments) ? order.payments : [];

    // =========================
    // 1) PAYMENT RULES
    // =========================
    if (order.channel === "ONLINE") {
      // ONLINE: prepay optional, nếu không có thì auto COD
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
      // POS: bắt buộc có payment tại confirm (hoặc đã nhập trước đó)
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
        // đã có payment trước đó -> validate tổng tiền
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
    const needItems = order.items.map((x) => ({ productId: x.productId, qty: x.qty }));
    let allocations = [];

    if (order.channel === "ONLINE") {
      allocations = await allocateOnlineStock({ mainBranchId, items: needItems });
    } else {
      if (!order.branchId) return res.status(400).json({ ok: false, message: "POS order missing branchId" });

      // POS: trừ đúng branchId
      allocations = await allocatePosStockSingleBranch({
        branchId: order.branchId,
        items: needItems,
      });
    }

    for (const al of allocations) {
      await Stock.findOneAndUpdate(
        { branchId: al.branchId, productId: al.productId },
        { $inc: { qty: -al.qty } },
        { upsert: true, new: true }
      );
    }

    // =========================
    // 3) UPDATE ORDER STATUS
    // =========================
    order.status = "CONFIRM";
    order.stockAllocations = allocations;
    order.confirmedAt = new Date();
    order.confirmedById = req.user.sub || null;

    await order.save();

    res.json({ ok: true, order: order.toObject() });
  })
);


/**
 * PATCH /api/orders/:id/status
 * Rule theo yêu cầu:
 * - PENDING -> CANCELLED: ✅ chỉ đổi status, không đụng kho
 * - CONFIRM -> SHIPPED: ✅
 * - SHIPPED -> REFUNDED: ✅ (KHÔNG hoàn kho tự động, bạn nhập lại bằng phiếu)
 * - Terminal: CANCELLED/REFUNDED không đổi nữa
 *
 * Note: không cho set CONFIRM ở đây (phải dùng /confirm để trừ kho).
 */
router.patch(
  "/:id/status",
  authRequired,
  // requireRole(["ADMIN", "MANAGER"]),
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

    // CONFIRM must go through /confirm
    if (next === "CONFIRM") {
      return res.status(409).json({ ok: false, message: "Use POST /api/orders/:id/confirm to CONFIRM (it subtracts stock)" });
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

    order.status = next;

    if (next === "SHIPPED") {
      order.shippedAt = new Date();
    }

    if (next === "REFUNDED") {
      order.refundedAt = new Date();
      order.refundNote = body.data.refundNote || "";
      // ✅ theo yêu cầu: REFUNDED không auto hoàn kho
    }

    await order.save();

    res.json({ ok: true, order: order.toObject() });
  })
);

/**
 * POST /api/orders/:id/payment
 * Thêm payment record (không tự đổi status, bạn chủ động đổi nếu cần)
 * Body: { method: CASH|BANK|CARD|COD|WALLET, amount: number }
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

    // Không cho thanh toán khi terminal
    if (order.status === "CANCELLED" || order.status === "REFUNDED") {
      return res.status(409).json({ ok: false, message: `Cannot add payment to ${order.status} order` });
    }

    const totalAmount = Number(order.total || 0);
    const method = body.data.method;
    const amount = Number(body.data.amount);

    order.payments = Array.isArray(order.payments) ? order.payments : [];

    // ---- RULES BY CHANNEL ----
    if (order.channel === "ONLINE") {
      // ONLINE: chỉ prepay (BANK/CARD/WALLET) hoặc COD (nếu bạn muốn set COD qua payment)
      // khuyến nghị: ONLINE không dùng CASH
      if (method === "CASH") {
        return res.status(400).json({ ok: false, message: "ONLINE không hỗ trợ CASH" });
      }

      // Nếu muốn: không cho set COD bằng endpoint này, vì confirm sẽ auto COD
      if (method === "COD") {
        return res.status(400).json({ ok: false, message: "ONLINE COD sẽ tự set khi CONFIRM (không set qua /payment)" });
      }

      // Chặn double payment
      if (order.payments.length > 0) {
        return res.status(409).json({ ok: false, message: "ONLINE order đã có payment, không thể thêm nữa" });
      }

      // Prepay thường phải đủ total (muốn cho đặt cọc mình mở rộng sau)
      if (amount !== totalAmount) {
        return res.status(400).json({
          ok: false,
          message: `ONLINE prepay requires amount == order.total (${totalAmount})`,
        });
      }

      order.payments.push({ method, amount });
      await order.save();

      return res.json({ ok: true, order: order.toObject() });
    }

    // POS
    if (method === "COD") {
      return res.status(400).json({ ok: false, message: "POS không dùng COD" });
    }

    // POS thường thu đủ khi ghi payment (để khỏi lệch báo cáo)
    if (amount !== totalAmount) {
      return res.status(400).json({
        ok: false,
        message: `POS payment requires amount == order.total (${totalAmount})`,
      });
    }

    // Nếu POS đã có payment thì chặn để tránh double
    if (order.payments.length > 0) {
      return res.status(409).json({ ok: false, message: "POS order đã có payment, không thể thêm nữa" });
    }

    order.payments.push({ method, amount });
    await order.save();

    res.json({ ok: true, order: order.toObject() });
  })
);


module.exports = router;
