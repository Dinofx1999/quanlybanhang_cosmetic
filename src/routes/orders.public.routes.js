// src/routes/orders.public.routes.js
const router = require("express").Router();
const { z } = require("zod");
const mongoose = require("mongoose");

const Order = require("../models/Order");
const Customer = require("../models/Customer");
const ProductVariant = require("../models/ProductVariant");
const FlashSale = require("../models/FlashSale");

const Product = require("../models/Product");

const { asyncHandler } = require("../utils/asyncHandler");
const { genOrderCode } = require("../utils/code");

function moneyInt(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x);
}

/**
 * ===============================
 * POST /api/order-public/orders - Create ONLINE order (no auth)
 * ===============================
 */
router.post(
  "/orders",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        // Customer info
        customer: z.object({
          name: z.string().min(1, "Tên không được để trống"),
          phone: z.string().regex(/^[0-9+ ]{8,15}$/, "Số điện thoại không hợp lệ"),
          email: z.string().email().optional().or(z.literal("")),
        }),

        // Delivery
        delivery: z.object({
          method: z.literal("SHIP").default("SHIP"),
          address: z.string().min(1, "Địa chỉ không được để trống"),
          receiverName: z.string().optional(),
          receiverPhone: z.string().optional(),
          note: z.string().optional(),
        }),

        // Payment
        payment: z.object({
          method: z.enum(["COD", "BANK", "WALLET"]).default("COD"),
          amount: z.number().nonnegative().default(0),
        }),

        // Items (FE đang gửi productId nhưng thực tế có lúc là variantId)
        items: z
          .array(
            z.object({
              productId: z.string(),
              qty: z.number().int().positive(),
            })
          )
          .min(1, "Giỏ hàng trống"),

        // Fees
        extraFee: z.number().nonnegative().default(0),
        discount: z.number().nonnegative().default(0),
      })
      .safeParse(req.body);

    if (!body.success) {
      return res.status(400).json({
        ok: false,
        message: "Dữ liệu không hợp lệ",
        errors: body.error.flatten(),
      });
    }

    const data = body.data;

    // ============================================================
    // ✅ RESOLVE VARIANTS:
    //    - If id matches ProductVariant._id => use it
    //    - Else treat id as Product._id and pick default variant
    // ============================================================

    const rawIds = data.items.map((it) => String(it.productId || "").trim());
    const uniqueIds = [...new Set(rawIds)];

    // Validate objectId format
    const invalidIds = uniqueIds.filter((id) => !mongoose.isValidObjectId(id));
    if (invalidIds.length) {
      return res.status(400).json({
        ok: false,
        message: "ID sản phẩm không hợp lệ",
        invalidIds,
      });
    }

    // 1) Try fetch by variantId
    let variants = await ProductVariant.find({
      _id: { $in: uniqueIds },
      isActive: true,
    })
      .select(
        "_id productId sku name price attributes isDefault activeFlashSaleId flashSalePrice flashSaleStartDate flashSaleEndDate"
      )
      .lean();

    // 2) Missing as variantId => fallback treat as productId -> pick default variant
    const foundAsVariantId = new Set(variants.map((v) => String(v._id)));
    const missingAsVariant = uniqueIds.filter((id) => !foundAsVariantId.has(id));

    if (missingAsVariant.length) {
      const fallback = await ProductVariant.find({
        productId: { $in: missingAsVariant },
        isActive: true,
      })
        .sort({ isDefault: -1, createdAt: 1 }) // ưu tiên default
        .select(
          "_id productId sku name price attributes isDefault activeFlashSaleId flashSalePrice flashSaleStartDate flashSaleEndDate"
        )
        .lean();

      // pick one per productId
      const bestByProductId = new Map();
      for (const v of fallback) {
        const pid = String(v.productId);
        if (!bestByProductId.has(pid)) bestByProductId.set(pid, v);
      }

      variants = variants.concat([...bestByProductId.values()]);
    }

    // 3) Final missing check: resolved if matches either variant._id OR variant.productId
    const resolved = new Set();
    for (const v of variants) {
      resolved.add(String(v._id));
      resolved.add(String(v.productId));
    }

    const stillMissing = uniqueIds.filter((id) => !resolved.has(id));
    if (stillMissing.length) {
      return res.status(400).json({
        ok: false,
        message: "Một số sản phẩm không tồn tại hoặc đã ngừng bán",
        missingIds: stillMissing,
      });
    }

    // ============================================================
    // ✅ Build order items with flash sale checking
    // ============================================================

    const items = [];
    let subtotal = 0;

    for (const reqItem of data.items) {
      const reqId = String(reqItem.productId || "").trim();

      // match both ways: user sent variantId OR productId
      const variant = variants.find(
        (v) => String(v._id) === reqId || String(v.productId) === reqId
      );

      if (!variant) continue;

      const qty = Math.max(1, Number(reqItem.qty));
      let price = Number(variant.price || 0);

      let flashSaleId = null;
      let isFlashSale = false;

      let originalPrice = Number(variant.price || 0); // regular
      let discountPercent = 0;
      let discountAmount = 0;

      const now = new Date();

      // ✅ Check if variant has active flash sale
      if (
        variant.activeFlashSaleId &&
        variant.flashSaleEndDate &&
        new Date(variant.flashSaleEndDate) >= now
      ) {
        const flashSale = await FlashSale.findById(variant.activeFlashSaleId).lean();

        if (flashSale && flashSale.isActive && flashSale.status === "ACTIVE") {
          const fsVariant = (flashSale.variants || []).find(
            (v) => String(v.variantId) === String(variant._id) && v.isActive
          );

          if (fsVariant) {
            // ✅ Check stock availability
            if (fsVariant.limitedQuantity !== null && fsVariant.limitedQuantity !== undefined) {
              const remaining = Number(fsVariant.limitedQuantity) - Number(fsVariant.soldQuantity || 0);
              if (remaining < qty) {
                return res.status(400).json({
                  ok: false,
                  message: `Flash sale chỉ còn ${remaining} sản phẩm "${variant.name}"`,
                  code: "FLASH_SALE_OUT_OF_STOCK",
                  remaining,
                });
              }
            }

            // ✅ Check maxPerCustomer
            if (fsVariant.maxPerCustomer && qty > Number(fsVariant.maxPerCustomer)) {
              return res.status(400).json({
                ok: false,
                message: `Chỉ được mua tối đa ${fsVariant.maxPerCustomer} sản phẩm "${variant.name}"`,
                code: "FLASH_SALE_MAX_PER_CUSTOMER_EXCEEDED",
                maxPerCustomer: fsVariant.maxPerCustomer,
              });
            }

            // ✅ Use flash price
            originalPrice = Number(variant.price || 0);
            price = Number(fsVariant.flashPrice || variant.flashSalePrice || 0);

            discountAmount = Math.max(0, originalPrice - price);
            discountPercent = originalPrice > 0 ? Math.round((discountAmount / originalPrice) * 100) : 0;

            flashSaleId = flashSale._id;
            isFlashSale = true;
          }
        }
      }

      const itemTotal = price * qty;

      items.push({
        variantId: variant._id,
        productId: variant.productId,

        sku: variant.sku || "",
        name: variant.name || "",
        attributes: variant.attributes || [],

        qty,
        price,
        total: itemTotal,

        // flash meta
        flashSaleId,
        isFlashSale,

        // breakdown
        originalPrice,
        discountPercent,
        discountAmount,
      });

      subtotal += itemTotal;
    }

    if (!items.length) {
      return res.status(400).json({
        ok: false,
        message: "Không có sản phẩm hợp lệ trong đơn hàng",
      });
    }

    // ============================================================
    // ✅ Find or create customer
    // ============================================================

    let customer = await Customer.findOne({ phone: data.customer.phone });

    if (!customer) {
      customer = await Customer.create({
        phone: data.customer.phone,
        name: data.customer.name,
        email: data.customer.email || "",
      });
    } else {
      const updates = {};
      if (data.customer.name) updates.name = data.customer.name;
      if (data.customer.email) updates.email = data.customer.email;

      if (Object.keys(updates).length) {
        await Customer.findByIdAndUpdate(customer._id, { $set: updates });
      }
    }

    // ============================================================
    // ✅ Totals
    // ============================================================

    const discount = Math.max(0, Number(data.discount || 0));
    const extraFee = Math.max(0, Number(data.extraFee || 0));
    const total = Math.max(0, subtotal - discount + extraFee);

    const totalSavings = items.reduce((sum, it) => {
      if (it.isFlashSale) return sum + it.discountAmount * it.qty;
      return sum;
    }, 0);

    // ============================================================
    // ✅ Create order
    // ============================================================

    const order = await Order.create({
      code: genOrderCode("WEB"),
      channel: "ONLINE",
      status: "PENDING",

      branchId: null,
      customerId: customer._id,

      subtotal,
      discount,
      extraFee,
      total,

      items,

      payments: data.payment.method === "COD" ? [{ method: "COD", amount: 0 }] : [],

      delivery: {
        method: "SHIP",
        address: data.delivery.address,
        receiverName: data.delivery.receiverName || data.customer.name,
        receiverPhone: data.delivery.receiverPhone || data.customer.phone,
        note: data.delivery.note || "",
      },

      stockAllocations: [],
      createdById: null,
    });

    // ============================================================
    // ✅ Response
    // ============================================================

    res.status(201).json({
      ok: true,
      message: "Đặt hàng thành công",
      order: {
        _id: order._id,
        code: order.code,
        status: order.status,
        channel: order.channel,

        subtotal: order.subtotal,
        discount: order.discount,
        extraFee: order.extraFee,
        total: order.total,

        hasFlashSaleItems: items.some((it) => it.isFlashSale),
        totalSavings,

        items: items.map((it) => ({
          variantId: it.variantId,
          productId: it.productId,
          sku: it.sku,
          name: it.name,
          qty: it.qty,
          price: it.price,
          originalPrice: it.originalPrice,
          discountPercent: it.discountPercent,
          discountAmount: it.discountAmount,
          total: it.total,
          isFlashSale: it.isFlashSale,
        })),

        customer: {
          name: data.customer.name,
          phone: data.customer.phone,
          email: data.customer.email || "",
        },

        delivery: {
          method: order.delivery.method,
          address: order.delivery.address,
          receiverName: order.delivery.receiverName,
          receiverPhone: order.delivery.receiverPhone,
          note: order.delivery.note,
        },

        createdAt: order.createdAt,
      },
    });
  })
);


