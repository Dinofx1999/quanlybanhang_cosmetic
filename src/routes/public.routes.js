// src/routes/public.routes.js
const router = require("express").Router();
const mongoose = require("mongoose");

const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");
const Category = require("../models/Category");
const FlashSale = require("../models/FlashSale");
const { asyncHandler } = require("../utils/asyncHandler");

const PRODUCT_VARIANTS_COLLECTION = "productvariants";

function isValidObjectId(id) {
  return mongoose.isValidObjectId(String(id || ""));
}

// ===============================
// Helper: Get descendant categories
// ===============================
async function getAllDescendantCategories(categoryId) {
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

// ===============================
// Helper: Build category tree
// ===============================
function buildCategoryTree(categories, parentId = null) {
  return categories
    .filter((cat) => {
      const catParentId = cat.parentId ? String(cat.parentId) : null;
      const compareParentId = parentId ? String(parentId) : null;
      return catParentId === compareParentId;
    })
    .map((cat) => ({
      ...cat,
      children: buildCategoryTree(categories, cat._id),
    }));
}

// ===============================
// GET /api/public/products - Danh sách sản phẩm cho web
// ===============================
router.get(
  "/products",
  asyncHandler(async (req, res) => {
    const categoryId = req.query.categoryId ? String(req.query.categoryId) : null;
    const includeSubcategories = String(req.query.includeSubcategories || "true") === "true";
    const brand = req.query.brand ? String(req.query.brand) : null;
    const q = String(req.query.q || "").trim();
    
    const minPrice = req.query.minPrice !== undefined ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice !== undefined ? Number(req.query.maxPrice) : null;
    
    const sortBy = String(req.query.sortBy || "createdAt");
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;
    
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 24, 100);
    const skip = (page - 1) * limit;

    const isFlashSale = req.query.isFlashSale === "true";
    const isNew = req.query.isNew === "true";

    // ✅ Build query
    const query = { isActive: true };

    // ✅ Category filter with subcategories support
    if (categoryId && isValidObjectId(categoryId)) {
      let categoryIds = [new mongoose.Types.ObjectId(categoryId)];
      
      if (includeSubcategories) {
        const descendants = await getAllDescendantCategories(categoryId);
        categoryIds = [
          new mongoose.Types.ObjectId(categoryId),
          ...descendants.map(id => new mongoose.Types.ObjectId(id))
        ];
      }
      
      query.categoryId = { $in: categoryIds };
    }

    if (brand) query.brand = brand;

    if (q) {
      query.$or = [
        { name: { $regex: q, $options: "i" } },
        { sku: { $regex: q, $options: "i" } }
      ];
    }

    if (isFlashSale) {
      query.activeFlashSaleId = { $ne: null };
      query.flashSaleEndDate = { $gte: new Date() };
    }

    if (isNew) {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      query.createdAt = { $gte: thirtyDaysAgo };
    }

    // ✅ Aggregate
    const sortOptions = {};
    
    if (sortBy === "price") {
      sortOptions.minPrice = sortOrder;
    } else if (sortBy === "discount") {
      sortOptions.maxDiscount = -1;
    } else if (sortBy === "name") {
      sortOptions.name = sortOrder;
    } else {
      sortOptions.createdAt = sortOrder;
    }

    const agg = await Product.aggregate([
      { $match: query },

      // Join variants để lấy price range
      {
        $lookup: {
          from: PRODUCT_VARIANTS_COLLECTION,
          let: { pid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$productId", "$$pid"] },
                    { $eq: ["$isActive", true] }
                  ]
                }
              }
            },
            {
              $project: {
                displayPrice: {
                  $cond: [
                    { $and: [
                      { $ne: ["$activeFlashSaleId", null] },
                      { $gte: ["$flashSaleEndDate", new Date()] }
                    ]},
                    { $ifNull: ["$flashSalePrice", "$price"] },
                    "$price"
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                minPrice: { $min: "$displayPrice" },
                maxPrice: { $max: "$displayPrice" }
              }
            }
          ],
          as: "_priceRange"
        }
      },
      { $addFields: { _pr: { $arrayElemAt: ["$_priceRange", 0] } } },

      // Calculate display values
      {
        $addFields: {
          minPrice: { $ifNull: ["$_pr.minPrice", "$price"] },
          maxPrice: { $ifNull: ["$_pr.maxPrice", "$price"] },
          displayPrice: {
            $cond: [
              { $and: [
                { $ne: ["$activeFlashSaleId", null] },
                { $gte: ["$flashSaleEndDate", new Date()] }
              ]},
              { $ifNull: ["$flashSalePrice", "$price"] },
              { $ifNull: ["$_pr.minPrice", "$price"] }
            ]
          },
          isFlashSale: {
            $cond: [
              { $and: [
                { $ne: ["$activeFlashSaleId", null] },
                { $gte: ["$flashSaleEndDate", new Date()] }
              ]},
              true,
              false
            ]
          },
          maxDiscount: {
            $cond: [
              { $and: [
                { $ne: ["$activeFlashSaleId", null] },
                { $gte: ["$flashSaleEndDate", new Date()] },
                { $ne: ["$flashSalePrice", null] },
                { $gt: ["$price", 0] }
              ]},
              {
                $multiply: [
                  { $divide: [
                    { $subtract: ["$price", "$flashSalePrice"] },
                    "$price"
                  ]},
                  100
                ]
              },
              0
            ]
          }
        }
      },

      // Price filter
      ...(minPrice !== null || maxPrice !== null ? [{
        $match: {
          minPrice: {
            ...(minPrice !== null && !Number.isNaN(minPrice) ? { $gte: minPrice } : {}),
            ...(maxPrice !== null && !Number.isNaN(maxPrice) ? { $lte: maxPrice } : {})
          }
        }
      }] : []),

      {
        $facet: {
          items: [
            { $sort: sortOptions },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _id: 1,
                sku: 1,
                name: 1,
                brand: 1,
                categoryId: 1,
                categoryName: 1,
                thumbnail: 1,
                images: { $slice: ["$images", 5] },
                
                price: 1,
                minPrice: 1,
                maxPrice: 1,
                displayPrice: 1,
                
                isFlashSale: 1,
                flashSalePrice: 1,
                flashSaleEndDate: 1,
                activeFlashSaleId: 1,
                maxDiscount: 1,
                
                defaultVariantId: 1,
                
                isActive: 1,
                createdAt: 1,
                updatedAt: 1
              }
            }
          ],
          total: [{ $count: "count" }],
          
          // Facets for filters
          brands: [
            { $group: { _id: "$brand", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 20 }
          ],
          priceRanges: [
            {
              $bucket: {
                groupBy: "$minPrice",
                boundaries: [0, 100000, 500000, 1000000, 5000000, 10000000, 999999999],
                default: "Other",
                output: { count: { $sum: 1 } }
              }
            }
          ]
        }
      }
    ]);

    const items = agg?.[0]?.items || [];
    const total = agg?.[0]?.total?.[0]?.count || 0;
    const brands = agg?.[0]?.brands || [];
    const priceRanges = agg?.[0]?.priceRanges || [];

    res.json({
      ok: true,
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      
      filters: {
        brands: brands.map(b => ({ name: b._id, count: b.count })),
        priceRanges: priceRanges.map(pr => ({
          min: pr._id === "Other" ? 10000000 : pr._id,
          max: pr._id === "Other" ? 999999999 : (pr._id + 100000),
          count: pr.count
        }))
      }
    });
  })
);

