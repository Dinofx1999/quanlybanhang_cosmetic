// src/routes/tier.routes.js
const router = require("express").Router();
const { z } = require("zod");

const Tier = require("../models/Tier");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

// ==========================
// Helpers
// ==========================
function normalizeQualify(q) {
  const obj = q || {};
  // ưu tiên field mới thresholdVnd, fallback spend12m (legacy UI)
  const thresholdVnd =
    obj.thresholdVnd !== undefined
      ? Number(obj.thresholdVnd || 0)
      : Number(obj.spend12m || 0);

  return { thresholdVnd: Math.max(0, Number.isFinite(thresholdVnd) ? thresholdVnd : 0) };
}

function normalizeEarn(e) {
  const obj = e || {};
  return {
    amountPerPoint: Math.max(1, Number(obj.amountPerPoint || 1)),
    round: obj.round || "FLOOR",
    minOrderAmount: Math.max(0, Number(obj.minOrderAmount || 0)),
  };
}

// ==========================
// Zod schema (accept BOTH payloads)
// ==========================
const TierBodySchema = z.object({
  code: z.string().min(2).transform((s) => String(s).toUpperCase().trim()),
  name: z.string().min(1),
  isActive: z.coerce.boolean().default(true),
  priority: z.coerce.number().int().min(0).default(0),

  earn: z
    .object({
      amountPerPoint: z.coerce.number().int().min(1),
      round: z.enum(["FLOOR", "ROUND", "CEIL"]).default("FLOOR"),
      minOrderAmount: z.coerce.number().int().min(0).default(0),
    })
    .default({ amountPerPoint: 100000, round: "FLOOR", minOrderAmount: 0 }),

  // ✅ accept both
  qualify: z
    .object({
      thresholdVnd: z.coerce.number().int().min(0).optional(), // new
      spend12m: z.coerce.number().int().min(0).optional(), // legacy UI
    })
    .default({}),

  durationDays: z.coerce.number().int().min(0).default(0),
});

const TierUpdateSchema = TierBodySchema.partial().extend({
  code: z.string().optional(),
});

// ==========================
// GET /api/tiers
// ==========================
router.get(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER", "STAFF"]),
  asyncHandler(async (_req, res) => {
    const items = await Tier.find({}).sort({ priority: -1, createdAt: 1 }).lean();

    // ✅ ensure response always has qualify.thresholdVnd number (even if old docs missing)
    const normalized = (items || []).map((t) => ({
      ...t,
      qualify: {
        thresholdVnd: Number(t?.qualify?.thresholdVnd || 0),
      },
    }));

    res.json({ ok: true, items: normalized });
  })
);

// ==========================
// POST /api/tiers
// ==========================
router.post(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const parsed = TierBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        message: "VALIDATION_ERROR",
        error: parsed.error.flatten(),
      });
    }

    const data = parsed.data;

    const exists = await Tier.findOne({ code: data.code }).lean();
    if (exists) {
      return res.status(409).json({ ok: false, message: `TIER_CODE_EXISTS: ${data.code}` });
    }

    // ✅ normalize to schema used by backend (TierSchema)
    const payload = {
      code: data.code,
      name: String(data.name || "").trim(),
      isActive: !!data.isActive,
      priority: Number(data.priority || 0),

      earn: normalizeEarn(data.earn),
      qualify: normalizeQualify(data.qualify),

      durationDays: Number(data.durationDays || 0),
    };

    const doc = await Tier.create(payload);
    res.json({ ok: true, tier: doc.toObject() });
  })
);

// ==========================
// PUT /api/tiers/:id
// ==========================
router.put(
  "/:id",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const parsed = TierUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        message: "VALIDATION_ERROR",
        error: parsed.error.flatten(),
      });
    }

    const patchIn = { ...parsed.data };
    delete patchIn.code; // không cho đổi code qua PUT

    const patch = {};

    if (patchIn.name !== undefined) patch.name = String(patchIn.name || "").trim();
    if (patchIn.isActive !== undefined) patch.isActive = !!patchIn.isActive;
    if (patchIn.priority !== undefined) patch.priority = Number(patchIn.priority || 0);
    if (patchIn.durationDays !== undefined) patch.durationDays = Number(patchIn.durationDays || 0);

    if (patchIn.earn !== undefined) patch.earn = normalizeEarn(patchIn.earn);
    if (patchIn.qualify !== undefined) patch.qualify = normalizeQualify(patchIn.qualify);

    const doc = await Tier.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true });
    if (!doc) return res.status(404).json({ ok: false, message: "TIER_NOT_FOUND" });

    res.json({ ok: true, tier: doc.toObject() });
  })
);

module.exports = router;
