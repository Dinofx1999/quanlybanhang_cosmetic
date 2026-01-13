// src/routes/loyaltySettings.routes.js
const router = require("express").Router();
const { z } = require("zod");

const LoyaltySetting = require("../models/LoyaltySetting");
const Customer = require("../models/Customer"); // ✅ add
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

// ==========================
// Zod schema (strip unknown keys)
// ==========================
const TierCodeEnum = z.enum(["BRONZE", "SILVER", "GOLD", "DIAMOND"]);

const LoyaltySettingZod = z
  .object({
    downgradeTo: TierCodeEnum.optional(),

    renew: z
      .object({
        enabled: z.boolean().optional(),
        addDays: z.number().int().min(1).max(3650).optional(),
        basedOn: z.enum(["NOW"]).optional(),
        onlyForTiers: z.array(TierCodeEnum).optional(),
      })
      .optional(),

    autoUpgrade: z
      .object({
        enabled: z.boolean().optional(),
        metric: z.enum(["spend12m"]).optional(),
      })
      .optional(),

    pointBase: z
      .object({
        field: z.enum(["total", "subtotal"]).optional(),
      })
      .optional(),

    redeem: z
      .object({
        redeemEnable: z.boolean().optional(),
        redeemValueVndPerPoint: z.number().int().min(0).optional(),
        percentOfBill: z.number().min(0).max(100).optional(),
        maxPointsPerOrder: z.number().int().min(0).optional(),
      })
      .optional(),

    downgrade: z
      .object({
        enabled: z.boolean().optional(),
        inactiveDaysPerStep: z.number().int().min(1).max(3650).optional(),
        stepOrder: z.array(TierCodeEnum).optional(),
      })
      .optional(),
  })
  .strip();

function buildDefaultSetting() {
  return {
    key: "default",
    isActive: true,
    downgradeTo: "BRONZE",
    renew: {
      enabled: true,
      addDays: 365,
      basedOn: "NOW",
      onlyForTiers: ["SILVER", "GOLD", "DIAMOND"],
    },
    autoUpgrade: {
      enabled: true,
      metric: "spend12m",
    },
    pointBase: {
      field: "total",
    },
    redeem: {
      redeemEnable: false,
      redeemValueVndPerPoint: 0,
      percentOfBill: 0,
      maxPointsPerOrder: 0,
    },
    downgrade: {
      enabled: true,
      inactiveDaysPerStep: 90,
      stepOrder: ["BRONZE", "SILVER", "GOLD", "DIAMOND"],
    },
  };
}

async function getOrCreateDefaultDoc() {
  let doc = await LoyaltySetting.findOne({ key: "default" });
  if (!doc) doc = await LoyaltySetting.create(buildDefaultSetting());

  // ✅ MIGRATE SAFETY: nếu DB từng lưu metric khác, ép lại
  if (doc?.autoUpgrade?.metric !== "spend12m") {
    doc.autoUpgrade = doc.autoUpgrade || {};
    doc.autoUpgrade.metric = "spend12m";
    await doc.save();
  }
  return doc;
}

// ===== helpers =====
const moneyInt = (n) => {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x);
};

function calcRedeemServer({ policy, customerPoints, requestedPoints, baseAmount }) {
  const redeem = policy?.redeem || {};
  const redeemEnable = !!redeem.redeemEnable;
  if (!redeemEnable) return { points: 0, amount: 0, maxPoints: 0 };

  const vndPerPoint = moneyInt(redeem.redeemValueVndPerPoint || 0);
  const percentOfBill = Number(redeem.percentOfBill || 0);
  const maxPointsPerOrder = moneyInt(redeem.maxPointsPerOrder || 0);

  if (vndPerPoint <= 0) return { points: 0, amount: 0, maxPoints: 0 };

  const base = Math.max(0, moneyInt(baseAmount || 0));
  const custPts = Math.max(0, moneyInt(customerPoints || 0));
  const reqPts = Math.max(0, moneyInt(requestedPoints || 0));

  const maxByPercent =
    percentOfBill > 0
      ? Math.floor(((base * percentOfBill) / 100) / vndPerPoint)
      : Number.POSITIVE_INFINITY;

  const maxByOrder = maxPointsPerOrder > 0 ? maxPointsPerOrder : Number.POSITIVE_INFINITY;

  const maxPoints = Math.max(0, Math.min(custPts, maxByOrder, maxByPercent));
  const points = Math.max(0, Math.min(reqPts, maxPoints));
  const amount = moneyInt(points * vndPerPoint);

  return { points, amount, maxPoints };
}

// ==========================
// GET /api/loyalty-settings
// ==========================
router.get(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER", "STAFF"]),
  asyncHandler(async (_req, res) => {
    const doc = await LoyaltySetting.findOne({ key: "default" }).lean();
    res.json({ ok: true, setting: doc || null });
  })
);