// ===============================
// GET /api/public/categories - Categories với subcategories
// ===============================
router.get(
  "/categories",
  asyncHandler(async (req, res) => {
    const parentId = req.query.parentId || null;

    const query = { isActive: true };
    
    if (parentId === "root" || parentId === null) {
      query.parentId = null;
    } else if (isValidObjectId(parentId)) {
      query.parentId = new mongoose.Types.ObjectId(parentId);
    }

    const categories = await Category.find(query)
      .sort({ order: 1, name: 1 })
      .lean();

    // ✅ Count products cho mỗi category (bao gồm cả subcategories)
    const categoryIds = categories.map(c => c._id);
    
    const productCounts = await Product.aggregate([
      {
        $match: {
          categoryId: { $in: categoryIds },
          isActive: true
        }
      },
      {
        $group: {
          _id: "$categoryId",
          count: { $sum: 1 }
        }
      }
    ]);

    const countMap = new Map();
    productCounts.forEach(pc => {
      countMap.set(String(pc._id), pc.count);
    });

    // ✅ Tính số lượng products bao gồm cả subcategories
    const itemsWithCount = await Promise.all(
      categories.map(async (cat) => {
        let totalCount = countMap.get(String(cat._id)) || 0;
        
        // Lấy tất cả descendant categories
        const descendants = await getAllDescendantCategories(cat._id);
        
        if (descendants.length > 0) {
          const descendantCounts = await Product.countDocuments({
            categoryId: { $in: descendants },
            isActive: true
          });
          totalCount += descendantCounts;
        }

        return {
          _id: cat._id,
          code: cat.code,
          name: cat.name,
          slug: cat.slug,
          level: cat.level,
          parentId: cat.parentId,
          productCount: countMap.get(String(cat._id)) || 0, // Chỉ category này
          totalProductCount: totalCount // Bao gồm cả subcategories
        };
      })
    );

    res.json({
      ok: true,
      items: itemsWithCount,
      total: itemsWithCount.length
    });
  })
);

