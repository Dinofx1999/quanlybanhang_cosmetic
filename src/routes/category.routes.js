const router = require("express").Router();
const { z } = require("zod");
const mongoose = require("mongoose");

const Category = require("../models/Category");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

// list
router.get("/", authRequired, asyncHandler(async (_req, res) => {
  const items = await Category.find({ isActive: true })
    .sort({ order: 1, name: 1 })
    .lean();
  res.json({ ok: true, items });
}));

// create
router.post("/", authRequired, requireRole(["ADMIN","MANAGER"]), asyncHandler(async (req, res) => {
  const body = z.object({
    code: z.string().min(2),
    name: z.string().min(2),
    parentId: z.string().optional(),
    order: z.number().int().optional(),
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  const slug = body.data.name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-");

  const c = await Category.create({
    ...body.data,
    slug,
    parentId: body.data.parentId || null,
    order: body.data.order || 0,
  });

  res.json({ ok: true, category: c });
}));

// UPDATE category
// PUT /api/categories/:id
router.put(
  "/:id",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const categoryId = req.params.id;
    if (!mongoose.isValidObjectId(categoryId)) {
      return res.status(400).json({ ok: false, message: "INVALID_CATEGORY_ID" });
    }

    const body = z
      .object({
        code: z.string().min(2).optional(),
        name: z.string().min(2).optional(),
        parentId: z.string().optional().nullable(),
        order: z.number().int().optional(),
        isActive: z.boolean().optional(),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

    const data = body.data;

    // validate parentId nếu có
    if (data.parentId !== undefined && data.parentId !== null) {
      if (!mongoose.isValidObjectId(data.parentId)) {
        return res.status(400).json({ ok: false, message: "INVALID_PARENT_ID" });
      }
    }

    const update = {};
    for (const k of Object.keys(data)) {
      if (data[k] !== undefined) update[k] = data[k];
    }

    if (update.code) update.code = String(update.code).trim().toUpperCase();
    if (update.name) update.name = String(update.name).trim();

    // nếu sửa name => update slug
    if (update.name) {
      update.slug = update.name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "-");
    }

    const c = await Category.findByIdAndUpdate(categoryId, update, {
      new: true,
      runValidators: true,
    });

    if (!c) return res.status(404).json({ ok: false, message: "CATEGORY_NOT_FOUND" });

    res.json({ ok: true, category: c });
  })
);

module.exports = router;
