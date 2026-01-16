const router = require("express").Router();
const { z } = require("zod");
const mongoose = require("mongoose");

const Category = require("../models/Category");
const { authRequired, requireRole } = require("../middlewares/auth");
const { asyncHandler } = require("../utils/asyncHandler");

// ===============================
// HELPER FUNCTIONS
// ===============================

/**
 * Tính level và path cho category dựa vào parentId
 * @param {String|null} parentId - ID của parent category
 * @returns {Object} { level, path, parentName }
 */
async function calculateCategoryMetadata(parentId) {
  // Nếu không có parent => root category
  if (!parentId) {
    return {
      level: 0,
      path: [],
      parentName: null,
    };
  }

  // Tìm parent category
  const parent = await Category.findById(parentId);
  if (!parent) {
    throw new Error("PARENT_CATEGORY_NOT_FOUND");
  }

  // ✅ FIX: Kiểm tra parent.path có phải array không
  const parentPath = Array.isArray(parent.path) ? parent.path : [];
  
  // Tính level, path, parentName từ parent
  return {
    level: (parent.level || 0) + 1,  // ✅ FIX: Fallback nếu parent.level undefined
    path: [...parentPath, parentId],
    parentName: parent.name,
  };
}

/**
 * Build cây phân cấp từ danh sách flat
 */
function buildTree(categories, parentId = null) {
  return categories
    .filter((cat) => {
      const catParentId = cat.parentId ? String(cat.parentId) : null;
      const compareParentId = parentId ? String(parentId) : null;
      return catParentId === compareParentId;
    })
    .map((cat) => ({
      ...cat,
      children: buildTree(categories, cat._id),
    }));
}

/**
 * Lấy tất cả category con (recursive - tất cả cấp)
 */
async function getAllDescendants(categoryId) {
  const descendants = [];
  const queue = [categoryId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const children = await Category.find({ parentId: currentId })
      .select("_id")
      .lean();

    for (const child of children) {
      descendants.push(child._id);
      queue.push(child._id);
    }
  }

  return descendants;
}

/**
 * Kiểm tra circular reference
 */
async function checkCircularReference(categoryId, newParentId) {
  if (!newParentId) return false;
  
  if (String(categoryId) === String(newParentId)) return true;

  const descendants = await getAllDescendants(categoryId);
  
  return descendants.some((id) => String(id) === String(newParentId));
}

/**
 * Update path và level cho tất cả children khi parent thay đổi
 */
async function updateChildrenPaths(categoryId) {
  const category = await Category.findById(categoryId);
  if (!category) return;

  const children = await Category.find({ parentId: categoryId });

  for (const child of children) {
    // ✅ FIX: Kiểm tra category.path
    const categoryPath = Array.isArray(category.path) ? category.path : [];
    
    child.path = [...categoryPath, categoryId];
    child.level = (category.level || 0) + 1;  // ✅ FIX: Fallback
    await child.save();

    await updateChildrenPaths(child._id);
  }
}

// ===============================
// ROUTES
// ===============================

/**
 * GET /api/categories
 */
router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const { parentId, includeChildren, format } = req.query;

    let query = { isActive: true };

    if (parentId === "root" || parentId === "null") {
      query.parentId = null;
    } else if (parentId && mongoose.isValidObjectId(parentId)) {
      query.parentId = parentId;
    }

    let categories = await Category.find(query)
      .sort({ order: 1, name: 1 })
      .lean();

    if (includeChildren === "true" && parentId && mongoose.isValidObjectId(parentId)) {
      const descendants = await getAllDescendants(parentId);
      const childCategories = await Category.find({
        _id: { $in: descendants },
        isActive: true,
      })
        .sort({ order: 1, name: 1 })
        .lean();

      categories = [...categories, ...childCategories];
    }

    if (format === "tree") {
      const tree = buildTree(
        categories,
        parentId && mongoose.isValidObjectId(parentId) ? parentId : null
      );
      return res.json({ ok: true, tree, total: categories.length });
    }

    res.json({ ok: true, items: categories, total: categories.length });
  })
);

/**
 * GET /api/categories/tree
 */
router.get(
  "/tree",
  authRequired,
  asyncHandler(async (req, res) => {
    const allCategories = await Category.find({ isActive: true })
      .sort({ order: 1, name: 1 })
      .lean();

    const tree = buildTree(allCategories, null);

    res.json({ ok: true, tree, total: allCategories.length });
  })
);