// ===============================
// GET /api/public/categories/tree - Cây categories
// ===============================
router.get(
  "/categories/tree",
  asyncHandler(async (req, res) => {
    const allCategories = await Category.find({ isActive: true })
      .sort({ order: 1, name: 1 })
      .lean();

    // ✅ Count products cho từng category
    const categoryIds = allCategories.map(c => c._id);
    
    const productCounts = await Product.aggregate([
      {
        $match: {
          categoryId: { $in: categoryIds },
          isActive: true
        }
      },
      {
        $group: {
          _id: "$categoryId",
          count: { $sum: 1 }
        }
      }
    ]);

    const countMap = new Map();
    productCounts.forEach(pc => {
      countMap.set(String(pc._id), pc.count);
    });

    // ✅ Add product count to categories
    const categoriesWithCount = allCategories.map(cat => ({
      ...cat,
      productCount: countMap.get(String(cat._id)) || 0
    }));

    const tree = buildCategoryTree(categoriesWithCount, null);

    res.json({ ok: true, tree });
  })
);

// ===============================
// GET /api/public/categories/:id - Chi tiết category với subcategories
// ===============================
router.get(
  "/categories/:id",
  asyncHandler(async (req, res) => {
    const categoryId = req.params.id;
    
    if (!isValidObjectId(categoryId)) {
      return res.status(400).json({ 
        ok: false, 
        message: "INVALID_CATEGORY_ID" 
      });
    }

    const category = await Category.findOne({
      _id: new mongoose.Types.ObjectId(categoryId),
      isActive: true
    }).lean();

    if (!category) {
      return res.status(404).json({ 
        ok: false, 
        message: "CATEGORY_NOT_FOUND" 
      });
    }

    // ✅ Lấy breadcrumb (path từ root đến category hiện tại)
    const categoryPath = Array.isArray(category.path) ? category.path : [];
    const pathCategories = await Category.find({
      _id: { $in: categoryPath }
    })
      .sort({ level: 1 })
      .lean();

    const breadcrumb = [
      { name: "Trang chủ", url: "/", _id: null },
      ...pathCategories.map(c => ({
        _id: c._id,
        name: c.name,
        url: `/category/${c._id}`
      })),
      {
        _id: category._id,
        name: category.name,
        url: `/category/${category._id}`
      }
    ];

    // ✅ Lấy direct children (category con trực tiếp)
    const children = await Category.find({
      parentId: category._id,
      isActive: true
    })
      .sort({ order: 1, name: 1 })
      .lean();

    // ✅ Count products cho category này
    const directProductCount = await Product.countDocuments({
      categoryId: category._id,
      isActive: true
    });

    // ✅ Count tất cả products bao gồm subcategories
    const descendants = await getAllDescendantCategories(category._id);
    const allCategoryIds = [category._id, ...descendants];
    
    const totalProductCount = await Product.countDocuments({
      categoryId: { $in: allCategoryIds },
      isActive: true
    });

    // ✅ Count products cho từng child category
    const childrenWithCount = await Promise.all(
      children.map(async (child) => {
        const childDirectCount = await Product.countDocuments({
          categoryId: child._id,
          isActive: true
        });

        const childDescendants = await getAllDescendantCategories(child._id);
        const childTotalCount = await Product.countDocuments({
          categoryId: { $in: [child._id, ...childDescendants] },
          isActive: true
        });

        return {
          _id: child._id,
          code: child.code,
          name: child.name,
          slug: child.slug,
          level: child.level,
          productCount: childDirectCount,
          totalProductCount: childTotalCount
        };
      })
    );

    res.json({
      ok: true,
      category: {
        _id: category._id,
        code: category.code,
        name: category.name,
        slug: category.slug,
        level: category.level,
        parentId: category.parentId,
        parentName: category.parentName,
        productCount: directProductCount,
        totalProductCount: totalProductCount
      },
      breadcrumb,
      children: childrenWithCount,
      hasChildren: childrenWithCount.length > 0
    });
  })
);

