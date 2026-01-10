const router = require("express").Router();
const { z } = require("zod");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const User = require("../models/User");
const Branch = require("../models/Branch");
const { env } = require("../config/env");
const { asyncHandler } = require("../utils/asyncHandler");

// ===============================
// ✅ GET USER BY ID
// GET /users/:id
// ===============================
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // validate ObjectId (nhanh + đủ dùng)
    if (!id || !/^[0-9a-fA-F]{24}$/.test(String(id))) {
      return res.status(400).json({ ok: false, message: "User ID không hợp lệ" });
    }

    const user = await User.findById(id)
      .select("_id username name role branchId isActive createdAt updatedAt")
      .lean();

    if (!user) return res.status(404).json({ ok: false, message: "User không tồn tại" });

    return res.json({ ok: true, user });
  })
);

// ===============================
// ✅ GET MANY USERS BY IDS (BATCH)
// POST /users/by-ids
// body: { ids: string[] }
// ===============================
router.post(
  "/by-ids",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        ids: z.array(z.string()).default([]),
      })
      .safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({ ok: false, error: body.error.flatten() });
    }

    const ids = (body.data.ids || [])
      .map((x) => String(x).trim())
      .filter((x) => /^[0-9a-fA-F]{24}$/.test(x));

    if (ids.length === 0) return res.json({ ok: true, items: [] });

    const items = await User.find({ _id: { $in: ids } })
      .select("_id username name role branchId isActive")
      .lean();

    return res.json({ ok: true, items });
  })
);

// ===============================
// REGISTER
// ===============================
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        username: z.string().min(3),
        password: z.string().min(6),
        name: z.string().optional(),
        role: z.enum(["ADMIN", "MANAGER", "CASHIER", "STAFF"]).optional(),
        branchCode: z.string().optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const { username, password, name, role, branchCode } = body.data;

    const exists = await User.findOne({ username }).lean();
    if (exists) return res.status(409).json({ ok: false, message: "Username đã tồn tại" });

    let branchId = null;
    if (branchCode) {
      const br = await Branch.findOne({ code: branchCode }).lean();
      if (!br) return res.status(400).json({ ok: false, message: "BranchCode không tồn tại" });
      branchId = br._id;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const u = await User.create({
      username,
      passwordHash,
      name: name || "",
      role: role || "STAFF",
      branchId,
    });

    res.json({
      ok: true,
      user: { id: u._id, username: u.username, role: u.role, branchId: u.branchId },
    });
  })
);

// ===============================
// LOGIN
// ===============================
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = z.object({ username: z.string(), password: z.string() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const u = await User.findOne({ username: body.data.username, isActive: true }).lean();
    if (!u) return res.status(401).json({ ok: false, message: "Sai tài khoản hoặc mật khẩu" });

    const ok = await bcrypt.compare(body.data.password, u.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, message: "Sai tài khoản hoặc mật khẩu" });

    const token = jwt.sign(
      { sub: String(u._id), role: u.role, branchId: u.branchId ? String(u.branchId) : null },
      env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      ok: true,
      token,
      user: { id: u._id, username: u.username, role: u.role, branchId: u.branchId },
    });
  })
);

module.exports = router;
