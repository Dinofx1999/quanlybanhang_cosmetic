const router = require("express").Router();
const { z } = require("zod");

const Customer = require("../models/Customer");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

router.put(
  "/:id/tier",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().optional(),               // BRONZE/SILVER/GOLD/DIAMOND
        permanent: z.boolean().optional(),         // true => expiresAt null
        expiresAt: z.string().datetime().optional(), // set cụ thể
        locked: z.boolean().optional(),            // khóa auto
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const c = await Customer.findById(req.params.id);
    if (!c) return res.status(404).json({ ok: false, message: "CUSTOMER_NOT_FOUND" });

    c.tier = c.tier || {};
    const d = body.data;

    if (d.code) c.tier.code = String(d.code).toUpperCase();
    if (d.locked !== undefined) c.tier.locked = !!d.locked;

    if (d.permanent === true) {
      c.tier.permanent = true;
      c.tier.expiresAt = null;
    } else if (d.permanent === false) {
      c.tier.permanent = false;
      if (d.expiresAt) c.tier.expiresAt = new Date(d.expiresAt);
      else c.tier.expiresAt = addDays(new Date(), 365); // mặc định 365 nếu admin tắt permanent mà không set ngày
    } else if (d.expiresAt) {
      c.tier.permanent = false;
      c.tier.expiresAt = new Date(d.expiresAt);
    }

    c.tier.startsAt = c.tier.startsAt || new Date();
    await c.save();

    res.json({ ok: true, customer: c });
  })
);

module.exports = router;
