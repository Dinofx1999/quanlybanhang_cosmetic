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

  // Tính level, path, parentName từ parent
  return {
    level: parent.level + 1,
    path: [...parent.path, parentId],
    parentName: parent.name,
  };
}

/**
 * Build cây phân cấp từ danh sách flat
 * @param {Array} categories - Danh sách categories flat
 * @param {String|null} parentId - ID của parent cần build children
 * @returns {Array} Cây phân cấp với children nested
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
 * @param {String} categoryId - ID của category cha
 * @returns {Array<String>} Danh sách IDs của tất cả descendants
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
 * Kiểm tra circular reference (vòng lặp cha-con)
 * VD: A không thể là con của chính A, hoặc con của con của A
 * @param {String} categoryId - ID của category đang xét
 * @param {String} newParentId - ID của parent mới muốn set
 * @returns {Boolean} true nếu có circular reference
 */
async function checkCircularReference(categoryId, newParentId) {
  if (!newParentId) return false;
  
  // Nếu parent mới chính là category hiện tại => circular
  if (String(categoryId) === String(newParentId)) return true;

  // Lấy tất cả descendants của category hiện tại
  const descendants = await getAllDescendants(categoryId);
  
  // Nếu parent mới nằm trong descendants => circular
  return descendants.some((id) => String(id) === String(newParentId));
}

/**
 * Update path và level cho tất cả children khi parent thay đổi
 * @param {String} categoryId - ID của category vừa thay đổi
 */
async function updateChildrenPaths(categoryId) {
  const category = await Category.findById(categoryId);
  if (!category) return;

  // Tìm tất cả children trực tiếp
  const children = await Category.find({ parentId: categoryId });

  for (const child of children) {
    // Update path và level của child
    child.path = [...category.path, categoryId];
    child.level = category.level + 1;
    await child.save();

    // Recursive update cho children của children
    await updateChildrenPaths(child._id);
  }
}

// ===============================
// ROUTES
// ===============================

/**
 * GET /api/categories
 * Lấy danh sách categories với các tùy chọn filter
 * 
 * Query params:
 *   - parentId: 'root' | 'null' | ObjectId
 *     + 'root' hoặc 'null': chỉ lấy root categories (không có parent)
 *     + ObjectId: lấy children của category này
 *   - includeChildren: 'true' | 'false'
 *     + 'true': bao gồm luôn tất cả descendants
 *   - format: 'flat' | 'tree'
 *     + 'flat': trả về array thông thường
 *     + 'tree': trả về cấu trúc cây với children nested
 * 
 * Response:
 *   { ok: true, items: [...], total: number }
 *   hoặc
 *   { ok: true, tree: [...], total: number }
 */
router.get(
  "/",
  authRequired,
  asyncHandler(async (req, res) => {
    const { parentId, includeChildren, format } = req.query;

    let query = { isActive: true };

    // Filter theo parentId
    if (parentId === "root" || parentId === "null") {
      // Chỉ lấy root categories
      query.parentId = null;
    } else if (parentId && mongoose.isValidObjectId(parentId)) {
      // Lấy children của category cụ thể
      query.parentId = parentId;
    }

    // Query categories theo filter
    let categories = await Category.find(query)
      .sort({ order: 1, name: 1 })
      .lean();

    // Nếu includeChildren = true, lấy luôn tất cả descendants
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

    // Nếu format = tree, build cây phân cấp
    if (format === "tree") {
      const tree = buildTree(
        categories,
        parentId && mongoose.isValidObjectId(parentId) ? parentId : null
      );
      return res.json({ ok: true, tree, total: categories.length });
    }

    // Mặc định trả về flat list
    res.json({ ok: true, items: categories, total: categories.length });
  })
);

/**
 * GET /api/categories/tree
 * Lấy toàn bộ cây danh mục (tất cả categories dạng tree)
 * 
 * Response:
 *   {
 *     ok: true,
 *     tree: [
 *       {
 *         _id: "...",
 *         name: "...",
 *         children: [...]
 *       }
 *     ],
 *     total: number
 *   }
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
 * Lấy đường dẫn đầy đủ của category (breadcrumb)
 * VD: Mỹ phẩm > Chăm sóc da > Kem dưỡng
 * 
 * Response:
 *   {
 *     ok: true,
 *     path: [ {...}, {...}, {...} ],  // Full category objects
 *     breadcrumb: [                   // Simplified for UI
 *       { _id: "...", name: "...", code: "..." }
 *     ]
 *   }
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

    // Lấy tất cả categories trong path
    const pathCategories = await Category.find({
      _id: { $in: category.path },
    })
      .sort({ level: 1 })
      .lean();

    // Thêm category hiện tại vào cuối path
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
 * Lấy tất cả children trực tiếp của category (chỉ level 1)
 * 
 * Response:
 *   { ok: true, items: [...], total: number }
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
 * Lấy tất cả descendants (tất cả cấp con)
 * VD: Con, cháu, chắt... tất cả
 * 
 * Response:
 *   { ok: true, items: [...], total: number }
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
 * Tạo category mới
 * 
 * Body:
 *   {
 *     code: string (required, min 2 chars),
 *     name: string (required, min 2 chars),
 *     parentId: string | null (optional),
 *     order: number (optional, default 0)
 *   }
 * 
 * Response:
 *   { ok: true, category: {...} }
 */
