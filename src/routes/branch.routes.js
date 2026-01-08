const router = require("express").Router();
const { z } = require("zod");
const Branch = require("../models/Branch");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

// router.get("/", authRequired, asyncHandler(async (_req, res) => {
//   const items = await Branch.find({ isActive: true }).sort({ updatedAt: -1 }).lean();
//   res.json({ ok: true, items });
// }));

router.post("/", authRequired, requireRole(["ADMIN", "MANAGER"]), asyncHandler(async (req, res) => {
  const body = z.object({
    code: z.string().min(2),
    name: z.string().min(2),
    address: z.string().optional(),
    phone: z.string().optional(),
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  const br = await Branch.create({
    ...body.data,
    address: body.data.address || "",
    phone: body.data.phone || "",
  });

  res.json({ ok: true, branch: br });
}));

router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const role = String(req.user?.role || "").toUpperCase();
    const userBranchId = req.user?.branchId ? String(req.user.branchId) : null;

    if (role === "STAFF") {
      if (!userBranchId) return res.json({ ok: true, items: [] });
      const one = await Branch.findOne({ _id: userBranchId, isActive: true }).lean();
      return res.json({ ok: true, items: one ? [one] : [] });
    }

    const items = await Branch.find({ isActive: true }).sort({ name: 1 }).lean();
    res.json({ ok: true, items });
  })
);

module.exports = router;