/**
 * GET /api/categories/:id/path
 */
router.get(
  "/:id/path",
  authRequired,
  asyncHandler(async (req, res) => {
    const categoryId = req.params.id;
    if (!mongoose.isValidObjectId(categoryId)) {
      return res.status(400).json({ ok: false, message: "INVALID_CATEGORY_ID" });
    }

    const category = await Category.findById(categoryId);
    if (!category) {
      return res.status(404).json({ ok: false, message: "CATEGORY_NOT_FOUND" });
    }

    // ✅ FIX: Kiểm tra category.path
    const categoryPath = Array.isArray(category.path) ? category.path : [];

    const pathCategories = await Category.find({
      _id: { $in: categoryPath },
    })
      .sort({ level: 1 })
      .lean();

    const fullPath = [...pathCategories, category];

    res.json({
      ok: true,
      path: fullPath,
      breadcrumb: fullPath.map((c) => ({
        _id: c._id,
        name: c.name,
        code: c.code,
      })),
    });
  })
);

/**
 * GET /api/categories/:id/children
 */
router.get(
  "/:id/children",
  authRequired,
  asyncHandler(async (req, res) => {
    const categoryId = req.params.id;
    if (!mongoose.isValidObjectId(categoryId)) {
      return res.status(400).json({ ok: false, message: "INVALID_CATEGORY_ID" });
    }

    const children = await Category.find({
      parentId: categoryId,
      isActive: true,
    })
      .sort({ order: 1, name: 1 })
      .lean();

    res.json({ ok: true, items: children, total: children.length });
  })
);

/**
 * GET /api/categories/:id/descendants
 */
router.get(
  "/:id/descendants",
  authRequired,
  asyncHandler(async (req, res) => {
    const categoryId = req.params.id;
    if (!mongoose.isValidObjectId(categoryId)) {
      return res.status(400).json({ ok: false, message: "INVALID_CATEGORY_ID" });
    }

    const descendantIds = await getAllDescendants(categoryId);
    const descendants = await Category.find({
      _id: { $in: descendantIds },
      isActive: true,
    })
      .sort({ level: 1, order: 1, name: 1 })
      .lean();

    res.json({ ok: true, items: descendants, total: descendants.length });
  })
);

/**
 * POST /api/categories
 */
router.post(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(2),
        name: z.string().min(2),
        parentId: z.string().optional().nullable(),
        order: z.number().int().optional(),
      })
      .safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({ ok: false, error: body.error.flatten() });
    }

    const { code, name, parentId, order } = body.data;

    const existingCode = await Category.findOne({
      code: code.toUpperCase(),
    });
    if (existingCode) {
      return res.status(400).json({
        ok: false,
        message: "CODE_ALREADY_EXISTS",
      });
    }

    // ✅ FIX: Thêm try-catch
    let metadata;
    try {
      metadata = await calculateCategoryMetadata(parentId || null);
    } catch (error) {
      return res.status(400).json({ 
        ok: false, 
        message: error.message || "CALCULATE_METADATA_ERROR" 
      });
    }

    const slug = name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "-");

    const category = await Category.create({
      code: code.toUpperCase(),
      name: name.trim(),
      slug,
      parentId: parentId || null,
      level: metadata.level,
      path: metadata.path,
      parentName: metadata.parentName,
      order: order || 0,
      isActive: true,
    });

    res.json({ ok: true, category });
  })
);