// ===============================
// GET /api/public/categories/:id/products - Products trong category
// ===============================
router.get(
  "/categories/:id/products",
  asyncHandler(async (req, res) => {
    const categoryId = req.params.id;
    
    if (!isValidObjectId(categoryId)) {
      return res.status(400).json({ 
        ok: false, 
        message: "INVALID_CATEGORY_ID" 
      });
    }

    const category = await Category.findOne({
      _id: new mongoose.Types.ObjectId(categoryId),
      isActive: true
    }).lean();

    if (!category) {
      return res.status(404).json({ 
        ok: false, 
        message: "CATEGORY_NOT_FOUND" 
      });
    }

    // ✅ Query parameters
    const includeSubcategories = String(req.query.includeSubcategories || "true") === "true";
    const brand = req.query.brand ? String(req.query.brand) : null;
    const q = String(req.query.q || "").trim();
    
    const minPrice = req.query.minPrice !== undefined ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice !== undefined ? Number(req.query.maxPrice) : null;
    
    const sortBy = String(req.query.sortBy || "createdAt");
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;
    
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 24, 100);
    const skip = (page - 1) * limit;

    // ✅ Build category IDs
    let categoryIds = [new mongoose.Types.ObjectId(categoryId)];
    
    if (includeSubcategories) {
      const descendants = await getAllDescendantCategories(categoryId);
      categoryIds = [
        new mongoose.Types.ObjectId(categoryId),
        ...descendants.map(id => new mongoose.Types.ObjectId(id))
      ];
    }

    // ✅ Build query
    const query = { 
      isActive: true,
      categoryId: { $in: categoryIds }
    };

    if (brand) query.brand = brand;
    if (q) {
      query.$or = [
        { name: { $regex: q, $options: "i" } },
        { sku: { $regex: q, $options: "i" } }
      ];
    }

    // ✅ Sort options
    const sortOptions = {};
    
    if (sortBy === "price") {
      sortOptions.minPrice = sortOrder;
    } else if (sortBy === "discount") {
      sortOptions.maxDiscount = -1;
    } else if (sortBy === "name") {
      sortOptions.name = sortOrder;
    } else {
      sortOptions.createdAt = sortOrder;
    }

    // ✅ Aggregate
    const agg = await Product.aggregate([
      { $match: query },

      // Join variants để lấy price range
      {
        $lookup: {
          from: PRODUCT_VARIANTS_COLLECTION,
          let: { pid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$productId", "$$pid"] },
                    { $eq: ["$isActive", true] }
                  ]
                }
              }
            },
            {
              $project: {
                displayPrice: {
                  $cond: [
                    { $and: [
                      { $ne: ["$activeFlashSaleId", null] },
                      { $gte: ["$flashSaleEndDate", new Date()] }
                    ]},
                    { $ifNull: ["$flashSalePrice", "$price"] },
                    "$price"
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                minPrice: { $min: "$displayPrice" },
                maxPrice: { $max: "$displayPrice" }
              }
            }
          ],
          as: "_priceRange"
        }
      },
      { $addFields: { _pr: { $arrayElemAt: ["$_priceRange", 0] } } },

      // Calculate display values
      {
        $addFields: {
          minPrice: { $ifNull: ["$_pr.minPrice", "$price"] },
          maxPrice: { $ifNull: ["$_pr.maxPrice", "$price"] },
          displayPrice: {
            $cond: [
              { $and: [
                { $ne: ["$activeFlashSaleId", null] },
                { $gte: ["$flashSaleEndDate", new Date()] }
              ]},
              { $ifNull: ["$flashSalePrice", "$price"] },
              { $ifNull: ["$_pr.minPrice", "$price"] }
            ]
          },
          isFlashSale: {
            $cond: [
              { $and: [
                { $ne: ["$activeFlashSaleId", null] },
                { $gte: ["$flashSaleEndDate", new Date()] }
              ]},
              true,
              false
            ]
          },
          maxDiscount: {
            $cond: [
              { $and: [
                { $ne: ["$activeFlashSaleId", null] },
                { $gte: ["$flashSaleEndDate", new Date()] },
                { $ne: ["$flashSalePrice", null] },
                { $gt: ["$price", 0] }
              ]},
              {
                $multiply: [
                  { $divide: [
                    { $subtract: ["$price", "$flashSalePrice"] },
                    "$price"
                  ]},
                  100
                ]
              },
              0
            ]
          }
        }
      },

      // Price filter
      ...(minPrice !== null || maxPrice !== null ? [{
        $match: {
          minPrice: {
            ...(minPrice !== null && !Number.isNaN(minPrice) ? { $gte: minPrice } : {}),
            ...(maxPrice !== null && !Number.isNaN(maxPrice) ? { $lte: maxPrice } : {})
          }
        }
      }] : []),

      {
        $facet: {
          items: [
            { $sort: sortOptions },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _id: 1,
                sku: 1,
                name: 1,
                brand: 1,
                categoryId: 1,
                categoryName: 1,
                thumbnail: 1,
                images: { $slice: ["$images", 5] },
                
                price: 1,
                minPrice: 1,
                maxPrice: 1,
                displayPrice: 1,
                
                isFlashSale: 1,
                flashSalePrice: 1,
                flashSaleEndDate: 1,
                activeFlashSaleId: 1,
                maxDiscount: 1,
                
                defaultVariantId: 1,
                
                isActive: 1,
                createdAt: 1,
                updatedAt: 1
              }
            }
          ],
          total: [{ $count: "count" }],
          
          // Facets for filters
          brands: [
            { $group: { _id: "$brand", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 20 }
          ]
        }
      }
    ]);

    const items = agg?.[0]?.items || [];
    const total = agg?.[0]?.total?.[0]?.count || 0;
    const brands = agg?.[0]?.brands || [];

    // ✅ Lấy subcategories để hiển thị sidebar
    const subcategories = await Category.find({
      parentId: category._id,
      isActive: true
    })
      .sort({ order: 1, name: 1 })
      .select("_id name code slug")
      .lean();

    res.json({
      ok: true,
      category: {
        _id: category._id,
        name: category.name,
        code: category.code,
        slug: category.slug
      },
      includeSubcategories,
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      
      filters: {
        brands: brands.map(b => ({ name: b._id, count: b.count })),
        subcategories: subcategories.map(sc => ({
          _id: sc._id,
          name: sc.name,
          code: sc.code,
          slug: sc.slug
        }))
      }
    });
  })
);
// ===============================
// GET /api/public/products - Danh sách sản phẩm cho web
// ===============================
router.get(
  "/products",
  asyncHandler(async (req, res) => {
    const categoryId = req.query.categoryId ? String(req.query.categoryId) : null;
    const includeSubcategories = String(req.query.includeSubcategories || "true") === "true";
    const brand = req.query.brand ? String(req.query.brand) : null;
    const q = String(req.query.q || "").trim();
    
    const minPrice = req.query.minPrice !== undefined ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice !== undefined ? Number(req.query.maxPrice) : null;
    
    const sortBy = String(req.query.sortBy || "createdAt");
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;
    
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 24, 100);
    const skip = (page - 1) * limit;

    const isFlashSale = req.query.isFlashSale === "true";
    const isNew = req.query.isNew === "true";

    // ✅ Build query
    const query = { isActive: true };

    // Category filter
    if (categoryId && isValidObjectId(categoryId)) {
      let categoryIds = [new mongoose.Types.ObjectId(categoryId)];
      
      if (includeSubcategories) {
        const descendants = await getAllDescendantCategories(categoryId);
        categoryIds = [
          new mongoose.Types.ObjectId(categoryId),
          ...descendants.map(id => new mongoose.Types.ObjectId(id))
        ];
      }
      
      query.categoryId = { $in: categoryIds };
    }

    if (brand) query.brand = brand;

    if (q) {
      query.$or = [
        { name: { $regex: q, $options: "i" } },
        { sku: { $regex: q, $options: "i" } }
      ];
    }

    if (isFlashSale) {
      query.activeFlashSaleId = { $ne: null };
      query.flashSaleEndDate = { $gte: new Date() };
    }

    if (isNew) {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      query.createdAt = { $gte: thirtyDaysAgo };
    }

    // ✅ Aggregate
    const sortOptions = {};
    
    if (sortBy === "price") {
      sortOptions.minPrice = sortOrder;
    } else if (sortBy === "discount") {
      sortOptions.maxDiscount = -1;
    } else if (sortBy === "name") {
      sortOptions.name = sortOrder;
    } else {
      sortOptions.createdAt = sortOrder;
    }

    const agg = await Product.aggregate([
      { $match: query },

      // Join variants để lấy price range
      {
        $lookup: {
          from: PRODUCT_VARIANTS_COLLECTION,
          let: { pid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$productId", "$$pid"] },
                    { $eq: ["$isActive", true] }
                  ]
                }
              }
            },
            {
              $project: {
                displayPrice: {
                  $cond: [
                    { $and: [
                      { $ne: ["$activeFlashSaleId", null] },
                      { $gte: ["$flashSaleEndDate", new Date()] }
                    ]},
                    { $ifNull: ["$flashSalePrice", "$price"] },
                    "$price"
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                minPrice: { $min: "$displayPrice" },
                maxPrice: { $max: "$displayPrice" }
              }
            }
          ],
          as: "_priceRange"
        }
      },
      { $addFields: { _pr: { $arrayElemAt: ["$_priceRange", 0] } } },

      // Calculate display values
      {
        $addFields: {
          minPrice: { $ifNull: ["$_pr.minPrice", "$price"] },
          maxPrice: { $ifNull: ["$_pr.maxPrice", "$price"] },
          displayPrice: {
            $cond: [
              { $and: [
                { $ne: ["$activeFlashSaleId", null] },
                { $gte: ["$flashSaleEndDate", new Date()] }
              ]},
              { $ifNull: ["$flashSalePrice", "$price"] },
              { $ifNull: ["$_pr.minPrice", "$price"] }
            ]
          },
          isFlashSale: {
            $cond: [
              { $and: [
                { $ne: ["$activeFlashSaleId", null] },
                { $gte: ["$flashSaleEndDate", new Date()] }
              ]},
              true,
              false
            ]
          },
          maxDiscount: {
            $cond: [
              { $and: [
                { $ne: ["$activeFlashSaleId", null] },
                { $gte: ["$flashSaleEndDate", new Date()] },
                { $ne: ["$flashSalePrice", null] },
                { $gt: ["$price", 0] }
              ]},
              {
                $multiply: [
                  { $divide: [
                    { $subtract: ["$price", "$flashSalePrice"] },
                    "$price"
                  ]},
                  100
                ]
              },
              0
            ]
          }
        }
      },

      // Price filter
      ...(minPrice !== null || maxPrice !== null ? [{
        $match: {
          minPrice: {
            ...(minPrice !== null && !Number.isNaN(minPrice) ? { $gte: minPrice } : {}),
            ...(maxPrice !== null && !Number.isNaN(maxPrice) ? { $lte: maxPrice } : {})
          }
        }
      }] : []),

      {
        $facet: {
          items: [
            { $sort: sortOptions },
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _id: 1,
                sku: 1,
                name: 1,
                brand: 1,
                categoryId: 1,
                categoryName: 1,
                thumbnail: 1,
                images: { $slice: ["$images", 5] },
                
                price: 1,
                minPrice: 1,
                maxPrice: 1,
                displayPrice: 1,
                
                isFlashSale: 1,
                flashSalePrice: 1,
                flashSaleEndDate: 1,
                activeFlashSaleId: 1,
                maxDiscount: 1,
                
                defaultVariantId: 1,
                
                isActive: 1,
                createdAt: 1,
                updatedAt: 1
              }
            }
          ],
          total: [{ $count: "count" }],
          
          // Facets for filters
          brands: [
            { $group: { _id: "$brand", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 20 }
          ],
          priceRanges: [
            {
              $bucket: {
                groupBy: "$minPrice",
                boundaries: [0, 100000, 500000, 1000000, 5000000, 10000000, 999999999],
                default: "Other",
                output: { count: { $sum: 1 } }
              }
            }
          ]
        }
      }
    ]);

    const items = agg?.[0]?.items || [];
    const total = agg?.[0]?.total?.[0]?.count || 0;
    const brands = agg?.[0]?.brands || [];
    const priceRanges = agg?.[0]?.priceRanges || [];

    res.json({
      ok: true,
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      
      filters: {
        brands: brands.map(b => ({ name: b._id, count: b.count })),
        priceRanges: priceRanges.map(pr => ({
          min: pr._id === "Other" ? 10000000 : pr._id,
          max: pr._id === "Other" ? 999999999 : (pr._id + 100000),
          count: pr.count
        }))
      }
    });
  })
);

