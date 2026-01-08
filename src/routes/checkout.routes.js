// src/routes/checkout.routes.js
const router = require("express").Router();
const { z } = require("zod");

const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Order = require("../models/Order");

const { asyncHandler } = require("../utils/asyncHandler");
const { genOrderCode } = require("../utils/code");

/**
 * ONLINE Checkout:
 * - Tạo Order trạng thái PENDING
 * - KHÔNG trừ kho ở bước này (trừ kho khi /api/orders/:id/confirm)
 * - Vẫn lấy snapshot giá/sku/name từ DB để tránh client sửa giá
 */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        customer: z.object({
          phone: z.string().min(8),
          name: z.string().optional(),
          email: z.string().optional(),
        }),
        delivery: z
          .object({
            method: z.enum(["SHIP", "PICKUP"]).optional(),
            address: z.string().optional(),
            note: z.string().optional(),
          })
          .optional(),
        items: z
          .array(
            z.object({
              productId: z.string(),
              qty: z.number().int().positive(),
            })
          )
          .min(1),
      })
      .safeParse(req.body);

    if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });
    const data = body.data;

    const mainBranchId = String(process.env.MAIN_BRANCH_ID || "").trim();
    if (!mainBranchId) return res.status(500).json({ ok: false, message: "Missing MAIN_BRANCH_ID in .env" });

    // upsert customer by phone
    const c = await Customer.findOneAndUpdate(
      { phone: data.customer.phone },
      { $set: { name: data.customer.name || "", email: data.customer.email || "" } },
      { upsert: true, new: true }
    ).lean();

    // lấy product từ DB để snapshot sku/name/price
    const products = await Product.find({
      _id: { $in: data.items.map((i) => i.productId) },
      isActive: true,
    }).lean();

    const mapP = new Map(products.map((p) => [String(p._id), p]));

    const items = data.items.map((i) => {
      const p = mapP.get(String(i.productId));
      if (!p) {
        const err = new Error("PRODUCT_NOT_FOUND");
        err.code = "PRODUCT_NOT_FOUND";
        throw err;
      }
      return {
        productId: i.productId,
        sku: p.sku || "",
        name: p.name || "",
        qty: i.qty,
        price: Number(p.price || 0),
        total: i.qty * Number(p.price || 0),
      };
    });

    const subtotal = items.reduce((s, it) => s + it.total, 0);

    // ✅ Tạo order PENDING (KHÔNG trừ kho)
    const order = await Order.create({
      code: genOrderCode("WEB"),
      channel: "ONLINE",
      status: "PENDING",

      // ✅ Online hiển thị/báo cáo theo kho tổng
      branchId: mainBranchId,

      customerId: c._id,

      subtotal,
      discount: 0,
      total: subtotal,

      items,

      delivery: {
        method: data.delivery?.method || "SHIP",
        address: data.delivery?.address || "",
        receiverName: c.name || "",
        receiverPhone: c.phone || "",
        note: data.delivery?.note || "",
      },

      createdById: null,

      // ✅ chưa confirm => chưa trừ kho
      stockAllocations: [],
      confirmedAt: null,
      confirmedById: null,
      shippedAt: null,
      refundedAt: null,
      refundNote: "",
    });

    res.json({
      ok: true,
      orderId: order._id,
      code: order.code,
      status: order.status,
    });
  })
);

module.exports = router;