/**
 * ===============================
 * GET /api/order-public/orders/:code - Get order by code (no auth)
 * ===============================
 */
router.get(
  "/orders/:code",
  asyncHandler(async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ ok: false, message: "Mã đơn hàng không hợp lệ" });
    }

    const order = await Order.findOne({ code })
      .populate("customerId", "name phone email")
      .lean();

    if (!order) {
      return res.status(404).json({ ok: false, message: "Không tìm thấy đơn hàng" });
    }

    // ✅ savings
    const totalSavings = (order.items || []).reduce((sum, it) => {
      if (it.isFlashSale && it.discountAmount) return sum + it.discountAmount * it.qty;
      return sum;
    }, 0);

    // =========================
    // ✅ ADD IMAGE TO ITEMS
    // =========================
    const items = order.items || [];

    const productIds = Array.from(
      new Set(items.map((it) => String(it.productId || "")).filter(Boolean))
    );

    const variantIds = Array.from(
      new Set(items.map((it) => String(it.variantId || "")).filter(Boolean))
    );

    // Query products + variants (only fields needed)
    const [products, variants] = await Promise.all([
      productIds.length
        ? Product.find({ _id: { $in: productIds } })
            .select("_id thumbnail images")
            .lean()
        : [],
      variantIds.length
        ? ProductVariant.find({ _id: { $in: variantIds } })
            .select("_id thumbnail images")
            .lean()
        : [],
    ]);

    const productMap = new Map(
      products.map((p) => [
        String(p._id),
        p.thumbnail || p.images?.find((x) => x?.isPrimary)?.url || p.images?.[0]?.url || null,
      ])
    );

    const variantMap = new Map(
      variants.map((v) => [
        String(v._id),
        v.thumbnail || v.images?.find((x) => x?.isPrimary)?.url || v.images?.[0]?.url || null,
      ])
    );

    const itemsWithImage = items.map((it) => {
      const vid = String(it.variantId || "");
      const pid = String(it.productId || "");
      const image = (vid && variantMap.get(vid)) || (pid && productMap.get(pid)) || null;

      return { ...it, image };
    });

    // =========================

    res.json({
      ok: true,
      order: {
        _id: order._id,
        code: order.code,
        status: order.status,
        channel: order.channel,

        subtotal: order.subtotal,
        discount: order.discount,
        extraFee: order.extraFee,
        total: order.total,

        hasFlashSaleItems: itemsWithImage.some((it) => it.isFlashSale),
        totalSavings,

        items: itemsWithImage,
        payments: order.payments || [],
        delivery: order.delivery || {},

        customer: order.customerId || {},

        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      },
    });
  })
);