// ===============================
// GET /api/public/products/:id - Chi tiết sản phẩm
// ===============================
router.get(
  "/products/:id",
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    
    if (!isValidObjectId(productId)) {
      return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });
    }

    const product = await Product.findOne({
      _id: new mongoose.Types.ObjectId(productId),
      isActive: true
    }).lean();

    if (!product) {
      return res.status(404).json({ ok: false, message: "PRODUCT_NOT_FOUND" });
    }

    // Lấy variants
    const variants = await ProductVariant.find({
      productId: new mongoose.Types.ObjectId(productId),
      isActive: true
    })
      .sort({ isDefault: -1, order: 1, createdAt: 1 })
      .lean();

    if (!variants.length) {
      return res.status(404).json({ 
        ok: false, 
        message: "NO_VARIANTS_AVAILABLE" 
      });
    }

    // Lấy flash sale info
    const now = new Date();
    const activeFlashSaleIds = [
      ...new Set(
        variants
          .filter(v => v.activeFlashSaleId && v.flashSaleEndDate >= now)
          .map(v => String(v.activeFlashSaleId))
      )
    ];

    let flashSalesMap = new Map();
    if (activeFlashSaleIds.length > 0) {
      const flashSales = await FlashSale.find({
        _id: { $in: activeFlashSaleIds.map(id => new mongoose.Types.ObjectId(id)) },
        isActive: true,
        status: "ACTIVE",
        startDate: { $lte: now },
        endDate: { $gte: now }
      }).lean();

      flashSales.forEach(fs => {
        flashSalesMap.set(String(fs._id), fs);
      });
    }

    // Build options
    const attributeKeys = new Set();
    variants.forEach(v => {
      (v.attributes || []).forEach(attr => {
        attributeKeys.add(attr.k);
      });
    });

    const options = Array.from(attributeKeys).map(key => {
      const values = new Set();
      variants.forEach(v => {
        const attr = (v.attributes || []).find(a => a.k === key);
        if (attr) values.add(attr.v);
      });

      return {
        key,
        label: key.charAt(0).toUpperCase() + key.slice(1),
        values: Array.from(values)
      };
    });

    // Format variants
    const formattedVariants = variants.map(variant => {
      let displayPrice = variant.price;
      let isFlashSale = false;
      let flashSaleInfo = null;

      if (variant.activeFlashSaleId && variant.flashSaleEndDate >= now) {
        const fs = flashSalesMap.get(String(variant.activeFlashSaleId));
        
        if (fs) {
          isFlashSale = true;
          displayPrice = variant.flashSalePrice || variant.price;

          const fsVariant = fs.variants.find(
            v => String(v.variantId) === String(variant._id)
          );

          if (fsVariant) {
            const discountAmount = variant.price - fsVariant.flashPrice;
            const discountPercent = variant.price > 0 
              ? Math.round((discountAmount / variant.price) * 100)
              : 0;

            flashSaleInfo = {
              flashSaleId: fs._id,
              flashSaleName: fs.name,
              flashSaleCode: fs.code,
              startDate: fs.startDate,
              endDate: fs.endDate,
              originalPrice: variant.price,
              flashPrice: fsVariant.flashPrice,
              discountPercent,
              discountAmount,
              badge: fsVariant.badge || "",
              limitedQuantity: fsVariant.limitedQuantity,
              soldQuantity: fsVariant.soldQuantity,
              remainingQuantity: fsVariant.limitedQuantity
                ? Math.max(0, fsVariant.limitedQuantity - fsVariant.soldQuantity)
                : null,
              maxPerCustomer: fsVariant.maxPerCustomer
            };
          }
        }
      }

      const attributesObj = {};
      (variant.attributes || []).forEach(attr => {
        attributesObj[attr.k] = attr.v;
      });

      return {
        _id: variant._id,
        sku: variant.sku,
        barcode: variant.barcode || "",
        name: variant.name,
        
        attributes: variant.attributes || [],
        attributesObj,
        
        price: variant.price,
        displayPrice,
        
        thumbnail: variant.thumbnail || product.thumbnail || "",
        images: (variant.images && variant.images.length > 0) 
          ? variant.images 
          : (product.images || []),
        
        isFlashSale,
        flashSale: flashSaleInfo,
        
        isDefault: variant.isDefault || false
      };
    });

    const defaultVariant = formattedVariants.find(v => v.isDefault) 
      || formattedVariants[0];

    const prices = formattedVariants.map(v => v.displayPrice);
    const priceRange = {
      min: Math.min(...prices),
      max: Math.max(...prices)
    };

    // Related products
    const relatedProducts = await Product.find({
      categoryId: product.categoryId,
      _id: { $ne: product._id },
      isActive: true
    })
      .limit(8)
      .select("_id sku name thumbnail price categoryName brand")
      .lean();

    // Breadcrumb
    let breadcrumb = [];
    if (product.categoryId && isValidObjectId(product.categoryId)) {
      const category = await Category.findById(product.categoryId).lean();
      if (category) {
        const categoryPath = Array.isArray(category.path) ? category.path : [];
        const pathCategories = await Category.find({
          _id: { $in: categoryPath }
        })
          .sort({ level: 1 })
          .lean();

        breadcrumb = [
          { name: "Trang chủ", url: "/" },
          ...pathCategories.map(c => ({
            name: c.name,
            url: `/category/${c._id}`
          })),
          {
            name: category.name,
            url: `/category/${category._id}`
          },
          {
            name: product.name,
            url: `/product/${product._id}`
          }
        ];
      }
    }

    res.json({
      ok: true,
      product: {
        _id: product._id,
        sku: product.sku,
        name: product.name,
        brand: product.brand || "",
        categoryId: product.categoryId,
        categoryName: product.categoryName || "",
        
        thumbnail: product.thumbnail || "",
        images: product.images || [],
        
        basePrice: product.price,
        priceRange,
        
        hasVariants: true,
        totalVariants: formattedVariants.length,
        
        createdAt: product.createdAt,
        updatedAt: product.updatedAt
      },
      
      variants: formattedVariants,
      defaultVariant,
      options,
      
      relatedProducts,
      breadcrumb
    });
  })
);

