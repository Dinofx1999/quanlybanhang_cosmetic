// src/routes/orders.routes.js
const router = require("express").Router();
const { z } = require("zod");

const Order = require("../models/Order");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const Stock = require("../models/Stock");
const LoyaltySetting = require("../models/LoyaltySetting");

const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const { genOrderCode } = require("../utils/code");

// ✅ revert earn when CANCEL/REFUND
const { revertEarnPointsForOrder } = require("../utils/points");

// ✅ loyalty engine: MUST handle EARN + REDEEM idempotently inside service
const { onOrderConfirmedOrDone } = require("../services/loyalty.service");

/**
 * ===============================
 * Redeem policy (Admin config)
 * ===============================
 * - amountPerPoint: 1 điểm đổi được bao nhiêu VND
 * - maxPercent: tối đa % của (subtotal - discount + extraFee)
 * - maxPoints: tối đa điểm cho 1 hoá đơn
 */
async function getRedeemPolicy({ branchId }) {
  const fallback = {
    enabled: false,
    amountPerPoint: 0,
    maxPercent: 0,
    maxPoints: 0,
    round: "FLOOR",
  };

  try {
    const setting = await LoyaltySetting.findOne({ key: "default" }).lean();
    if (!setting?.redeem) return fallback;

    const r = setting.redeem;
    return {
      enabled: !!r.redeemEnable,
      amountPerPoint: Number(r.redeemValueVndPerPoint || 0),
      maxPercent: Number(r.percentOfBill || 0),
      maxPoints: Number(r.maxPointsPerOrder || 0),
      round: "FLOOR",
    };
  } catch (err) {
    console.error("getRedeemPolicy error:", err);
    return fallback;
  }
}

function clamp0(n) {
  const x = Number(n || 0);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

function moneyInt(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x);
}

/**
 * ===============================
 * Items builder
 * ===============================
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
 * allocate POS: single branch, allow negative stock (handled by upsert stock)
 */
async function allocatePosStockSingleBranch({ branchId, items }) {
  const allocations = [];
  for (const it of items) {
    const need = Number(it.qty || 0);
    allocations.push({ branchId, productId: it.productId, qty: need });
  }
  return allocations;
}

/**
 * ONLINE allocate: MAIN_BRANCH_ID only
 */
async function allocateOnlineStockMainOnly({ mainBranchId, items }) {
  if (!mainBranchId) {
    const err = new Error("MISSING_MAIN_BRANCH_ID");
    err.code = "MISSING_MAIN_BRANCH_ID";
    throw err;
  }

  const allocations = [];
  for (const it of items) {
    const need = Number(it.qty || 0);
    if (!need || need <= 0) continue;

    allocations.push({
      branchId: String(mainBranchId),
      productId: it.productId,
      qty: need,
    });
  }
  return allocations;
}

/**
 * apply stock delta (allow negative via upsert)
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
 * ===============================
 * Payments helpers
 * ===============================
 */
const PAYMENT_METHODS = ["CASH", "BANK", "CARD", "WALLET", "COD", "PENDING"];

function sumPayments(payments) {
  if (!Array.isArray(payments)) return 0;
  return payments.reduce((s, p) => s + Number(p?.amount || 0), 0);
}

function normalizePayments(payments) {
  const arr = Array.isArray(payments) ? payments : [];
  return arr
    .map((p) => ({
      method: String(p?.method || "").toUpperCase(),
      amount: moneyInt(p?.amount || 0),
    }))
    .filter((p) => PAYMENT_METHODS.includes(p.method) && p.amount >= 0);
}

/**
 * ===============================
 * Redeem helpers (calc only)
 * ===============================
 */
