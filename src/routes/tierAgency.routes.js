const router = require("express").Router();
const { z } = require("zod");

const TierAgency = require("../models/TierAgency");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

/**
 * =========================
 * GET /api/tier-agencies
 * Danh sách cấp sỉ
 * =========================
 * Query:
 *  - active=true|false
 */
router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const active = req.query.active;

    const filter = {};
    if (active === "true") filter.isActive = true;
    if (active === "false") filter.isActive = false;

    const items = await TierAgency.find(filter)
      .sort({ level: 1, createdAt: 1 })
      .lean();

    res.json({ ok: true, items });
  })
);

/**
 * =========================
 * GET /api/tier-agencies/:id
 * Chi tiết 1 tier
 * =========================
 */
router.get(
  "/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const item = await TierAgency.findById(req.params.id).lean();
    if (!item) return res.status(404).json({ ok: false, message: "TIER_NOT_FOUND" });

    res.json({ ok: true, item });
  })
);

/**
 * =========================
 * POST /api/tier-agencies
 * Tạo cấp sỉ
 * =========================
 */
router.post(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(2),
        name: z.string().min(2),
        level: z.number().int().optional(),
        note: z.string().optional(),
      })
      .safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({ ok: false, error: body.error.flatten() });
    }

    const exists = await TierAgency.findOne({ code: body.data.code.toUpperCase() });
    if (exists) {
      return res.status(409).json({ ok: false, message: "CODE_ALREADY_EXISTS" });
    }

    const item = await TierAgency.create({
      code: body.data.code,
      name: body.data.name,
      level: body.data.level ?? 0,
      note: body.data.note || "",
    });

    res.json({ ok: true, item });
  })
);

/**
 * =========================
 * PUT /api/tier-agencies/:id
 * Cập nhật cấp sỉ
 * =========================
 */
router.put(
  "/:id",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(2).optional(),
        name: z.string().min(2).optional(),
        level: z.number().int().optional(),
        note: z.string().optional(),
        isActive: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({ ok: false, error: body.error.flatten() });
    }

    if (body.data.code) {
      const dup = await TierAgency.findOne({
        code: body.data.code.toUpperCase(),
        _id: { $ne: req.params.id },
      });
      if (dup) {
        return res.status(409).json({ ok: false, message: "CODE_ALREADY_EXISTS" });
      }
    }

    const item = await TierAgency.findByIdAndUpdate(
      req.params.id,
      { $set: body.data },
      { new: true }
    );

    if (!item) {
      return res.status(404).json({ ok: false, message: "TIER_NOT_FOUND" });
    }

    res.json({ ok: true, item });
  })
);

/**
 * =========================
 * PATCH /api/tier-agencies/:id/toggle
 * Bật / tắt cấp sỉ
 * =========================
 */
router.patch(
  "/:id/toggle",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const item = await TierAgency.findById(req.params.id);
    if (!item) return res.status(404).json({ ok: false, message: "TIER_NOT_FOUND" });

    item.isActive = !item.isActive;
    await item.save();

    res.json({ ok: true, item });
  })
);

/**
 * =========================
 * DELETE /api/tier-agencies/:id
 * Xoá cứng (ít dùng)
 * =========================
 */
router.delete(
  "/:id",
  authRequired,
  requireRole(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const item = await TierAgency.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ ok: false, message: "TIER_NOT_FOUND" });

    res.json({ ok: true });
  })
);

module.exports = router;