// ===============================
// POST /api/public/products/:id/find-variant
// ===============================
router.post(
  "/products/:id/find-variant",
  asyncHandler(async (req, res) => {
    const productId = req.params.id;
    
    if (!isValidObjectId(productId)) {
      return res.status(400).json({ ok: false, message: "INVALID_PRODUCT_ID" });
    }

    const selectedAttributes = req.body.attributes || {};

    const variants = await ProductVariant.find({
      productId: new mongoose.Types.ObjectId(productId),
      isActive: true
    }).lean();

    const matchedVariant = variants.find(variant => {
      const variantAttrs = {};
      (variant.attributes || []).forEach(attr => {
        variantAttrs[attr.k] = attr.v;
      });

      return Object.keys(selectedAttributes).every(key => {
        return variantAttrs[key] === selectedAttributes[key];
      });
    });

    if (!matchedVariant) {
      return res.status(404).json({ 
        ok: false, 
        message: "VARIANT_NOT_FOUND_FOR_ATTRIBUTES" 
      });
    }

    // Check flash sale
    const now = new Date();
    let displayPrice = matchedVariant.price;
    let isFlashSale = false;

    if (matchedVariant.activeFlashSaleId && matchedVariant.flashSaleEndDate >= now) {
      displayPrice = matchedVariant.flashSalePrice || matchedVariant.price;
      isFlashSale = true;
    }

    res.json({
      ok: true,
      variant: {
        _id: matchedVariant._id,
        productId: matchedVariant.productId,
        sku: matchedVariant.sku,
        name: matchedVariant.name,
        attributes: matchedVariant.attributes,
        price: displayPrice,
        thumbnail: matchedVariant.thumbnail,
        isFlashSale
      }
    });
  })
);

