const router = require("express").Router();
const { z } = require("zod");
const mongoose = require("mongoose");
const Branch = require("../models/Branch");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

// ===== CREATE =====
router.post(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(2),
        name: z.string().min(2),
        address: z.string().optional(),
        phone: z.string().optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const br = await Branch.create({
      ...body.data,
      code: String(body.data.code).trim().toUpperCase(),
      address: body.data.address || "",
      phone: body.data.phone || "",
    });

    res.json({ ok: true, branch: br });
  })
);

// ===== LIST =====
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

// ✅ ===== GET BY ID (NEW) =====
router.get(
  "/:id",
  authRequired,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, message: "Branch id không hợp lệ" });
    }

    const role = String(req.user?.role || "").toUpperCase();
    const userBranchId = req.user?.branchId ? String(req.user.branchId) : null;

    // STAFF chỉ được xem branch của mình
    if (role === "STAFF") {
      if (!userBranchId || userBranchId !== String(id)) {
        return res.status(403).json({ ok: false, message: "Không có quyền truy cập chi nhánh này" });
      }
    }

    const br = await Branch.findOne({ _id: id, isActive: true }).lean();
    if (!br) return res.status(404).json({ ok: false, message: "Branch không tồn tại" });

    return res.json({ ok: true, branch: br });
  })
);

// ===== UPDATE =====
const updateSchema = z.object({
  code: z.string().min(2).optional(),
  name: z.string().min(2).optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  isActive: z.boolean().optional(),
  isMain: z.boolean().optional(), // ✅ Set Main Brand

  // fields mới bạn đã thêm vào schema
  brandName: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  taxCode: z.string().optional(),
  logo: z.string().optional(),

  receipt: z
    .object({
      header: z.string().optional(),
      footer: z.string().optional(),
      paperSize: z.number().optional(), // 56 | 80
      showLogo: z.boolean().optional(),
      showTaxCode: z.boolean().optional(),
      showQRCode: z.boolean().optional(),
      // ✅ nếu bạn lưu mẫu bill vào branch.receipt.template
      template: z.array(z.any()).optional(),
    })
    .optional(),

  posConfig: z
    .object({
      allowNegativeStock: z.boolean().optional(),
      autoPrintReceipt: z.boolean().optional(),
      defaultPaymentMethod: z.enum(["CASH", "BANK", "QR", "CARD"]).optional(),
    })
    .optional(),
});

router.put(
  "/:id",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, message: "Branch id không hợp lệ" });
    }

    const body = updateSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const data = body.data;

    // chỉ update những field được phép
    const set = {};

    if (data.code !== undefined) set.code = String(data.code).trim().toUpperCase();
    if (data.name !== undefined) set.name = data.name;
    if (data.address !== undefined) set.address = data.address || "";
    if (data.phone !== undefined) set.phone = data.phone || "";
    if (data.isActive !== undefined) set.isActive = !!data.isActive;

    // ✅ IMPORTANT: bạn đã parse isMain nhưng trước đó chưa set
    if (data.isMain !== undefined) set.isMain = !!data.isMain;

    if (data.brandName !== undefined) set.brandName = data.brandName || "";
    if (data.email !== undefined) set.email = String(data.email || "").toLowerCase().trim();
    if (data.taxCode !== undefined) set.taxCode = data.taxCode || "";
    if (data.logo !== undefined) set.logo = data.logo || "";

    // merge nested để không bị overwrite mất key cũ
    if (data.receipt) {
      for (const [k, v] of Object.entries(data.receipt)) {
        if (v !== undefined) set[`receipt.${k}`] = v;
      }
    }

    if (data.posConfig) {
      for (const [k, v] of Object.entries(data.posConfig)) {
        if (v !== undefined) set[`posConfig.${k}`] = v;
      }
    }

    try {
      // ✅ nếu bật isMain=true -> tắt isMain của các branch khác trước
      if (data.isMain === true) {
        await Branch.updateMany(
          { _id: { $ne: id }, isActive: true, isMain: true },
          { $set: { isMain: false } }
        );
      }

      const updated = await Branch.findByIdAndUpdate(
        id,
        { $set: set },
        { new: true, runValidators: true }
      ).lean();

      if (!updated) return res.status(404).json({ ok: false, message: "Branch không tồn tại" });

      return res.json({ ok: true, branch: updated });
    } catch (err) {
      // handle duplicate key (code unique)
      if (String(err?.code) === "11000") {
        return res.status(409).json({
          ok: false,
          message: "Branch code đã tồn tại",
          key: err?.keyValue,
        });
      }
      throw err;
    }
  })
);

module.exports = router;
