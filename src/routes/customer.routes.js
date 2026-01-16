const router = require("express").Router();
const { z } = require("zod");

const Customer = require("../models/Customer");
const { authRequired } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

function parseDob(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

// GET /api/customers?q=...
// GET /api/customers?q=...
router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || "").trim();

    const filter = q
      ? {
          $or: [
            { phone: { $regex: q, $options: "i" } },
            { name: { $regex: q, $options: "i" } },
          ],
        }
      : {};

    const docs = await Customer.find(filter)
      .sort({ updatedAt: -1 })
      .limit(200)
      .populate({
        path: "tierAgencyId",
        select: "name level", // ✅ lấy name + level
      })
      .lean();

    const items = docs.map((c) => {
      const agency = c?.tierAgencyId;

      return {
        ...c,

        // ✅ flatten ra cho FE dùng dễ
        tierAgencyId: agency?._id || null,
        tierAgencyName: agency?.name || "",
        tierAgencyLevel: agency?.level ?? null,
      };
    });

    res.json({ ok: true, items });
  })
);


// GET /api/customers/:id?branchId=...
router.get(
  "/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // lấy branchId từ query hoặc token
    const branchId = String(req.query.branchId || req.user?.branchId || "").trim();
    if (!branchId) {
      return res.status(400).json({ ok: false, message: "branchId is required" });
    }

    const customer = await Customer.findOne({
      _id: id,
      branchId, // ✅ đảm bảo đúng chi nhánh
    }).lean();

    if (!customer) {
      return res.status(404).json({ ok: false, message: "Customer not found" });
    }

    res.json({ ok: true, customer });
  })
);

// POST /api/customers (create)
router.post(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        phone: z.string().optional(),
        name: z.string().optional(),
        email: z.string().optional(),

        // ✅ NEW
        dob: z.union([z.string(), z.date()]).optional(),
        tier: z.enum(["NEW", "BRONZE", "SILVER", "GOLD", "PLATINUM", "VIP"]).optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const dob = parseDob(body.data.dob);

    const c = await Customer.create({
      phone: body.data.phone || undefined,
      name: body.data.name || "",
      email: body.data.email || "",
      dob: dob || null,
      tier: body.data.tier || "NEW",
      tierUpdatedAt: body.data.tier ? new Date() : null,
    });

    res.json({ ok: true, customer: c });
  })
);

// PATCH /api/customers/:id (optional update)
router.patch(
  "/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        phone: z.string().optional(),
        name: z.string().optional(),
        email: z.string().optional(),
        dob: z.union([z.string(), z.date(), z.null()]).optional(),
        tier: z.enum(["NEW", "BRONZE", "SILVER", "GOLD", "PLATINUM", "VIP"]).optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const setObj = {};
    if (body.data.phone !== undefined) setObj.phone = body.data.phone || undefined;
    if (body.data.name !== undefined) setObj.name = body.data.name || "";
    if (body.data.email !== undefined) setObj.email = body.data.email || "";

    if (body.data.dob !== undefined) {
      if (body.data.dob === null) setObj.dob = null;
      else {
        const d = parseDob(body.data.dob);
        if (d) setObj.dob = d;
      }
    }

    if (body.data.tier) {
      setObj.tier = body.data.tier;
      setObj.tierUpdatedAt = new Date();
    }

    const customer = await Customer.findByIdAndUpdate(req.params.id, { $set: setObj }, { new: true }).lean();
    if (!customer) return res.status(404).json({ ok: false, message: "Customer not found" });

    res.json({ ok: true, customer });
  })
);

module.exports = router;