// ===============================
// GET /api/public/categories
// ===============================
router.get(
  "/categories",
  asyncHandler(async (req, res) => {
    const parentId = req.query.parentId || null;

    const query = { isActive: true };
    
    if (parentId === "root" || parentId === null) {
      query.parentId = null;
    } else if (isValidObjectId(parentId)) {
      query.parentId = new mongoose.Types.ObjectId(parentId);
    }

    const categories = await Category.find(query)
      .sort({ order: 1, name: 1 })
      .lean();

    const categoryIds = categories.map(c => c._id);
    
    const productCounts = await Product.aggregate([
      {
        $match: {
          categoryId: { $in: categoryIds },
          isActive: true
        }
      },
      {
        $group: {
          _id: "$categoryId",
          count: { $sum: 1 }
        }
      }
    ]);

    const countMap = new Map();
    productCounts.forEach(pc => {
      countMap.set(String(pc._id), pc.count);
    });

    const items = categories.map(cat => ({
      _id: cat._id,
      code: cat.code,
      name: cat.name,
      slug: cat.slug,
      level: cat.level,
      parentId: cat.parentId,
      productCount: countMap.get(String(cat._id)) || 0
    }));

    res.json({
      ok: true,
      items,
      total: items.length
    });
  })
);

// ===============================
// GET /api/public/flash-sales
// ===============================
router.get(
  "/flash-sales",
  asyncHandler(async (req, res) => {
    const now = new Date();

    const flashSales = await FlashSale.find({
      isActive: true,
      status: "ACTIVE",
      startDate: { $lte: now },
      endDate: { $gte: now }
    })
      .sort({ priority: -1, startDate: 1 })
      .lean();

    const items = flashSales.map(fs => ({
      _id: fs._id,
      name: fs.name,
      code: fs.code,
      description: fs.description,
      startDate: fs.startDate,
      endDate: fs.endDate,
      banner: fs.banner,
      images: fs.images,
      totalProducts: fs.variants.filter(v => v.isActive).length
    }));

    res.json({
      ok: true,
      items
    });
  })
);

