// src/routes/variantStocks.js
const router = require("express").Router();
const { z } = require("zod");
const mongoose = require("mongoose");

const VariantStock = require("../models/VariantStock");
const VariantStockTxn = require("../models/VariantStockTxn");
const ProductVariant = require("../models/ProductVariant");
const Product = require("../models/Product");
const Branch = require("../models/Branch");

const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

function resolveBranchId(req) {
  const role = String(req.user?.role || "").toUpperCase();
  const userBranchId = req.user?.branchId;

  if (role === "STAFF") return userBranchId ? String(userBranchId) : "";
  const q = String(req.query.branchId || req.body.branchId || "").trim();
  if (!q || q === "all") return "all";
  return q;
}

async function getOrCreateStock(variantId, branchId) {
  let st = await VariantStock.findOne({ variantId, branchId });
  if (!st) st = await VariantStock.create({ variantId, branchId, qty: 0, reserved: 0 });
  return st;
}

// ===== LIST stocks (by variantId or productId)
router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const variantId = String(req.query.variantId || "").trim();
    const productId = String(req.query.productId || "").trim();
    const q = String(req.query.q || "").trim();

    const branchId = resolveBranchId(req);

    // build variant filter
    const vFilter = {};
    if (variantId) vFilter._id = variantId;
    if (productId) vFilter.productId = productId;

    if (q) {
      vFilter.$or = [
        { sku: { $regex: q, $options: "i" } },
        { barcode: { $regex: q, $options: "i" } },
        { name: { $regex: q, $options: "i" } },
        { "attributes.v": { $regex: q, $options: "i" } },
      ];
    }

    const variants = await ProductVariant.find(vFilter).lean();
    const variantIds = variants.map((v) => v._id);

    const stFilter = { variantId: { $in: variantIds } };
    if (branchId !== "all") stFilter.branchId = branchId;

    const stocks = await VariantStock.find(stFilter).lean();
    const stockMap = new Map(stocks.map((s) => [`${String(s.variantId)}_${String(s.branchId)}`, s]));

    // branches
    let branches = [];
    if (branchId === "all") {
      branches = await Branch.find({ isActive: true }).select("_id name code").lean();
    } else if (branchId) {
      const b = await Branch.findById(branchId).select("_id name code").lean();
      if (b) branches = [b];
    }

    const items = [];
    for (const v of variants) {
      if (branchId === "all") {
        // trả về tất cả branch qty
        const byBranches = branches.map((b) => {
          const key = `${String(v._id)}_${String(b._id)}`;
          const s = stockMap.get(key);
          return { branchId: b._id, branchName: b.name, qty: Number(s?.qty || 0), reserved: Number(s?.reserved || 0) };
        });
        const totalQty = byBranches.reduce((sum, x) => sum + Number(x.qty || 0), 0);
        items.push({ variant: v, totalQty, byBranches });
      } else {
        // 1 branch
        const key = `${String(v._id)}_${String(branches[0]?._id || branchId)}`;
        const s = stockMap.get(key);
        items.push({ variant: v, branchId, qty: Number(s?.qty || 0), reserved: Number(s?.reserved || 0) });
      }
    }

    res.json({ ok: true, branchId, items });
  })
);

// ===== ADJUST stock (IN/OUT/SET)
router.post(
  "/adjust",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        variantId: z.string().min(1),
        branchId: z.string().min(1),
        op: z.enum(["IN", "OUT", "SET"]),
        qty: z.number().nonnegative(),
        note: z.string().optional(),
        refType: z.string().optional(),
        refId: z.string().optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const { variantId, branchId, op, qty } = body.data;

    // STAFF không được tự điều chỉnh
    const role = String(req.user?.role || "").toUpperCase();
    if (role === "STAFF") return res.status(403).json({ ok: false, message: "FORBIDDEN" });

    const v = await ProductVariant.findById(variantId).select("_id productId sku").lean();
    if (!v) return res.status(400).json({ ok: false, message: "VARIANT_NOT_FOUND" });

    const b = await Branch.findById(branchId).select("_id").lean();
    if (!b) return res.status(400).json({ ok: false, message: "BRANCH_NOT_FOUND" });

    const st = await getOrCreateStock(variantId, branchId);
    const before = Number(st.qty || 0);

    let after = before;
    if (op === "IN") after = before + qty;
    if (op === "OUT") after = Math.max(0, before - qty);
    if (op === "SET") after = qty;

    st.qty = after;
    await st.save();

    await VariantStockTxn.create({
      variantId,
      branchId,
      type: op,
      qty,
      before,
      after,
      note: String(body.data.note || ""),
      refType: String(body.data.refType || ""),
      refId: body.data.refId && mongoose.isValidObjectId(body.data.refId) ? body.data.refId : undefined,
      createdBy: req.user?._id,
    });

    res.json({ ok: true, variantId, branchId, before, after });
  })
);

// ===== TRANSFER stock (between branches)
router.post(
  "/transfer",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        variantId: z.string().min(1),
        fromBranchId: z.string().min(1),
        toBranchId: z.string().min(1),
        qty: z.number().positive(),
        note: z.string().optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const role = String(req.user?.role || "").toUpperCase();
    if (role === "STAFF") return res.status(403).json({ ok: false, message: "FORBIDDEN" });

    const { variantId, fromBranchId, toBranchId, qty } = body.data;
    if (fromBranchId === toBranchId) return res.status(400).json({ ok: false, message: "SAME_BRANCH" });

    const v = await ProductVariant.findById(variantId).select("_id sku").lean();
    if (!v) return res.status(400).json({ ok: false, message: "VARIANT_NOT_FOUND" });

    const [b1, b2] = await Promise.all([
      Branch.findById(fromBranchId).select("_id").lean(),
      Branch.findById(toBranchId).select("_id").lean(),
    ]);
    if (!b1 || !b2) return res.status(400).json({ ok: false, message: "BRANCH_NOT_FOUND" });

    const sFrom = await getOrCreateStock(variantId, fromBranchId);
    const sTo = await getOrCreateStock(variantId, toBranchId);

    const beforeFrom = Number(sFrom.qty || 0);
    const beforeTo = Number(sTo.qty || 0);

    const afterFrom = Math.max(0, beforeFrom - qty);
    const moved = beforeFrom - afterFrom; // nếu thiếu hàng thì chuyển tối đa
    const afterTo = beforeTo + moved;

    sFrom.qty = afterFrom;
    sTo.qty = afterTo;

    await Promise.all([sFrom.save(), sTo.save()]);

    const note = String(body.data.note || "");

    await VariantStockTxn.create({
      variantId,
      branchId: fromBranchId,
      type: "TRANSFER_OUT",
      qty: moved,
      before: beforeFrom,
      after: afterFrom,
      note,
      createdBy: req.user?._id,
    });

    await VariantStockTxn.create({
      variantId,
      branchId: toBranchId,
      type: "TRANSFER_IN",
      qty: moved,
      before: beforeTo,
      after: afterTo,
      note,
      createdBy: req.user?._id,
    });

    res.json({ ok: true, moved, from: { before: beforeFrom, after: afterFrom }, to: { before: beforeTo, after: afterTo } });
  })
);

// ===== TXN history
router.get(
  "/txns",
  authRequired,
  asyncHandler(async (req, res) => {
    const variantId = String(req.query.variantId || "").trim();
    const branchId = resolveBranchId(req);

    const filter = {};
    if (variantId) filter.variantId = variantId;
    if (branchId !== "all") filter.branchId = branchId;

    const items = await VariantStockTxn.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ ok: true, branchId, items });
  })
);

module.exports = router;
