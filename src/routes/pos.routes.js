const router = require("express").Router();
const { z } = require("zod");

const POSSession = require("../models/POSSession");
const Order = require("../models/Order");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

// open session
router.post("/open", authRequired, requireRole(["ADMIN","MANAGER","CASHIER"]), asyncHandler(async (req, res) => {
  const body = z.object({
    branchId: z.string().optional(),
    openingCash: z.number().int().nonnegative().optional(),
    note: z.string().optional(),
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  const branchId = body.data.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ ok: false, message: "Missing branchId" });

  const existed = await POSSession.findOne({ branchId, cashierId: req.user.sub, closedAt: null }).lean();
  if (existed) return res.status(409).json({ ok: false, message: "Ca đang mở rồi", session: existed });

  const s = await POSSession.create({
    branchId,
    cashierId: req.user.sub,
    openingCash: body.data.openingCash || 0,
    note: body.data.note || "",
  });

  res.json({ ok: true, session: s });
}));

// current session
router.get("/current", authRequired, requireRole(["ADMIN","MANAGER","CASHIER"]), asyncHandler(async (req, res) => {
  const branchId = String(req.query.branchId || req.user.branchId || "");
  if (!branchId) return res.status(400).json({ ok: false, message: "Missing branchId" });

  const s = await POSSession.findOne({ branchId, cashierId: req.user.sub, closedAt: null }).lean();
  res.json({ ok: true, session: s || null });
}));

// close session + summary revenue
router.post("/close", authRequired, requireRole(["ADMIN","MANAGER","CASHIER"]), asyncHandler(async (req, res) => {
  const body = z.object({
    branchId: z.string().optional(),
    closingCash: z.number().int().nonnegative().optional(),
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  const branchId = body.data.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ ok: false, message: "Missing branchId" });

  const s = await POSSession.findOne({ branchId, cashierId: req.user.sub, closedAt: null });
  if (!s) return res.status(404).json({ ok: false, message: "Không có ca đang mở" });

  const orders = await Order.find({
    branchId,
    channel: "POS",
    createdById: req.user.sub,
    createdAt: { $gte: s.openedAt, $lte: new Date() },
    status: { $in: ["PAID", "COMPLETED"] },
  }).lean();

  const revenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
  const count = orders.length;

  s.closedAt = new Date();
  s.closingCash = body.data.closingCash || 0;
  await s.save();

  res.json({ ok: true, session: s, summary: { revenue, count } });
}));

module.exports = router;
