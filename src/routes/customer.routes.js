const router = require("express").Router();
const { z } = require("zod");

const Customer = require("../models/Customer");
const { authRequired } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

router.get("/", authRequired, asyncHandler(async (req, res) => {
  const q = String(req.query.q || "").trim();
  const filter = q
    ? { $or: [{ phone: { $regex: q, $options: "i" } }, { name: { $regex: q, $options: "i" } }] }
    : {};
  const items = await Customer.find(filter).sort({ updatedAt: -1 }).limit(200).lean();
  res.json({ ok: true, items });
}));

router.post("/", authRequired, asyncHandler(async (req, res) => {
  const body = z.object({
    phone: z.string().optional(),
    name: z.string().optional(),
    email: z.string().optional(),
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  const c = await Customer.create({
    phone: body.data.phone || undefined,
    name: body.data.name || "",
    email: body.data.email || "",
  });

  res.json({ ok: true, customer: c });
}));

module.exports = router;