function calcRedeem({ policy, customerPoints, requestedPoints, baseAmount }) {
  const enabled = !!policy?.enabled;
  if (!enabled) return { points: 0, amount: 0 };

  const amountPerPoint = clamp0(policy?.amountPerPoint || 0);
  if (!amountPerPoint) return { points: 0, amount: 0 };

  const reqPts = Math.max(0, Math.floor(Number(requestedPoints || 0)));
  if (!reqPts) return { points: 0, amount: 0 };

  const ptsHave = Math.max(0, Math.floor(Number(customerPoints || 0)));

  // max by admin caps
  const capPts = Math.max(0, Math.floor(Number(policy?.maxPoints ?? 0)));
  const maxPtsByCap = capPts > 0 ? Math.min(reqPts, capPts) : reqPts;

  // max by percent of invoice
  const maxPercent = Number(policy?.maxPercent);
  let maxAmountByPercent = baseAmount;
  if (Number.isFinite(maxPercent) && maxPercent > 0 && maxPercent < 100) {
    maxAmountByPercent = (baseAmount * maxPercent) / 100;
  }
  const maxPtsByPercent = Math.floor(maxAmountByPercent / amountPerPoint);

  const pts = Math.min(maxPtsByCap, ptsHave, maxPtsByPercent);
  if (pts <= 0) return { points: 0, amount: 0 };

  // rounding
  let amount = pts * amountPerPoint;
  if (String(policy?.round || "").toUpperCase() === "ROUND") amount = Math.round(amount);
  else amount = Math.floor(amount);

  // never exceed baseAmount
  if (amount > baseAmount) {
    const pts2 = Math.floor(baseAmount / amountPerPoint);
    return { points: pts2, amount: pts2 * amountPerPoint };
  }

  return { points: pts, amount };
}

/**
 * ===============================
 * NEW: GET /api/loyalty/setting
 * UI POSSection calls: GET /loyalty/setting
 * ===============================
 */
router.get(
  "/loyalty/setting",
  authRequired,
  requireRole(["ADMIN", "MANAGER", "STAFF"]),
  asyncHandler(async (req, res) => {
    const qBranch = String(req.query.branchId || "").trim();
    const role = String(req.user?.role || "").toUpperCase();
    const staffBranch = String(req.user?.branchId || "").trim();

    const branchId = qBranch || (role === "STAFF" ? staffBranch : "") || "";

    const policy = await getRedeemPolicy({ branchId });

    res.json({
      ok: true,
      setting: {
        redeem: {
          redeemEnable: !!policy.enabled,
          redeemValueVndPerPoint: Number(policy.amountPerPoint || 0),
          percentOfBill: Number(policy.maxPercent || 0),
          maxPointsPerOrder: Number(policy.maxPoints || 0),
          round: policy.round || "FLOOR",
        },
      },
    });
  })
);

/**
 * ===============================
 * GET /api/orders
 * ===============================
 */
