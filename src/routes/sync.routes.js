const router = require("express").Router();
const { z } = require("zod");

const ChangeLog = require("../models/ChangeLog");
const Product = require("../models/Product");
const Stock = require("../models/Stock");
const Order = require("../models/Order");

const { authRequired } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

router.get("/pull", authRequired, asyncHandler(async (req, res) => {
  const branchId = String(req.query.branchId || "");
  const lastVersion = Number(req.query.lastVersion || 0);
  const limit = Math.min(Number(req.query.limit || 500), 2000);

  const filter = { version: { $gt: lastVersion } };
  if (branchId) filter.$or = [{ branchId }, { branchId: null }];

  const changes = await ChangeLog.find(filter).sort({ version: 1 }).limit(limit).lean();
  const maxVersion = changes.length ? changes[changes.length - 1].version : lastVersion;

  res.json({ ok: true, lastVersion, maxVersion, changes });
}));

router.post("/pull-details", authRequired, asyncHandler(async (req, res) => {
  const body = z.object({
    products: z.array(z.string()).optional(),
    stocks: z.array(z.string()).optional(),
    orders: z.array(z.string()).optional(),
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  const products = body.data.products?.length
    ? await Product.find({ _id: { $in: body.data.products }, isActive: true }).lean()
    : [];

  const stocks = body.data.stocks?.length
    ? await Stock.find({ _id: { $in: body.data.stocks } }).lean()
    : [];

  const orders = body.data.orders?.length
    ? await Order.find({ _id: { $in: body.data.orders } }).lean()
    : [];

  res.json({ ok: true, products, stocks, orders });
}));

module.exports = router;
