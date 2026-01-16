// src/routes/orders.routes.js
const router = require("express").Router();
const { z } = require("zod");
const mongoose = require("mongoose");

const Order = require("../models/Order");
const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");
const Customer = require("../models/Customer");
const Stock = require("../models/Stock");
const VariantStock = require("../models/VariantStock");
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
 * ⭐ TierAgency pricing (Wholesale)
 * ===============================
 * - Customer has tierAgencyId (ObjectId TierAgency)
 * - Variant has price_tier: [{tierId, price}]
 * - Product has price_tier / baseTier / pricingRules
 * Priority:
 * 1) Variant.price_tier[tierId]
 * 2) Product.pricingRules (tier action if match)
 * 3) Product.price_tier[tierId]
 * 4) Product.baseTier[tierId]
 * 5) Variant.price (retail)
 * 6) Product.basePrice or Product.price
 */

function pickTierPriceFromArray(arr, tierAgencyId) {
  const tid = String(tierAgencyId || "").trim();
  if (!tid || !mongoose.isValidObjectId(tid)) return null;
  const list = Array.isArray(arr) ? arr : [];
  const found = list.find((x) => String(x?.tierId || "") === tid);
  if (!found) return null;
  const v = Number(found.price);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function getAttrValue(attributes, key) {
  const k = String(key || "").toLowerCase().trim();
  const arr = Array.isArray(attributes) ? attributes : [];
  const hit = arr.find((a) => String(a?.k || "").toLowerCase().trim() === k);
  return hit ? String(hit.v || "").trim() : "";
}

function matchWhenClause(attributes, clause) {
  const k = String(clause?.key || "").toLowerCase().trim();
  const op = String(clause?.op || "eq").toLowerCase().trim();
  const v = String(clause?.value || "").trim();
  const actual = getAttrValue(attributes, k);

  if (op === "eq") return actual === v;
  if (op === "ne") return actual !== v;
  if (op === "in") {
    const set = v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    return set.includes(actual);
  }
  if (op === "nin") {
    const set = v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    return !set.includes(actual);
  }
  return false;
}

function ruleMatches(attributes, rule) {
  const whens = Array.isArray(rule?.when) ? rule.when : [];
  if (!whens.length) return true;
  return whens.every((c) => matchWhenClause(attributes, c));
}

function applyActionToPrice(price, action) {
  const type = String(action?.type || "NONE").toUpperCase();
  const amt = Number(action?.amount || 0);
  if (type === "SET") return Math.max(0, moneyInt(amt));
  if (type === "ADD") return Math.max(0, moneyInt(price + amt));
  return price;
}

async function resolveSellPriceForVariant({ variant, tierAgencyId, productCache }) {
  const tid = String(tierAgencyId || "").trim();
  const hasTier = !!tid && mongoose.isValidObjectId(tid);

  // Base retail from variant
  let retail = moneyInt(variant?.price || 0);

  // 1) Variant.price_tier
  if (hasTier) {
    const vTier = pickTierPriceFromArray(variant?.price_tier, tid);
    if (vTier != null) return moneyInt(vTier);
  }

  // Fetch product (cached)
  let prod = null;
  const pid = variant?.productId ? String(variant.productId) : "";
  if (pid && mongoose.isValidObjectId(pid)) {
    if (productCache.has(pid)) prod = productCache.get(pid);
    else {
      prod = await Product.findById(pid)
        .select("_id price basePrice price_tier baseTier pricingRules")
        .lean();
      productCache.set(pid, prod || null);
    }
  }

  // If variant retail missing, fallback from product
  if (!retail && prod) retail = moneyInt(prod.basePrice ?? prod.price ?? 0);

  // 2) Product.pricingRules
  if (prod && Array.isArray(prod.pricingRules) && prod.pricingRules.length) {
    const rules = [...prod.pricingRules].sort(
      (a, b) => Number(a?.priority || 100) - Number(b?.priority || 100)
    );

    let curRetail = retail;
    let curTier = null;

    // base tier from product (price_tier > baseTier)
    if (hasTier) {
      const pTier = pickTierPriceFromArray(prod.price_tier, tid);
      const bTier = pickTierPriceFromArray(prod.baseTier, tid);
      curTier = pTier != null ? moneyInt(pTier) : bTier != null ? moneyInt(bTier) : null;
    }

    for (const r of rules) {
      if (!ruleMatches(variant?.attributes, r)) continue;

      curRetail = applyActionToPrice(curRetail, r.actionRetail);

      if (hasTier && Array.isArray(r.actionTiers)) {
        const a = r.actionTiers.find((x) => String(x?.tierId || "") === tid);
        if (a) {
          const next = applyActionToPrice(curTier ?? curRetail, a);
          curTier = next;
        }
      }
    }

    if (hasTier && curTier != null) return moneyInt(curTier);
    return moneyInt(curRetail);
  }

  // 3) Product.price_tier
  if (hasTier && prod) {
    const pTier = pickTierPriceFromArray(prod.price_tier, tid);
    if (pTier != null) return moneyInt(pTier);
  }

  // 4) Product.baseTier
  if (hasTier && prod) {
    const bTier = pickTierPriceFromArray(prod.baseTier, tid);
    if (bTier != null) return moneyInt(bTier);
  }

  // 5) Variant retail
  if (retail) return moneyInt(retail);

  // 6) Product fallback
  if (prod) return moneyInt(prod.basePrice ?? prod.price ?? 0);

  return 0;
}

/**
 * ===============================
 * ⭐ Items builder - VARIANT-BASED
 * ===============================
 * Accept: [{ productId: "variantId", qty: 1 }]
 * Server auto-detects if it's a variant
 */
async function buildOrderItems(itemsIn, opts = {}) {
  const items = [];
  const tierAgencyId = String(opts?.tierAgencyId || "").trim();
  const productCache = opts?.productCache || new Map();

  for (const item of itemsIn) {
    const productId = item.productId || item.itemId;
    const qty = Number(item.qty || 0);

    if (!productId) {
      const err = new Error("MISSING_PRODUCT_ID");
      err.code = "MISSING_PRODUCT_ID";
      throw err;
    }

    if (!mongoose.isValidObjectId(productId)) {
      const err = new Error("INVALID_PRODUCT_ID");
      err.code = "INVALID_PRODUCT_ID";
      err.detail = `productId=${productId}`;
      throw err;
    }

    if (qty <= 0) {
      const err = new Error("INVALID_QTY");
      err.code = "INVALID_QTY";
      throw err;
    }

    const variantId = new mongoose.Types.ObjectId(productId);

    // ⭐ Find variant (sellable unit)
    const variant = await ProductVariant.findById(variantId)
      .select("_id productId sku name price price_tier attributes isActive")
      .lean();

    if (!variant || !variant.isActive) {
      const err = new Error("VARIANT_NOT_FOUND");
      err.code = "VARIANT_NOT_FOUND";
      err.detail = `variantId=${productId} not found or inactive`;
      throw err;
    }

    const price = await resolveSellPriceForVariant({ variant, tierAgencyId, productCache });

    items.push({
      variantId: variant._id,
      productId: variant.productId, // parent product for reporting
      sku: variant.sku || "",
      name: variant.name || "",
      attributes: variant.attributes || [],
      qty,
      price,
      total: qty * price,
    });
  }

  return items;
}

/**
 * ===============================
 * ⭐ Stock allocation - VARIANT-BASED
 * ===============================
 */
async function allocatePosStockSingleBranch({ branchId, items }) {
  const allocations = [];

  for (const it of items) {
    const qty = Number(it.qty || 0);
    if (qty <= 0) continue;

    allocations.push({
      branchId,
      variantId: it.variantId,
      productId: it.productId, // optional for reporting
      qty,
    });
  }

  return allocations;
}

async function allocateOnlineStockMainOnly({ mainBranchId, items }) {
  if (!mainBranchId) {
    const err = new Error("MISSING_MAIN_BRANCH_ID");
    err.code = "MISSING_MAIN_BRANCH_ID";
    throw err;
  }

  const allocations = [];

  for (const it of items) {
    const qty = Number(it.qty || 0);
    if (qty <= 0) continue;

    allocations.push({
      branchId: String(mainBranchId),
      variantId: it.variantId,
      productId: it.productId,
      qty,
    });
  }

  return allocations;
}

/**
 * ===============================
 * ⭐ Apply stock delta - VARIANT-BASED
 * ===============================
 */
async function applyStockDelta(allocations, sign /* -1 subtract, +1 restore */) {
  for (const al of allocations || []) {
    const qty = Number(al.qty || 0) * Number(sign || 0);
    if (!al.branchId || !al.variantId || !qty) continue;

    // ⭐ Update variant stock
    await VariantStock.findOneAndUpdate(
      { branchId: al.branchId, variantId: al.variantId },
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

  const capPts = Math.max(0, Math.floor(Number(policy?.maxPoints ?? 0)));
  const maxPtsByCap = capPts > 0 ? Math.min(reqPts, capPts) : reqPts;

  const maxPercent = Number(policy?.maxPercent);
  let maxAmountByPercent = baseAmount;
  if (Number.isFinite(maxPercent) && maxPercent > 0 && maxPercent < 100) {
    maxAmountByPercent = (baseAmount * maxPercent) / 100;
  }
  const maxPtsByPercent = Math.floor(maxAmountByPercent / amountPerPoint);

  const pts = Math.min(maxPtsByCap, ptsHave, maxPtsByPercent);
  if (pts <= 0) return { points: 0, amount: 0 };

  let amount = pts * amountPerPoint;
  if (String(policy?.round || "").toUpperCase() === "ROUND") amount = Math.round(amount);
  else amount = Math.floor(amount);

  if (amount > baseAmount) {
    const pts2 = Math.floor(baseAmount / amountPerPoint);
    return { points: pts2, amount: pts2 * amountPerPoint };
  }

  return { points: pts, amount };
}

/**
 * ===============================
 * GET /api/loyalty/setting
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

        // ✅ NEW: FE can send customerId only
        customerId: z.string().optional(),

        customer: z
          .object({
            _id: z.string().optional(), // ✅ allow FE send customer._id too
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

        pointsRedeemed: z.number().int().nonnegative().optional(),
        pointsRedeemAmount: z.number().nonnegative().optional(),

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

    if (data.channel === "POS" && !data.branchId) {
      return res.status(400).json({ ok: false, message: "POS order requires branchId" });
    }

    if (data.channel === "ONLINE") {
      if (requestedStatus !== "PENDING") {
        return res.status(409).json({
          ok: false,
          message: "ONLINE can only be created as PENDING here. Use POST /api/orders/:id/confirm",
        });
      }
    }

    const delMethod = data.delivery?.method || "SHIP";
    const receiverName = String(data.customer?.name || "").trim();
    const receiverPhone = String(data.customer?.phone || "").trim();

    if (delMethod === "SHIP") {
      const addr = String(data.delivery?.address || "").trim();
      if (!addr) return res.status(400).json({ ok: false, message: "SHIP requires delivery.address" });
      if (!receiverPhone) return res.status(400).json({ ok: false, message: "SHIP requires customer.phone" });
    }

    // =========================
    // ✅ Customer resolution
    // =========================
    let customerId = null;
    let customerDoc = null;
    let tierAgencyId = "";

    const incomingCustomerId = String(data.customerId || data.customer?._id || "").trim();
    if (incomingCustomerId) {
      if (!mongoose.isValidObjectId(incomingCustomerId)) {
        return res.status(400).json({ ok: false, message: "Invalid customerId" });
      }
      customerDoc = await Customer.findById(incomingCustomerId);
      if (!customerDoc) return res.status(400).json({ ok: false, message: "Customer not found" });

      customerId = customerDoc._id;
      tierAgencyId = String(customerDoc?.tierAgencyId || "").trim();

      // Optional: update basic info if FE sends them
      const setObj = {};
      if (data.customer?.name != null) setObj.name = data.customer.name || "";
      if (data.customer?.email != null) setObj.email = data.customer.email || "";
      if (data.customer?.dob) {
        const d = data.customer.dob instanceof Date ? data.customer.dob : new Date(String(data.customer.dob));
        if (!isNaN(d.getTime())) setObj.dob = d;
      }
      if (data.customer?.tier) {
        setObj["tier.code"] = String(data.customer.tier).toUpperCase().trim();
        setObj.tierUpdatedAt = new Date();
      }
      if (Object.keys(setObj).length) {
        customerDoc = await Customer.findByIdAndUpdate(customerId, { $set: setObj }, { new: true });
        tierAgencyId = String(customerDoc?.tierAgencyId || tierAgencyId || "").trim();
      }
    }

    // Fallback old behavior by phone if no customerId
    if (!customerId && data.customer?.phone) {
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

      customerDoc = await Customer.findOneAndUpdate({ phone: data.customer.phone }, { $set: setObj }, { upsert: true, new: true });
      customerId = customerDoc?._id || null;
      tierAgencyId = String(customerDoc?.tierAgencyId || "").trim();
    }

    // ✅ Build items with server-truth pricing (retail or wholesale)
    const productCache = new Map();
    const items = await buildOrderItems(data.items, { tierAgencyId, productCache });
    const subtotal = moneyInt(items.reduce((s, it) => s + Number(it.total || 0), 0));

    const discount = moneyInt(data.discount || 0);
    const extraFee = moneyInt(data.extraFee || 0);

    if (discount > subtotal) {
      return res.status(400).json({ ok: false, message: `discount cannot exceed subtotal (${subtotal})` });
    }

    let payments = [];
    if (Array.isArray(data.payments) && data.payments.length) {
      payments = normalizePayments(data.payments);
    } else if (data.payment?.method) {
      payments = normalizePayments([{ method: data.payment.method, amount: data.payment.amount || 0 }]);
    } else {
      payments = [];
    }

    const sumPaid = moneyInt(sumPayments(payments));

    let pointsRedeemed = 0;
    let pointsRedeemAmount = 0;

    const reqRedeemPointsFromOld = Math.max(0, Math.floor(Number(data?.redeem?.points || 0)));
    const reqRedeemPointsFromNew = Math.max(0, Math.floor(Number(data?.pointsRedeemed || 0)));
    const reqRedeemAmountFromNew = moneyInt(data?.pointsRedeemAmount || 0);

    const requestedRedeemPoints = reqRedeemPointsFromNew || reqRedeemPointsFromOld;

    if (data.channel === "POS") {
      if ((requestedStatus === "PENDING" || requestedStatus === "DEBT") && requestedRedeemPoints > 0) {
        return res.status(400).json({ ok: false, message: "Redeem chỉ áp dụng khi CONFIRM (trả đủ)." });
      }

      if (requestedStatus === "CONFIRM" && customerId && requestedRedeemPoints > 0) {
        const policy = await getRedeemPolicy({ branchId: String(data.branchId || "") });

        const baseAmount = Math.max(0, subtotal - discount + extraFee);
        const customerPoints = Number(customerDoc?.points || 0);

        const r = calcRedeem({
          policy,
          customerPoints,
          requestedPoints: requestedRedeemPoints,
          baseAmount,
        });

        pointsRedeemed = r.points;
        pointsRedeemAmount = r.amount;

        if (reqRedeemPointsFromNew > 0) {
          if (reqRedeemAmountFromNew !== 0 && reqRedeemAmountFromNew !== pointsRedeemAmount) {
            // Not fatal; choose server truth
          }
        }
      }
    }

    const total = Math.max(0, subtotal - discount - pointsRedeemAmount + extraFee);

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
      }
    }

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

      pointsEarned: 0,
      pointsAppliedAt: null,
      pointsRevertedAt: null,
      loyaltyAppliedAt: null,

      debtAmount: requestedStatus === "DEBT" ? Math.max(0, total - sumPaid) : 0,
    });

    if (data.channel === "POS") {
      const needItems = order.items.map((x) => ({ variantId: x.variantId, productId: x.productId, qty: x.qty }));
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

      if (requestedStatus === "CONFIRM" && order.customerId && order.pointsRedeemed > 0 && !order.pointsRedeemedAt) {
        await Customer.findByIdAndUpdate(order.customerId, { $inc: { points: -order.pointsRedeemed } });
        order.pointsRedeemedAt = new Date();
        await order.save();
      }

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
 * ===============================
 * ✅ IMPORTANT:
 * - Nếu order PENDING được tạo trước đó, ta rebuild lại items/subtotal/total theo tierAgencyId (POS) trước khi validate payments
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

        pointsRedeemed: z.number().int().nonnegative().optional(),
        pointsRedeemAmount: z.number().nonnegative().optional(),

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

    // ✅ Rebuild POS pricing server-truth by customer's tierAgencyId (if any)
    if (String(order.channel) === "POS" && order.customerId) {
      const customer = await Customer.findById(order.customerId).lean();
      const tierAgencyId = String(customer?.tierAgencyId || "").trim();

      if (tierAgencyId && mongoose.isValidObjectId(tierAgencyId)) {
        // rebuild items by variantId + qty
        const itemsIn = (order.items || []).map((it) => ({
          productId: String(it.variantId || it.productId || ""),
          qty: Number(it.qty || 0),
        }));

        const productCache = new Map();
        const rebuilt = await buildOrderItems(itemsIn, { tierAgencyId, productCache });

        const newSubtotal = moneyInt(rebuilt.reduce((s, it) => s + Number(it.total || 0), 0));
        order.items = rebuilt;
        order.subtotal = newSubtotal;

        // note: total will be recalculated below (redeem part) as well
      }
    }

    let incoming = [];
    if (Array.isArray(body.data.payments) && body.data.payments.length) {
      incoming = normalizePayments(body.data.payments);
    } else if (body.data.payment?.method) {
      incoming = normalizePayments([{ method: body.data.payment.method, amount: body.data.payment.amount || 0 }]);
    } else {
      incoming = [];
    }

    const finalPayments = order.payments && order.payments.length ? normalizePayments(order.payments) : incoming;

    // base total from current order (maybe rebuilt)
    let totalAmount = moneyInt(order.total || 0);

    if (String(order.channel) === "POS") {
      const reqRedeemPtsOld = Math.max(0, Math.floor(Number(body.data?.redeem?.points || 0)));
      const reqRedeemPtsNew = Math.max(0, Math.floor(Number(body.data?.pointsRedeemed || 0)));
      const reqRedeemAmountNew = moneyInt(body.data?.pointsRedeemAmount || 0);

      const redeemPtsReq = reqRedeemPtsNew || reqRedeemPtsOld;

      const baseAmount = Math.max(
        0,
        moneyInt(order.subtotal) - moneyInt(order.discount) + moneyInt(order.extraFee)
      );

      if (redeemPtsReq > 0) {
        if (!order.customerId) return res.status(400).json({ ok: false, message: "Redeem requires customer" });
        if (!order.branchId) return res.status(400).json({ ok: false, message: "POS order missing branchId" });

        const customer = await Customer.findById(order.customerId).lean();
        const customerPoints = Number(customer?.points || 0);

        const policy = await getRedeemPolicy({ branchId: String(order.branchId) });

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

        if (reqRedeemPtsNew > 0 && reqRedeemAmountNew && reqRedeemAmountNew !== r.amount) {
          // server truth wins
        }
      } else {
        order.pointsRedeemed = 0;
        order.pointsRedeemAmount = 0;
        order.pointsRedeemedAt = null;
        order.total = baseAmount;
        totalAmount = baseAmount;
      }
    }

    if (String(order.channel) === "ONLINE") {
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

    const hasAlloc = Array.isArray(order.stockAllocations) && order.stockAllocations.length > 0;

    if (!hasAlloc) {
      const needItems = order.items.map((x) => ({ variantId: x.variantId, productId: x.productId, qty: x.qty }));
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

    order.status = "CONFIRM";
    order.confirmedAt = new Date();
    order.confirmedById = req.user.sub || null;

    await order.save();

    if (order.customerId && order.pointsRedeemed > 0 && !order.pointsRedeemedAt) {
      await Customer.findByIdAndUpdate(order.customerId, { $inc: { points: -order.pointsRedeemed } });
      order.pointsRedeemedAt = new Date();
      await order.save();
    }

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

    const currentStatus = String(order.status || "").toUpperCase();
    if (currentStatus !== "DEBT" && currentStatus !== "CONFIRM") {
      return res.status(409).json({
        ok: false,
        message: `Chỉ được append payment khi status=DEBT. Current=${currentStatus}`,
      });
    }

    const incomingPayments = normalizePayments(body.data.payments);
    if (!incomingPayments.length) {
      return res.status(400).json({ ok: false, message: "Payments array cannot be empty" });
    }

    const incomingSum = moneyInt(sumPayments(incomingPayments));
    if (incomingSum <= 0) {
      return res.status(400).json({ ok: false, message: "Total payment amount must be > 0" });
    }

    const orderTotal = moneyInt(order.total || 0);
    const currentPaid = moneyInt(sumPayments(order.payments || []));
    const currentDue = Math.max(0, orderTotal - currentPaid);

    if (incomingSum > currentDue) {
      return res.status(400).json({
        ok: false,
        message: `Số tiền vượt quá còn thiếu. Còn thiếu: ${currentDue}, Bạn nhập: ${incomingSum}`,
      });
    }

    const existingPayments = Array.isArray(order.payments) ? order.payments : [];
    order.payments = [...existingPayments, ...incomingPayments];

    const newPaidSum = moneyInt(sumPayments(order.payments));
    const newDue = Math.max(0, orderTotal - newPaidSum);

    if (newDue === 0) {
      order.status = "CONFIRM";
      order.confirmedAt = new Date();
      order.confirmedById = req.user.sub || null;
      order.debtAmount = 0;

      await order.save();

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

    if (next === "CANCELLED") {
      const isPOS = String(order.channel || "").toUpperCase() === "POS";
      const hasAlloc = Array.isArray(order.stockAllocations) && order.stockAllocations.length > 0;

      if (isPOS && hasAlloc) {
        await applyStockDelta(order.stockAllocations, +1);
        order.stockAllocations = [];
      }

      await revertEarnPointsForOrder({
        order,
        userId: req.user.sub || null,
        reason: "REVERT_EARN_CANCELLED",
      });

      const ptsRedeemed = Number(order.pointsRedeemed || 0);
      if (ptsRedeemed > 0 && order.pointsRedeemedAt && !order.pointsRedeemRevertedAt && order.customerId) {
        await Customer.findByIdAndUpdate(order.customerId, { $inc: { points: +ptsRedeemed } });
        order.pointsRedeemRevertedAt = new Date();
      }
    }

    if (next === "SHIPPED") {
      order.shippedAt = new Date();
    }

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