/**
 * PUT /api/categories/:id
 */
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

    if (!body.success) {
      return res.status(400).json({ ok: false, error: body.error.flatten() });
    }

    const category = await Category.findById(categoryId);
    if (!category) {
      return res.status(404).json({ ok: false, message: "CATEGORY_NOT_FOUND" });
    }

    const data = body.data;

    if (data.code && data.code.toUpperCase() !== category.code) {
      const existingCode = await Category.findOne({
        code: data.code.toUpperCase(),
        _id: { $ne: categoryId },
      });
      if (existingCode) {
        return res.status(400).json({
          ok: false,
          message: "CODE_ALREADY_EXISTS",
        });
      }
    }

    // ✅ FIX: Xử lý parentId change
    if (data.parentId !== undefined) {
      if (data.parentId && !mongoose.isValidObjectId(data.parentId)) {
        return res.status(400).json({ ok: false, message: "INVALID_PARENT_ID" });
      }

      if (data.parentId) {
        const isCircular = await checkCircularReference(categoryId, data.parentId);
        if (isCircular) {
          return res.status(400).json({
            ok: false,
            message: "CIRCULAR_REFERENCE_NOT_ALLOWED",
          });
        }
      }

      const currentParentId = category.parentId ? String(category.parentId) : null;
      const newParentId = data.parentId ? String(data.parentId) : null;

      if (currentParentId !== newParentId) {
        // ✅ FIX: Thêm try-catch
        try {
          const metadata = await calculateCategoryMetadata(data.parentId || null);
          category.level = metadata.level;
          category.path = metadata.path;
          category.parentName = metadata.parentName;
          category.parentId = data.parentId || null;

          await updateChildrenPaths(categoryId);
        } catch (error) {
          return res.status(400).json({ 
            ok: false, 
            message: error.message || "UPDATE_METADATA_ERROR" 
          });
        }
      }
    }

    if (data.code) {
      category.code = data.code.toUpperCase();
    }

    if (data.name) {
      category.name = data.name.trim();
      category.slug = data.name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "-");

      await Category.updateMany(
        { parentId: categoryId },
        { parentName: data.name.trim() }
      );
    }

    if (data.order !== undefined) {
      category.order = data.order;
    }

    if (data.isActive !== undefined) {
      category.isActive = data.isActive;
    }

    await category.save();

    res.json({ ok: true, category });
  })
);

/**
 * DELETE /api/categories/:id
 */
router.delete(
  "/:id",
  authRequired,
  requireRole(["ADMIN"]),
  asyncHandler(async (req, res) => {
    const categoryId = req.params.id;
    if (!mongoose.isValidObjectId(categoryId)) {
      return res.status(400).json({ ok: false, message: "INVALID_CATEGORY_ID" });
    }

    const hasChildren = await Category.countDocuments({
      parentId: categoryId,
    });
    if (hasChildren > 0) {
      return res.status(400).json({
        ok: false,
        message: "CANNOT_DELETE_CATEGORY_WITH_CHILDREN",
        childrenCount: hasChildren,
      });
    }

    const category = await Category.findByIdAndUpdate(
      categoryId,
      { isActive: false },
      { new: true }
    );

    if (!category) {
      return res.status(404).json({ ok: false, message: "CATEGORY_NOT_FOUND" });
    }

    res.json({ ok: true, message: "CATEGORY_DELETED", category });
  })
);

/**
 * POST /api/categories/:id/move
 */
router.post(
  "/:id/move",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    const categoryId = req.params.id;
    if (!mongoose.isValidObjectId(categoryId)) {
      return res.status(400).json({ ok: false, message: "INVALID_CATEGORY_ID" });
    }

    const body = z
      .object({
        newParentId: z.string().nullable(),
      })
      .safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({ ok: false, error: body.error.flatten() });
    }

    const { newParentId } = body.data;

    if (newParentId && !mongoose.isValidObjectId(newParentId)) {
      return res.status(400).json({ ok: false, message: "INVALID_PARENT_ID" });
    }

    if (newParentId) {
      const isCircular = await checkCircularReference(categoryId, newParentId);
      if (isCircular) {
        return res.status(400).json({
          ok: false,
          message: "CIRCULAR_REFERENCE_NOT_ALLOWED",
        });
      }
    }

    const category = await Category.findById(categoryId);
    if (!category) {
      return res.status(404).json({ ok: false, message: "CATEGORY_NOT_FOUND" });
    }

    // ✅ FIX: Thêm try-catch
    try {
      const metadata = await calculateCategoryMetadata(newParentId);

      category.parentId = newParentId || null;
      category.level = metadata.level;
      category.path = metadata.path;
      category.parentName = metadata.parentName;

      await category.save();
      await updateChildrenPaths(categoryId);

      res.json({ ok: true, message: "CATEGORY_MOVED", category });
    } catch (error) {
      return res.status(400).json({ 
        ok: false, 
        message: error.message || "MOVE_CATEGORY_ERROR" 
      });
    }
  })
);

module.exports = router;