/**
 * ===============================
 * GET /api/order-public/orders/track/:phone - Track orders by phone (no auth)
 * ===============================
 */
router.get(
  "/orders/track/:phone",
  asyncHandler(async (req, res) => {
    const phone = String(req.params.phone || "").trim();
    
    if (!phone || !/^[0-9+ ]{8,15}$/.test(phone)) {
      return res.status(400).json({
        ok: false,
        message: "Số điện thoại không hợp lệ",
      });
    }

    // Find customer by phone
    const customer = await Customer.findOne({ phone }).lean();
    
    if (!customer) {
      return res.json({
        ok: true,
        orders: [],
        total: 0,
        message: "Không tìm thấy đơn hàng với số điện thoại này",
      });
    }

    // Find orders by customer
    const orders = await Order.find({ 
      customerId: customer._id,
      channel: "ONLINE" 
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // Add savings info to each order
    const ordersWithSavings = orders.map(order => {
      const totalSavings = (order.items || []).reduce((sum, it) => {
        if (it.isFlashSale && it.discountAmount) {
          return sum + (it.discountAmount * it.qty);
        }
        return sum;
      }, 0);

      return {
        _id: order._id,
        code: order.code,
        status: order.status,
        total: order.total,
        hasFlashSaleItems: (order.items || []).some((it) => it.isFlashSale),
        totalSavings,
        itemCount: (order.items || []).length,
        createdAt: order.createdAt,
      };
    });

    res.json({
      ok: true,
      orders: ordersWithSavings,
      total: orders.length,
      customer: {
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
      },
    });
  })
);

module.exports = router;