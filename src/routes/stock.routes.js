const router = require("express").Router();
const { z } = require("zod");

const Stock = require("../models/Stock");
const ChangeLog = require("../models/ChangeLog");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

async function nextVersion() {
  const last = await ChangeLog.findOne().sort({ version: -1 }).lean();
  return (last?.version || 0) + 1;
}

router.get("/:branchId", authRequired, asyncHandler(async (req, res) => {
  const branchId = String(req.params.branchId);
  const items = await Stock.find({ branchId }).populate("productId").limit(2000).lean();
  res.json({ ok: true, items });
}));

router.post("/adjust", authRequired, requireRole(["ADMIN", "MANAGER"]), asyncHandler(async (req, res) => {
  const body = z.object({
    branchId: z.string(),
    productId: z.string(),
    deltaQty: z.number().int(),
    note: z.string().optional(),
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  const { branchId, productId, deltaQty } = body.data;

  const st = await Stock.findOneAndUpdate(
    { branchId, productId },
    { $inc: { qty: deltaQty }, $set: { updatedBy: req.user.sub, note: body.data.note || "" } },
    { upsert: true, new: true }
  ).lean();

  const v = await nextVersion();
  await ChangeLog.create({ branchId, collection: "stocks", docId: st._id, action: "UPSERT", version: v });

  const io = req.app.get("io");
  io?.to(`branch:${branchId}`).emit("stockUpdated", { branchId, productId, qty: st.qty });

  res.json({ ok: true, stock: st, version: v });
}));

module.exports = router;