router.get(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER", "STAFF"]),
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
 * ===============================
 * POST /api/orders
 * - POS: allow PENDING | CONFIRM | DEBT
 * - Multi payments
 * - Redeem:
 *    - UI final gửi: pointsRedeemed + pointsRedeemAmount
 *    - Backward: redeem.points
 * - Flow A: Apply loyalty ONLY when CONFIRM (và không redeem)
 * ===============================
 */
router.post(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        channel: z.enum(["POS", "ONLINE"]),
        status: z.enum(["PENDING", "CONFIRM", "DEBT"]).optional(),

        branchId: z.string().optional(),

        customer: z
          .object({
            phone: z.string().optional(),
            name: z.string().optional(),
            email: z.string().optional(),
            dob: z.union([z.string(), z.date()]).optional(),
            tier: z.enum(["BRONZE", "SILVER", "GOLD", "DIAMOND"]).optional(),
          })
          .optional(),

        delivery: z
          .object({
            method: z.enum(["SHIP", "PICKUP"]).optional(),
            address: z.string().optional(),
            note: z.string().optional(),
          })
          .optional(),

        discount: z.number().nonnegative().optional(),
        extraFee: z.number().nonnegative().optional(),
        pricingNote: z.string().optional(),

        payments: z
          .array(
            z.object({
              method: z.enum(["CASH", "BANK", "CARD", "WALLET", "COD", "PENDING"]),
              amount: z.number().nonnegative(),
            })
          )
          .optional(),

        payment: z
          .object({
            method: z.enum(["CASH", "BANK", "CARD", "COD", "WALLET", "PENDING"]).optional(),
            amount: z.number().nonnegative().optional(),
          })
          .optional(),

        // ✅ new payload from UI
        pointsRedeemed: z.number().int().nonnegative().optional(),
        pointsRedeemAmount: z.number().nonnegative().optional(),

        // ✅ backward compatible
        redeem: z
          .object({
            points: z.number().int().nonnegative(),
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
    const requestedStatus = data.status || "PENDING";

    // POS requires branchId
    if (data.channel === "POS" && !data.branchId) {
      return res.status(400).json({ ok: false, message: "POS order requires branchId" });
    }

    // ONLINE: only PENDING here
    if (data.channel === "ONLINE") {
      if (requestedStatus !== "PENDING") {
        return res.status(409).json({
          ok: false,
          message: "ONLINE can only be created as PENDING here. Use POST /api/orders/:id/confirm",
        });
      }
    }

    // Delivery normalize
    const delMethod = data.delivery?.method || "SHIP";
    const receiverName = String(data.customer?.name || "").trim();
    const receiverPhone = String(data.customer?.phone || "").trim();

    // Rule: if SHIP => require phone + address
    if (delMethod === "SHIP") {
      const addr = String(data.delivery?.address || "").trim();
      if (!addr) return res.status(400).json({ ok: false, message: "SHIP requires delivery.address" });
      if (!receiverPhone) return res.status(400).json({ ok: false, message: "SHIP requires customer.phone" });
    }

    // upsert customer if phone provided
    let customerId = null;
    let customerDoc = null;

    if (data.customer?.phone) {
      const setObj = {
        name: data.customer.name || "",
        email: data.customer.email || "",
      };

      if (data.customer.dob) {
        const d = data.customer.dob instanceof Date ? data.customer.dob : new Date(String(data.customer.dob));
        if (!isNaN(d.getTime())) setObj.dob = d;
      }

      if (data.customer.tier) {
        setObj["tier.code"] = String(data.customer.tier).toUpperCase().trim();
        setObj.tierUpdatedAt = new Date();
      }

      customerDoc = await Customer.findOneAndUpdate(
        { phone: data.customer.phone },
        { $set: setObj },
        { upsert: true, new: true }
      );

      customerId = customerDoc?._id || null;
    }

    const items = await buildOrderItems(data.items);
    const subtotal = moneyInt(items.reduce((s, it) => s + Number(it.total || 0), 0));

    const discount = moneyInt(data.discount || 0);
    const extraFee = moneyInt(data.extraFee || 0);

    if (discount > subtotal) {
      return res.status(400).json({ ok: false, message: `discount cannot exceed subtotal (${subtotal})` });
    }

    // ===== Payments normalize =====
    let payments = [];
    if (Array.isArray(data.payments) && data.payments.length) {
      payments = normalizePayments(data.payments);
    } else if (data.payment?.method) {
      payments = normalizePayments([{ method: data.payment.method, amount: data.payment.amount || 0 }]);
    } else {
      payments = [];
    }

    const sumPaid = moneyInt(sumPayments(payments));

    // ===== Redeem (Flow A): ONLY when CONFIRM =====
    // Accept both:
    // - new: pointsRedeemed / pointsRedeemAmount
    // - old: redeem.points
    let pointsRedeemed = 0;
    let pointsRedeemAmount = 0;

    const reqRedeemPointsFromOld = Math.max(0, Math.floor(Number(data?.redeem?.points || 0)));
    const reqRedeemPointsFromNew = Math.max(0, Math.floor(Number(data?.pointsRedeemed || 0)));
    const reqRedeemAmountFromNew = moneyInt(data?.pointsRedeemAmount || 0);

    const requestedRedeemPoints = reqRedeemPointsFromNew || reqRedeemPointsFromOld;

    if (data.channel === "POS") {
      // PENDING/DEBT: NOT allow redeem
      if ((requestedStatus === "PENDING" || requestedStatus === "DEBT") && requestedRedeemPoints > 0) {
        return res.status(400).json({ ok: false, message: "Redeem chỉ áp dụng khi CONFIRM (trả đủ)." });
      }

      if (requestedStatus === "CONFIRM" && customerId && requestedRedeemPoints > 0) {
        const policy = await getRedeemPolicy({ branchId: String(data.branchId || "") });

        const baseAmount = Math.max(0, subtotal - discount + extraFee);
        const customerPoints = Number(customerDoc?.points || 0);

        // Server ALWAYS recalculates by policy (do not trust client)
        const r = calcRedeem({
          policy,
          customerPoints,
          requestedPoints: requestedRedeemPoints,
          baseAmount,
        });

        pointsRedeemed = r.points;
        pointsRedeemAmount = r.amount;

        // If client sent explicit amount, ensure it matches server calc (optional strict)
        if (reqRedeemPointsFromNew > 0) {
          // allow small diff 0, because we use int money
          if (reqRedeemAmountFromNew !== 0 && reqRedeemAmountFromNew !== pointsRedeemAmount) {
            // Not fatal; choose server truth
          }
        }
      }
    }

    const total = Math.max(0, subtotal - discount - pointsRedeemAmount + extraFee);

    // ===== Payment rules by status =====
    if (data.channel === "POS") {
      if (requestedStatus === "PENDING") {
        const hasNonPending = payments.some((p) => p.method !== "PENDING" && p.amount > 0);
        if (hasNonPending) {
          return res.status(400).json({ ok: false, message: "PENDING không cho thu tiền. Hãy dùng CONFIRM/DEBT." });
        }
        const invalidPending = payments.some((p) => p.method === "PENDING" && Number(p.amount || 0) !== 0);
        if (invalidPending) return res.status(400).json({ ok: false, message: "PENDING payment phải có amount=0" });
        if (sumPaid !== 0) return res.status(400).json({ ok: false, message: "PENDING yêu cầu tổng thanh toán = 0" });
        payments = [];
      }

      if (requestedStatus === "CONFIRM") {
        const hasPendingMethod = payments.some((p) => p.method === "PENDING");
        if (hasPendingMethod) return res.status(400).json({ ok: false, message: "PENDING method chỉ dùng cho status=PENDING" });
        if (!payments.length) return res.status(400).json({ ok: false, message: "CONFIRM requires payments" });
        if (sumPaid !== total) {
          return res.status(400).json({ ok: false, message: `CONFIRM requires sum(payments)==order.total (${total})` });
        }
      }

      if (requestedStatus === "DEBT") {
        const hasPendingMethod = payments.some((p) => p.method === "PENDING");
        if (hasPendingMethod) return res.status(400).json({ ok: false, message: "PENDING method chỉ dùng cho status=PENDING" });
        if (sumPaid > total) return res.status(400).json({ ok: false, message: `DEBT requires sum(payments) <= order.total (${total})` });
        // allow 0..total
      }
    }

    // ===== Create Order =====
    const order = await Order.create({
      code: genOrderCode(data.channel === "POS" ? "POS" : "ADM"),
      channel: data.channel,
      status: requestedStatus,

      branchId: data.branchId || null,
      customerId,

      subtotal,
      discount,
      extraFee,
      pricingNote: data.pricingNote || "",

      // redeem fields (must exist in schema)
      pointsRedeemed,
      pointsRedeemAmount,
      pointsRedeemedAt: null,
      pointsRedeemRevertedAt: null,

      total,

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

      stockAllocations: [],
      confirmedAt: null,
      confirmedById: null,
      shippedAt: null,
      refundedAt: null,
      refundNote: "",

      // earn fields
      pointsEarned: 0,
      pointsAppliedAt: null,
      pointsRevertedAt: null,
      loyaltyAppliedAt: null,

      // debt field (must exist in schema)
      debtAmount: requestedStatus === "DEBT" ? Math.max(0, total - sumPaid) : 0,
    });

    // ===== Stock rules =====
    // POS: subtract stock immediately (allow negative)
    // ONLINE: PENDING doesn't subtract stock here
    if (data.channel === "POS") {
      const needItems = order.items.map((x) => ({ productId: x.productId, qty: x.qty }));
      const allocations = await allocatePosStockSingleBranch({
        branchId: String(order.branchId),
        items: needItems,
      });

      await applyStockDelta(allocations, -1);
      order.stockAllocations = allocations;

      if (requestedStatus === "CONFIRM" || requestedStatus === "DEBT") {
        order.confirmedAt = new Date();
        order.confirmedById = req.user.sub || null;
      }

      await order.save();

      // ===== Trừ điểm redeem (idempotent) =====
      if (requestedStatus === "CONFIRM" && order.customerId && order.pointsRedeemed > 0 && !order.pointsRedeemedAt) {
        await Customer.findByIdAndUpdate(
          order.customerId,
          { $inc: { points: -order.pointsRedeemed } }
        );
        order.pointsRedeemedAt = new Date();
        await order.save();
      }

      // ===== Apply loyalty ONLY when CONFIRM and NOT redeem (Flow A) =====
      if (requestedStatus === "CONFIRM" && order.customerId && order.pointsRedeemed === 0) {
        await onOrderConfirmedOrDone({
          customerId: order.customerId,
          orderId: order._id,
          order: order.toObject(),
          userId: req.user.sub || null,
        });
      }
    }

    res.json({ ok: true, order: order.toObject() });
  })
);

/**
 * ===============================
 * POST /api/orders/:id/confirm
 * - PENDING -> CONFIRM
 * - Flow A: accept redeem by:
 *    - pointsRedeemed/pointsRedeemAmount (new)
 *    - redeem.points (old)
 * ===============================
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
        payments: z
          .array(
            z.object({
              method: z.enum(["CASH", "BANK", "CARD", "WALLET", "COD", "PENDING"]),
              amount: z.number().nonnegative(),
            })
          )
          .optional(),

        payment: z
          .object({
            method: z.enum(["CASH", "BANK", "CARD", "COD", "WALLET", "PENDING"]).optional(),
            amount: z.number().nonnegative().optional(),
          })
          .optional(),

        // new
        pointsRedeemed: z.number().int().nonnegative().optional(),
        pointsRedeemAmount: z.number().nonnegative().optional(),

        // old
        redeem: z
          .object({
            points: z.number().int().nonnegative(),
          })
          .optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, message: "Order not found" });

    if (order.status === "CONFIRM") {
      return res.json({ ok: true, order: order.toObject(), alreadyConfirmed: true });
    }

    if (order.status !== "PENDING") {
      return res.status(409).json({ ok: false, message: `Only PENDING can be confirmed. Current=${order.status}` });
    }

    // normalize incoming payments
    let incoming = [];
    if (Array.isArray(body.data.payments) && body.data.payments.length) {
      incoming = normalizePayments(body.data.payments);
    } else if (body.data.payment?.method) {
      incoming = normalizePayments([{ method: body.data.payment.method, amount: body.data.payment.amount || 0 }]);
    } else {
      incoming = [];
    }

    // For POS/ONLINE: choose finalPayments
    const finalPayments = order.payments && order.payments.length ? normalizePayments(order.payments) : incoming;

    // ===== Redeem at confirm (Flow A) for POS only =====
    let totalAmount = moneyInt(order.total || 0);

    if (String(order.channel) === "POS") {
      const reqRedeemPtsOld = Math.max(0, Math.floor(Number(body.data?.redeem?.points || 0)));
      const reqRedeemPtsNew = Math.max(0, Math.floor(Number(body.data?.pointsRedeemed || 0)));
      const reqRedeemAmountNew = moneyInt(body.data?.pointsRedeemAmount || 0);

      const redeemPtsReq = reqRedeemPtsNew || reqRedeemPtsOld;

      if (redeemPtsReq > 0) {
        if (!order.customerId) return res.status(400).json({ ok: false, message: "Redeem requires customer" });
        if (!order.branchId) return res.status(400).json({ ok: false, message: "POS order missing branchId" });

        const customer = await Customer.findById(order.customerId).lean();
        const customerPoints = Number(customer?.points || 0);

        const policy = await getRedeemPolicy({ branchId: String(order.branchId) });
        const baseAmount = Math.max(0, moneyInt(order.subtotal) - moneyInt(order.discount) + moneyInt(order.extraFee));

        // always recalc
        const r = calcRedeem({
          policy,
          customerPoints,
          requestedPoints: redeemPtsReq,
          baseAmount,
        });

        order.pointsRedeemed = r.points;
        order.pointsRedeemAmount = r.amount;
        order.pointsRedeemedAt = null;

        totalAmount = Math.max(0, baseAmount - r.amount);
        order.total = totalAmount;

        // optional: ignore client amount mismatch
        if (reqRedeemPtsNew > 0 && reqRedeemAmountNew && reqRedeemAmountNew !== r.amount) {
          // server truth wins
        }
      } else {
        // if no redeem at confirm, ensure total is base
        const baseAmount = Math.max(0, moneyInt(order.subtotal) - moneyInt(order.discount) + moneyInt(order.extraFee));
        order.pointsRedeemed = 0;
        order.pointsRedeemAmount = 0;
        order.pointsRedeemedAt = null;
        order.total = baseAmount;
        totalAmount = baseAmount;
      }
    }

    // ===== Payment rules confirm =====
    if (String(order.channel) === "ONLINE") {
      // ONLINE: if no payment => COD
      if (!finalPayments.length) {
        order.payments = [{ method: "COD", amount: totalAmount }];
      } else {
        const sumPaid = moneyInt(sumPayments(finalPayments));
        if (finalPayments.some((p) => p.method === "CASH")) {
          return res.status(400).json({ ok: false, message: "ONLINE không dùng CASH" });
        }
        if (finalPayments.some((p) => p.method === "COD")) {
          return res.status(400).json({ ok: false, message: "ONLINE COD sẽ auto khi CONFIRM" });
        }
        if (sumPaid !== totalAmount) {
          return res.status(400).json({ ok: false, message: `ONLINE prepay requires sum(payments)==order.total (${totalAmount})` });
        }
        order.payments = finalPayments;
      }
    } else {
      // POS confirm requires payments sum == total
      if (finalPayments.some((p) => p.method === "COD")) {
        return res.status(400).json({ ok: false, message: "POS không dùng COD" });
      }
      if (!finalPayments.length) {
        return res.status(400).json({ ok: false, message: "POS confirm requires payments" });
      }
      if (finalPayments.some((p) => p.method === "PENDING")) {
        return res.status(400).json({ ok: false, message: "PENDING payment method chỉ dùng cho status=PENDING" });
      }

      const sumPaid = moneyInt(sumPayments(finalPayments));
      if (sumPaid !== totalAmount) {
        return res.status(400).json({
          ok: false,
          message: `POS requires sum(payments)==order.total (${totalAmount}). Current=${sumPaid}`,
        });
      }
      order.payments = finalPayments;
    }

    // ===== allocate & subtract stock (idempotent) =====
    const hasAlloc = Array.isArray(order.stockAllocations) && order.stockAllocations.length > 0;

    if (!hasAlloc) {
      const needItems = order.items.map((x) => ({ productId: x.productId, qty: x.qty }));
      let allocations = [];

      if (String(order.channel) === "ONLINE") {
        allocations = await allocateOnlineStockMainOnly({ mainBranchId, items: needItems });
      } else {
        if (!order.branchId) return res.status(400).json({ ok: false, message: "POS order missing branchId" });
        allocations = await allocatePosStockSingleBranch({ branchId: order.branchId, items: needItems });
      }

      await applyStockDelta(allocations, -1);
      order.stockAllocations = allocations;
    }

    // ===== confirm order =====
    order.status = "CONFIRM";
    order.confirmedAt = new Date();
    order.confirmedById = req.user.sub || null;

    await order.save();

    // ===== Trừ điểm redeem (idempotent) =====
    if (order.customerId && order.pointsRedeemed > 0 && !order.pointsRedeemedAt) {
      await Customer.findByIdAndUpdate(
        order.customerId,
        { $inc: { points: -order.pointsRedeemed } }
      );
      order.pointsRedeemedAt = new Date();
      await order.save();
    }

    // ===== apply loyalty ONLY now and NOT redeem (Flow A) =====
    if (order.customerId && order.pointsRedeemed === 0) {
      await onOrderConfirmedOrDone({
        customerId: order.customerId,
        orderId: order._id,
        order: order.toObject(),
        userId: req.user.sub || null,
      });
    }

    res.json({ ok: true, order: order.toObject() });
  })
);

/**
 * ===============================
 * POST /api/orders/:id/payments
 * - Append payment(s) vào đơn DEBT
 * - Nếu tổng payments >= total → tự động CONFIRM
 * - Nếu tổng payments < total → vẫn DEBT
 * ===============================
 */
router.post(
  "/:id/payments",
  authRequired,
  requireRole(["ADMIN", "MANAGER", "CASHIER", "STAFF"]),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        payments: z
          .array(
            z.object({
              method: z.enum(["CASH", "BANK", "CARD", "WALLET"]),
              amount: z.number().nonnegative(),
            })
          )
          .min(1),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, message: "Order not found" });

    // Chỉ cho phép append payment khi:
    // 1. Status = DEBT
    // 2. HOẶC Status = CONFIRM nhưng vẫn còn thiếu tiền (edge case)
    const currentStatus = String(order.status || "").toUpperCase();
    if (currentStatus !== "DEBT" && currentStatus !== "CONFIRM") {
      return res.status(409).json({
        ok: false,
        message: `Chỉ được append payment khi status=DEBT. Current=${currentStatus}`,
      });
    }

    // Normalize incoming payments
    const incomingPayments = normalizePayments(body.data.payments);
    if (!incomingPayments.length) {
      return res.status(400).json({ ok: false, message: "Payments array cannot be empty" });
    }

    const incomingSum = moneyInt(sumPayments(incomingPayments));
    if (incomingSum <= 0) {
      return res.status(400).json({ ok: false, message: "Total payment amount must be > 0" });
    }

    // Calculate current state
    const orderTotal = moneyInt(order.total || 0);
    const currentPaid = moneyInt(sumPayments(order.payments || []));
    const currentDue = Math.max(0, orderTotal - currentPaid);

    // Check: không cho trả quá số còn thiếu
    if (incomingSum > currentDue) {
      return res.status(400).json({
        ok: false,
        message: `Số tiền vượt quá còn thiếu. Còn thiếu: ${currentDue}, Bạn nhập: ${incomingSum}`,
      });
    }

    // Append payments
    const existingPayments = Array.isArray(order.payments) ? order.payments : [];
    order.payments = [...existingPayments, ...incomingPayments];

    const newPaidSum = moneyInt(sumPayments(order.payments));
    const newDue = Math.max(0, orderTotal - newPaidSum);

    // Decision: CONFIRM or keep DEBT
    if (newDue === 0) {
      // ✅ Trả đủ → CONFIRM
      order.status = "CONFIRM";
      order.confirmedAt = new Date();
      order.confirmedById = req.user.sub || null;
      order.debtAmount = 0;

      await order.save();

      // Apply loyalty (only if not redeemed)
      if (order.customerId && order.pointsRedeemed === 0) {
        await onOrderConfirmedOrDone({
          customerId: order.customerId,
          orderId: order._id,
          order: order.toObject(),
          userId: req.user.sub || null,
        });
      }

      return res.json({
        ok: true,
        order: order.toObject(),
        message: `Đã trả đủ ${moneyInt(incomingSum)}đ. Đơn chuyển sang CONFIRM.`,
        statusChanged: true,
      });
    } else {
      // ✅ Trả thiếu → vẫn DEBT
      order.debtAmount = newDue;
      await order.save();

      return res.json({
        ok: true,
        order: order.toObject(),
        message: `Đã ghi nhận ${moneyInt(incomingSum)}đ. Còn thiếu ${newDue}đ.`,
        statusChanged: false,
      });
    }
  })
);