// ==========================
// POST /api/loyalty-settings/init
// ==========================
router.post(
  "/init",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (_req, res) => {
    const existed = await LoyaltySetting.findOne({ key: "default" }).lean();
    if (existed) return res.json({ ok: true, setting: existed, already: true });

    const created = await LoyaltySetting.create(buildDefaultSetting());
    res.json({ ok: true, setting: created.toObject(), created: true });
  })
);

// ==========================
// PUT /api/loyalty-settings
// ==========================
router.put(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const parsed = LoyaltySettingZod.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        message: "VALIDATION_ERROR",
        error: parsed.error.flatten(),
      });
    }

    const patch = parsed.data || {};
    const doc = await getOrCreateDefaultDoc();

    // ===== merge update =====
    if (patch.downgradeTo) doc.downgradeTo = patch.downgradeTo;

    if (patch.renew) {
      doc.renew = {
        ...(doc.renew?.toObject ? doc.renew.toObject() : doc.renew || {}),
        ...patch.renew,
      };
      if (!doc.renew.basedOn) doc.renew.basedOn = "NOW";
    }

    if (patch.autoUpgrade) {
      doc.autoUpgrade = {
        ...(doc.autoUpgrade?.toObject ? doc.autoUpgrade.toObject() : doc.autoUpgrade || {}),
        ...patch.autoUpgrade,
      };
      doc.autoUpgrade.metric = "spend12m";
    }

    if (patch.pointBase) {
      doc.pointBase = {
        ...(doc.pointBase?.toObject ? doc.pointBase.toObject() : doc.pointBase || {}),
        ...patch.pointBase,
      };
      if (!doc.pointBase.field) doc.pointBase.field = "total";
    }

    if (patch.redeem) {
      doc.redeem = {
        ...(doc.redeem?.toObject ? doc.redeem.toObject() : doc.redeem || {}),
        ...patch.redeem,
      };
    }

    if (patch.downgrade) {
      doc.downgrade = {
        ...(doc.downgrade?.toObject ? doc.downgrade.toObject() : doc.downgrade || {}),
        ...patch.downgrade,
      };
      if (!Array.isArray(doc.downgrade.stepOrder) || doc.downgrade.stepOrder.length === 0) {
        doc.downgrade.stepOrder = ["BRONZE", "SILVER", "GOLD", "DIAMOND"];
      }
      if (!doc.downgrade.inactiveDaysPerStep) doc.downgrade.inactiveDaysPerStep = 90;
    }

    await doc.save();
    res.json({ ok: true, setting: doc.toObject() });
  })
);

// ==========================
// ✅ POST /api/loyalty-settings/calc-redeem
// Body: { branchId, phone|customerId, baseAmount, points }
// Return: { points, amount, maxPoints, vndPerPoint, percentOfBill, maxPointsPerOrder }
// ==========================
router.post(
  "/calc-redeem",
  authRequired,
  requireRole(["ADMIN", "MANAGER", "STAFF"]),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        branchId: z.string().optional(),
        phone: z.string().optional(),
        customerId: z.string().optional(),
        baseAmount: z.number().nonnegative(),
        points: z.number().int().nonnegative(),
      })
      .strip()
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ ok: false, message: "VALIDATION_ERROR", error: parsed.error.flatten() });
    }

    const { phone, customerId, baseAmount, points } = parsed.data;

    const setting = await getOrCreateDefaultDoc();
    const redeem = setting?.redeem || {};
    const redeemEnable = !!redeem.redeemEnable;

    // nếu tắt redeem => trả 0
    if (!redeemEnable) {
      return res.json({
        ok: true,
        redeemEnable: false,
        points: 0,
        amount: 0,
        maxPoints: 0,
        policy: {
          redeemEnable: false,
          redeemValueVndPerPoint: moneyInt(redeem.redeemValueVndPerPoint || 0),
          percentOfBill: Number(redeem.percentOfBill || 0),
          maxPointsPerOrder: moneyInt(redeem.maxPointsPerOrder || 0),
        },
      });
    }

    // find customer points
    let customer = null;
    if (customerId) customer = await Customer.findById(customerId).lean();
    if (!customer && phone) customer = await Customer.findOne({ phone: String(phone).trim() }).lean();

    const customerPoints = moneyInt(customer?.points || 0);

    const r = calcRedeemServer({
      policy: setting,
      customerPoints,
      requestedPoints: points,
      baseAmount,
    });

    return res.json({
      ok: true,
      redeemEnable: true,
      points: r.points,
      amount: r.amount,
      maxPoints: r.maxPoints,
      customerPoints,
      policy: {
        redeemEnable: true,
        redeemValueVndPerPoint: moneyInt(redeem.redeemValueVndPerPoint || 0),
        percentOfBill: Number(redeem.percentOfBill || 0),
        maxPointsPerOrder: moneyInt(redeem.maxPointsPerOrder || 0),
      },
    });
  })
);

module.exports = router;