router.post(
  "/",
  authRequired,
  requireRole(["ADMIN", "MANAGER"]),
  asyncHandler(async (req, res) => {
    // Validate input
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

    // Check duplicate code
    const existingCode = await Category.findOne({
      code: code.toUpperCase(),
    });
    if (existingCode) {
      return res.status(400).json({
        ok: false,
        message: "CODE_ALREADY_EXISTS",
      });
    }

    // Tính metadata (level, path, parentName) từ parentId
    let metadata;
    try {
      metadata = await calculateCategoryMetadata(parentId || null);
    } catch (error) {
      return res.status(400).json({ ok: false, message: error.message });
    }

    // Tạo slug từ name
    const slug = name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "-");

    // Tạo category mới
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
 * Update category
 * 
 * Body:
 *   {
 *     code?: string,
 *     name?: string,
 *     parentId?: string | null,
 *     order?: number,
 *     isActive?: boolean
 *   }
 * 
 * Note: Khi đổi parentId, sẽ tự động update path/level cho category và tất cả children
 * 
 * Response:
 *   { ok: true, category: {...} }
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

    // Validate input
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

    // Check duplicate code (nếu đổi code)
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

    // Validate parentId và check circular reference
    if (data.parentId !== undefined) {
      if (data.parentId && !mongoose.isValidObjectId(data.parentId)) {
        return res.status(400).json({ ok: false, message: "INVALID_PARENT_ID" });
      }

      // Check circular reference (A không thể là con của chính A hoặc con của A)
      if (data.parentId) {
        const isCircular = await checkCircularReference(categoryId, data.parentId);
        if (isCircular) {
          return res.status(400).json({
            ok: false,
            message: "CIRCULAR_REFERENCE_NOT_ALLOWED",
          });
        }
      }

      // Nếu đổi parent, update metadata
      const currentParentId = category.parentId ? String(category.parentId) : null;
      const newParentId = data.parentId ? String(data.parentId) : null;

      if (currentParentId !== newParentId) {
        // Calculate metadata mới
        const metadata = await calculateCategoryMetadata(data.parentId || null);
        category.level = metadata.level;
        category.path = metadata.path;
        category.parentName = metadata.parentName;
        category.parentId = data.parentId || null;

        // Update path và level cho tất cả children
        await updateChildrenPaths(categoryId);
      }
    }

    // Update các fields khác
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

      // Update parentName cho các children
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
 * Xóa category (soft delete - set isActive = false)
 * 
 * Validation:
 *   - Không cho xóa nếu có children
 *   - Không cho xóa nếu có products (optional - uncomment code bên dưới)
 * 
 * Response:
 *   { ok: true, message: "CATEGORY_DELETED", category: {...} }
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

    // Check có children không
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

    // Check có products không (optional - uncomment nếu cần)
    // const Product = require('../models/Product');
    // const hasProducts = await Product.countDocuments({ categoryId });
    // if (hasProducts > 0) {
    //   return res.status(400).json({
    //     ok: false,
    //     message: 'CANNOT_DELETE_CATEGORY_WITH_PRODUCTS',
    //     productCount: hasProducts
    //   });
    // }

    // Soft delete - set isActive = false
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
 * Di chuyển category sang parent mới
 * 
 * Body:
 *   {
 *     newParentId: string | null
 *   }
 * 
 * Note: Sẽ tự động update path/level cho category và tất cả children
 * 
 * Response:
 *   { ok: true, message: "CATEGORY_MOVED", category: {...} }
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

    // Validate input
    const body = z
      .object({
        newParentId: z.string().nullable(),
      })
      .safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({ ok: false, error: body.error.flatten() });
    }

    const { newParentId } = body.data;

    // Validate new parent
    if (newParentId && !mongoose.isValidObjectId(newParentId)) {
      return res.status(400).json({ ok: false, message: "INVALID_PARENT_ID" });
    }

    // Check circular reference
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

    // Calculate new metadata
    const metadata = await calculateCategoryMetadata(newParentId);

    // Update category
    category.parentId = newParentId || null;
    category.level = metadata.level;
    category.path = metadata.path;
    category.parentName = metadata.parentName;

    await category.save();

    // Update tất cả children paths
    await updateChildrenPaths(categoryId);

    res.json({ ok: true, message: "CATEGORY_MOVED", category });
  })
);

module.exports = router;