/**
 * ===============================
 * PATCH /api/orders/:id/status
 * - Allow: PENDING -> CANCELLED
 * - CONFIRM -> SHIPPED
 * - SHIPPED -> REFUNDED
 * - DEBT -> CANCELLED
 * NOTE: DEBT -> CONFIRM is not handled here (you can add a /pay endpoint later).
 * ===============================
 */
router.patch(
  "/:id/status",
  authRequired,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        status: z.enum(["PENDING", "CONFIRM", "DEBT", "SHIPPED", "CANCELLED", "REFUNDED"]),
        refundNote: z.string().optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ ok: false, message: "Order not found" });

    const prev = order.status;
    const next = body.data.status;

    if (prev === "CANCELLED" || prev === "REFUNDED") {
      if (prev === next) return res.json({ ok: true, order: order.toObject() });
      return res.status(409).json({ ok: false, message: `Cannot change status from ${prev}` });
    }

    if (next === "CONFIRM") {
      return res.status(409).json({
        ok: false,
        message: "Use POST /api/orders/:id/confirm to CONFIRM (it subtracts stock) OR create POS order with status=CONFIRM",
      });
    }

    const allow =
      (prev === "PENDING" && next === "CANCELLED") ||
      (prev === "CONFIRM" && next === "SHIPPED") ||
      (prev === "DEBT" && next === "CANCELLED") ||
      (prev === "SHIPPED" && next === "REFUNDED") ||
      (prev === next);

    if (!allow) {
      return res.status(409).json({ ok: false, message: `Invalid transition ${prev} -> ${next}` });
    }

    // ===== CANCELLED =====
    if (next === "CANCELLED") {
      const isPOS = String(order.channel || "").toUpperCase() === "POS";
      const hasAlloc = Array.isArray(order.stockAllocations) && order.stockAllocations.length > 0;

      if (isPOS && hasAlloc) {
        await applyStockDelta(order.stockAllocations, +1);
        order.stockAllocations = [];
      }

      // revert earn
      await revertEarnPointsForOrder({
        order,
        userId: req.user.sub || null,
        reason: "REVERT_EARN_CANCELLED",
      });

      // revert redeem (if already deducted by loyalty.service)
      const ptsRedeemed = Number(order.pointsRedeemed || 0);
      if (ptsRedeemed > 0 && order.pointsRedeemedAt && !order.pointsRedeemRevertedAt && order.customerId) {
        await Customer.findByIdAndUpdate(order.customerId, { $inc: { points: +ptsRedeemed } });
        order.pointsRedeemRevertedAt = new Date();
      }
    }

    // ===== SHIPPED =====
    if (next === "SHIPPED") {
      order.shippedAt = new Date();
    }

    // ===== REFUNDED =====
    if (next === "REFUNDED") {
      order.refundedAt = new Date();
      order.refundNote = body.data.refundNote || "";

      await revertEarnPointsForOrder({
        order,
        userId: req.user.sub || null,
        reason: "REVERT_EARN_REFUNDED",
      });

      const ptsRedeemed = Number(order.pointsRedeemed || 0);
      if (ptsRedeemed > 0 && order.pointsRedeemedAt && !order.pointsRedeemRevertedAt && order.customerId) {
        await Customer.findByIdAndUpdate(order.customerId, { $inc: { points: +ptsRedeemed } });
        order.pointsRedeemRevertedAt = new Date();
      }
    }

    order.status = next;

    await order.save();
    res.json({ ok: true, order: order.toObject() });
  })
);

module.exports = router;