// ===============================
// GET /api/public/flash-sales/:id/products
// ===============================
router.get(
  "/flash-sales/:id/products",
  asyncHandler(async (req, res) => {
    const flashSaleId = req.params.id;
    
    if (!isValidObjectId(flashSaleId)) {
      return res.status(400).json({ ok: false, message: "INVALID_FLASH_SALE_ID" });
    }

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const flashSale = await FlashSale.findById(flashSaleId).lean();
    
    if (!flashSale || !flashSale.isActive) {
      return res.status(404).json({ 
        ok: false, 
        message: "FLASH_SALE_NOT_FOUND" 
      });
    }

    const variantIds = flashSale.variants
      .filter(v => v.isActive)
      .map(v => v.variantId);

    const paginatedIds = variantIds.slice(skip, skip + limit);

    const variants = await ProductVariant.find({
      _id: { $in: paginatedIds },
      isActive: true
    })
      .populate("productId", "name brand categoryName thumbnail images")
      .lean();

    const items = variants.map(variant => {
      const fsVariant = flashSale.variants.find(
        v => String(v.variantId) === String(variant._id)
      );

      const product = variant.productId;
      const discountAmount = variant.price - fsVariant.flashPrice;
      const discountPercent = variant.price > 0
        ? Math.round((discountAmount / variant.price) * 100)
        : 0;

      return {
        _id: variant._id,
        productId: product._id,
        productName: product.name,
        productBrand: product.brand,
        productCategoryName: product.categoryName,
        
        sku: variant.sku,
        name: variant.name,
        attributes: variant.attributes,
        
        originalPrice: variant.price,
        flashPrice: fsVariant.flashPrice,
        discountPercent,
        discountAmount,
        
        thumbnail: variant.thumbnail || product.thumbnail,
        images: (variant.images && variant.images.length > 0)
          ? variant.images
          : product.images,
        
        badge: fsVariant.badge,
        limitedQuantity: fsVariant.limitedQuantity,
        soldQuantity: fsVariant.soldQuantity,
        remainingQuantity: fsVariant.limitedQuantity
          ? Math.max(0, fsVariant.limitedQuantity - fsVariant.soldQuantity)
          : null
      };
    });

    res.json({
      ok: true,
      flashSale: {
        _id: flashSale._id,
        name: flashSale.name,
        code: flashSale.code,
        description: flashSale.description,
        startDate: flashSale.startDate,
        endDate: flashSale.endDate,
        banner: flashSale.banner
      },
      items,
      total: variantIds.length,
      page,
      limit,
      totalPages: Math.ceil(variantIds.length / limit)
    });
  })
);

module.exports = router;