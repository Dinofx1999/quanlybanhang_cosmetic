// src/routes/print.routes.js
const router = require("express").Router();
const bwipjs = require("bwip-js");
const QRCode = require("qrcode");
const crypto = require("crypto");

const Order = require("../models/Order");
const Branch = require("../models/Branch");
const ReceiptTemplate = require("../models/ReceiptTemplate");
const Customer = require("../models/Customer"); // ✅ thêm để lấy điểm còn lại
const { asyncHandler } = require("../utils/asyncHandler");
const { renderReceiptHtml } = require("./receiptTemplates.engine");
const User = require("../models/User");

// ===== Helpers
const money = (n) => Number(n || 0).toLocaleString("vi-VN");

async function makeBarcodePngDataUrl(text) {
  const png = await bwipjs.toBuffer({
    bcid: "code128",
    text: String(text || ""),
    scale: 2,
    height: 10,
    includetext: false,
    textxalign: "center",
  });
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function makeQrDataUrl(payload) {
  try {
    return await QRCode.toDataURL(String(payload || ""), { margin: 1, width: 180 });
  } catch (e) {
    return "";
  }
}

function buildTransferText({ amount, note }) {
  const bank = process.env.BANK_CODE || "VCB";
  const acc = process.env.BANK_ACCOUNT || "0000000000";
  const name = process.env.BANK_NAME || "NGUYEN PHI VU";
  return `BANK:${bank} | ACC:${acc} | NAME:${name} | AMOUNT:${amount} | NOTE:${note}`;
}

async function getStoreByBranch(branchId) {
  if (!branchId) {
    return {
      name: process.env.STORE_NAME || "STORE",
      brandName: process.env.STORE_BRAND_NAME || "",
      address: process.env.STORE_ADDRESS || "",
      phone: process.env.STORE_PHONE || "",
      logoUrl: process.env.STORE_LOGO_URL || "",
      taxCode: process.env.STORE_TAX_CODE || "",
    };
  }

  const br = await Branch.findById(branchId).lean();

  return {
    name: br?.name || process.env.STORE_NAME || "STORE",
    brandName: br?.brandName || process.env.STORE_BRAND_NAME || "",
    address: br?.address || process.env.STORE_ADDRESS || "",
    phone: br?.phone || process.env.STORE_PHONE || "",
    logoUrl: br?.logo || process.env.STORE_LOGO_URL || "",
    taxCode: br?.taxCode || process.env.STORE_TAX_CODE || "",
  };
}

async function getCashierName(order) {
  const uid =
    order?.confirmedBy ||
    order?.confirmedById ||
    order?.createdById ||
    order?.createdBy ||
    order?.CreatedBy;

  if (!uid) return "";
  const u = await User.findById(uid).lean();
  return u?.name || u?.username || "";
}

function getPaymentMethodLabel(method) {
  const m = String(method || "").toUpperCase();
  if (m === "CASH") return "Tiền mặt";
  if (m === "BANK") return "Chuyển khoản";
  if (m === "CARD") return "Thẻ";
  if (m === "WALLET") return "Ví điện tử";
  if (m === "COD") return "COD";
  return m || "Khác";
}

// ✅ NEW: lấy điểm tích luỹ còn lại (ưu tiên customerId, fallback theo phone)
async function getCustomerPointsBalance(order) {
  const cid =
    order?.customerId ||
    order?.customer ||
    order?.customer_id ||
    order?.customerID;

  if (cid) {
    try {
      const c = await Customer.findById(cid).select("points name phone").lean();
      return { points: Number(c?.points || 0), customer: c || null };
    } catch (e) {}
  }

  const phone = order?.delivery?.receiverPhone;
  if (phone) {
    try {
      const c = await Customer.findOne({ phone: String(phone).trim() })
        .select("points name phone")
        .lean();
      return { points: Number(c?.points || 0), customer: c || null };
    } catch (e) {}
  }

  return { points: 0, customer: null };
}

// ==========================
// Render BLOCK template -> HTML (56/80mm)
// ==========================
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeHtmlWithNewline(s) {
  return escapeHtml(s).replace(/\n/g, "<br/>");
}

function renderBlocksReceipt({ blocks, data, paper = 56 }) {
  const w = paper === 80 ? 302 : 210;

  const line = `<div style="border-top:1px dashed #999;margin:6px 0;"></div>`;

  const styleOf = (b) => {
    const fs = b.fontSize || 11;
    const fw = b.bold ? 700 : 400;
    const ta = b.align || "left";
    return `style="font-size:${fs}px;font-weight:${fw};text-align:${ta};line-height:1.25;margin:2px 0;"`;
  };

  //Format items table
  const item_format = (item) => {
    if(item === "CONFIRM") return "Hoàn Tất";
    if(item === "CANCEL") return "Hủy Đơn";
    if(item === "DEBT ") return "Đơn Nợ";
    if(item === "PENDING") return "Đơn Tạm";
  }

  // ✅ Items table
  const itemsHtml = (data?.items || [])
    .map((it) => {
      const name = escapeHtml(it?.name || "");
      const qty = escapeHtml(it?.qty);
      const price = escapeHtml(it?.price);
      const total = escapeHtml(it?.total);
      return `
        <div style="display:flex;gap:6px;margin:3px 0;">
          <div style="flex:1;min-width:0;">
            ${name}
            <div style="color:#666;font-size:10px;">${qty} x ${price}</div>
          </div>
          <div style="text-align:right;white-space:nowrap;font-weight:600;">${total}</div>
        </div>
      `;
    })
    .join("");

  // ✅ Order meta
  const metaHtml = `
    <div style="text-align:left;font-size:11px;">
      <div>Mã đơn: <b>${escapeHtml(data?.order?.orderNumber || "")}</b></div>
      <div>Thời gian: ${escapeHtml(data?.order?.createdAt || "")}</div>
      ${
        data?.cashier?.name
          ? `<div>Thu ngân: <b>${escapeHtml(data.cashier.name)}</b></div>`
          : ""
      }
      ${
        data?.order?.status
          ? `<div>Trạng thái: <b>${item_format(escapeHtml(data.order.status))}</b></div>`
          : ""
      }
    </div>
  `;

  // ✅ Customer info
  const customerHtml = data?.customer
    ? `
      <div style="text-align:left;font-size:11px;">
        <div style="font-weight:600;margin-bottom:3px;">THÔNG TIN KHÁCH HÀNG</div>
        ${
          data.customer
            ? `<div>Tên: <b>${escapeHtml(data.customer.name) || "Khách Lẻ"}</b></div>`
            : ""
        }
        ${
          data.customer.phone
            ? `<div>SĐT: <b>${escapeHtml(data.customer.phone)}</b></div>`
            : ""
        }
        ${
          data.customer.address
            ? `<div>Địa chỉ: ${escapeHtml(data.customer.address)}</div>`
            : ""
        }
      </div>
    `
    : "";

  // ✅ Loyalty info (NEW: thêm pointsBalance)
  const loyaltyHtml =
    data?.loyalty?.pointsEarned && data?.customer?.name ||
    data?.loyalty?.pointsRedeemed && data?.customer?.name ||
    data?.loyalty?.pointsBalance != null && data?.customer?.name 
      ? `
      <div style="text-align:left;font-size:11px;">
        <div style="font-weight:600;margin-bottom:3px;">TÍCH ĐIỂM & ƯU ĐÃI</div>
        ${
          data.loyalty.pointsRedeemed && data.loyalty.pointsRedeemed > 0 
            ? `<div>Đã dùng: <b>-${money(data.loyalty.pointsRedeemed)} điểm</b> (Giảm ${money(data.loyalty.redeemAmount)}đ)</div>`
            : ""
        }
        ${
          data.loyalty.pointsEarned && data.loyalty.pointsEarned > 0
            ? `<div>Tích lũy: <b>+${money(data.loyalty.pointsEarned)} điểm</b></div>`
            : ""
        }
        ${
          data.loyalty.pointsBalance != null
            ? `<div>Còn lại: <b>${money(data.loyalty.pointsBalance)} điểm</b></div>`
            : ""
        }
      </div>
    `
      : "";

  // ✅ Totals with redeem
  const totalsHtml = `
    <div style="text-align:left;font-size:11px;">
      <div style="display:flex;justify-content:space-between;margin:2px 0;">
        <span>Tạm tính</span><b>${escapeHtml(data?.summary?.subtotal || "")}</b>
      </div>
      ${
        data?.summary?.discount && data.summary.discount !== "0"
          ? `<div style="display:flex;justify-content:space-between;margin:2px 0;">
              <span>Giảm giá</span><span style="color:#d32f2f;">- ${escapeHtml(data.summary.discount)}</span>
            </div>`
          : ""
      }
      ${
        data?.loyalty?.redeemAmount && data.loyalty.redeemAmount > 0
          ? `<div style="display:flex;justify-content:space-between;margin:2px 0;">
              <span>Trừ điểm</span><span style="color:#9c27b0;">- ${money(data.loyalty.redeemAmount)}</span>
            </div>`
          : ""
      }
      ${
        data?.summary?.extraFee && data.summary.extraFee !== "0"
          ? `<div style="display:flex;justify-content:space-between;margin:2px 0;">
              <span>Phụ thu</span><span style="color:#388e3c;">+ ${escapeHtml(data.summary.extraFee)}</span>
            </div>`
          : ""
      }
      ${
        data?.summary?.pricingNote
          ? `<div style="font-size:10px;color:#666;font-style:italic;margin:2px 0;">Ghi chú: ${escapeHtml(data.summary.pricingNote)}</div>`
          : ""
      }
      <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;margin-top:6px;padding-top:4px;border-top:1px solid #333;">
        <span>TỔNG CỘNG</span><span>${escapeHtml(data?.summary?.total || "")}</span>
      </div>
    </div>
  `;

  // ✅ Payments info
  const paymentsHtml = data?.payments && data.payments.length > 0
    ? `
      <div style="text-align:left;font-size:11px;">
        <div style="font-weight:600;margin-bottom:3px;">THANH TOÁN</div>
        ${data.payments
          .map(
            (p) => `
          <div style="display:flex;justify-content:space-between;margin:2px 0;">
            <span>${escapeHtml(p.method)}</span><b>${escapeHtml(p.amount)}</b>
          </div>
        `
          )
          .join("")}
        <div style="display:flex;justify-content:space-between;font-weight:600;margin-top:4px;padding-top:4px;border-top:1px dashed #999;">
          <span>Đã trả</span><span style="color:#388e3c;">${escapeHtml(data.summary.paid || "0")}</span>
        </div>
        ${
          data?.summary?.due && Number(String(data.summary.due).replace(/\D/g, "")) > 0
            ? `<div style="display:flex;justify-content:space-between;font-weight:600;margin-top:2px;">
                <span>Còn thiếu</span><span style="color:#d32f2f;">${escapeHtml(data.summary.due)}</span>
              </div>`
            : ""
        }
      </div>
    `
    : "";

  // ✅ QR payment
  const qrHtml = data?.qr?.dataUrl
    ? `
      <div style="margin-top:8px;text-align:center;">
        <img src="${escapeHtml(data.qr.dataUrl)}" style="max-width:180px;"/>
        <div style="font-size:10px;color:#555;margin-top:2px;">Quét mã QR để chuyển khoản</div>
      </div>
    `
    : "";

  // ✅ Barcode
  const barcodeHtml = data?.order?.barcodeDataUrl
    ? `
      <div style="text-align:center;margin-top:8px;">
        <img src="${escapeHtml(data.order.barcodeDataUrl)}" style="max-width:100%;height:40px;object-fit:contain;" />
      </div>
    `
    : "";

  const blockHtml = (b) => {
    if (!b || b.enabled === false) return "";

    switch (b.type) {
      case "LOGO":
        return data?.store?.logoUrl
          ? `<div ${styleOf(b)}><img src="${escapeHtml(
              data.store.logoUrl
            )}" style="max-height:52px;max-width:100%;object-fit:contain;" /></div>`
          : "";

      case "BRAND_NAME":
        return `<div ${styleOf(b)}>${escapeHtml(data?.store?.brandName || data?.store?.name || "")}</div>`;

      case "SHOP_NAME":
        return `<div ${styleOf(b)}>${escapeHtml(data?.store?.name || "")}</div>`;

      case "ADDRESS":
        return `<div ${styleOf(b)}>${escapeHtml(data?.store?.address || "")}</div>`;

      case "PHONE":
        return `<div ${styleOf(b)}>ĐT: ${escapeHtml(data?.store?.phone || "")}</div>`;

      case "TAX_CODE":
        return data?.store?.taxCode
          ? `<div ${styleOf(b)}>MST: ${escapeHtml(data.store.taxCode)}</div>`
          : "";

      case "ORDER_META":
        return `<div ${styleOf(b)}>${metaHtml}</div>`;

      case "CUSTOMER_INFO":
        return customerHtml ? `${line}<div ${styleOf(b)}>${customerHtml}</div>` : "";

      case "LOYALTY_INFO":
        return loyaltyHtml ? `<div ${styleOf(b)}>${loyaltyHtml}</div>` : "";

      case "ITEMS_TABLE":
        return `${line}<div ${styleOf(b)}>${itemsHtml}</div>${line}`;

      case "TOTALS":
        return `<div ${styleOf(b)}>${totalsHtml}</div>`;

      case "PAYMENTS_INFO":
        return paymentsHtml ? `${line}<div ${styleOf(b)}>${paymentsHtml}</div>` : "";

      case "BARCODE":
        return barcodeHtml;

      case "QR_PAYMENT":
        return qrHtml;

      case "FOOTER_TEXT":
        return `${line}<div ${styleOf(b)}>${escapeHtmlWithNewline(
          b.text || "Cảm ơn quý khách!"
        )}</div>`;

      default:
        return "";
    }
  };

  const body = (blocks || []).map(blockHtml).filter(Boolean).join("");

  const css = `
    @page { size: ${paper}mm auto; margin: 6mm; }
    html, body { padding:0; margin:0; }
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; color:#111; }
    img { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  `;

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Receipt</title>
        <style>${css}</style>
      </head>
      <body>
        <div style="width:${w}px; margin:0 auto; padding:6px;">
          ${body}
        </div>
      </body>
    </html>
  `;
}

/**
 * GET /print/receipt/:orderId
 * Query params:
 * - templateId (optional): ID của template (html/css)
 * - autoPrint hoặc autoprint: "1" hoặc "true" để tự động in
 * - paper: "80" cho khổ 80mm (optional) (ưu tiên branch.receipt.paperSize)
 */
router.get(
  "/receipt/:orderId",
  asyncHandler(async (req, res) => {
    const { orderId } = req.params;

    const templateId = req.query.templateId ? String(req.query.templateId) : "";
    const autoPrintParam = req.query.autoPrint || req.query.autoprint;
    const autoPrint = autoPrintParam === "1" || autoPrintParam === "true";

    console.log(`🖨️ [Print Receipt] OrderID: ${orderId} | Auto print: ${autoPrint}`);

    const nonce = crypto.randomBytes(16).toString("base64");

    const order = await Order.findById(orderId).lean();
    if (!order) {
      console.error(`❌ Order not found: ${orderId}`);
      return res.status(404).send("Order not found");
    }

    // Load branch to detect block-template + paperSize
    const br =
      order.branchId || order.branch
        ? await Branch.findById(order.branchId || order.branch).lean()
        : null;

    // paper priority: branch.receipt.paperSize > query.paper > default 56
    const paperFromBranch = Number(br?.receipt?.paperSize || 0);
    const paperFromQuery = String(req.query.paper || "") === "80" ? 80 : 0;
    const paper = paperFromBranch === 80 ? 80 : paperFromQuery === 80 ? 80 : 56;

    // ✅ If branch has blocks template -> use it
    const blocks =
      Array.isArray(br?.receipt?.template) && br.receipt.template.length
        ? br.receipt.template
        : null;

    // fallback html/css template flow (old)
    let tpl = null;
    if (!blocks) {
      if (templateId) {
        tpl = await ReceiptTemplate.findById(templateId).lean();
        console.log(`📄 Using template ID: ${templateId}`);
      }
      if (!tpl) {
        tpl = await ReceiptTemplate.findOne({ isActive: true, isDefault: true }).lean();
        console.log(`📄 Using default template`);
      }
      if (!tpl) {
        console.error(`❌ No receipt template found`);
        return res.status(500).send("No receipt template. Create a template first.");
      }
    } else {
      console.log(`🧩 Using Branch receipt.template blocks (${blocks.length})`);
    }

    const store = await getStoreByBranch(order.branchId || order.branch || null);

    const createdAt = order.createdAt
      ? new Date(order.createdAt).toLocaleString("vi-VN")
      : "";
    const orderNumber = order.orderNumber || order.code || String(order._id).slice(-6);
    const orderStatus = String(order.status || "").toUpperCase();

    // ✅ Items
    const itemsRaw = Array.isArray(order.items) ? order.items : [];
    const items = itemsRaw.map((it) => {
      const name = it.name || it.productName || "Sản phẩm";
      const qty = Number(it.qty ?? it.quantity ?? 0);
      const price = Number(it.price ?? 0);
      const total = Number(it.total ?? qty * price);
      return {
        name,
        qty,
        price: money(price),
        total: money(total),
      };
    });

    // ✅ Summary
    const subtotal =
      Number(order.subtotal ?? order.subTotal ?? 0) ||
      itemsRaw.reduce((s, it) => {
        const qty = Number(it.qty ?? it.quantity ?? 0);
        const price = Number(it.price ?? 0);
        return s + qty * price;
      }, 0);

    const discount = Number(order.discount ?? 0);
    const extraFee = Number(order.extraFee ?? 0);
    const pointsRedeemAmount = Number(order.pointsRedeemAmount ?? 0);
    const total = Math.max(0, subtotal - discount - pointsRedeemAmount + extraFee);
    const pricingNote = order.pricingNote || "";

    // ✅ Payments
    const paymentsRaw = Array.isArray(order.payments) ? order.payments : [];
    const payments = paymentsRaw.map((p) => ({
      method: getPaymentMethodLabel(p.method),
      amount: money(p.amount || 0),
    }));

    const paid = paymentsRaw.reduce((s, p) => s + Number(p.amount || 0), 0);
    const due = Math.max(0, total - paid);

    // ✅ Loyalty (order fields)
    const pointsEarned = Number(order.pointsEarned ?? 0);
    const pointsRedeemed = Number(order.pointsRedeemed ?? 0);

    // ✅ NEW: lấy điểm còn lại từ Customer
    const { points: pointsBalance, customer: customerDoc } = await getCustomerPointsBalance(order);

    // ✅ Customer (ưu tiên order, fallback customerDoc)
    const customerName = order.delivery?.receiverName || customerDoc?.name || "";
    const customerPhone = order.delivery?.receiverPhone || customerDoc?.phone || "";
    const customerAddress = order.delivery?.address || "";

    // ✅ Cashier
    const cashierName = await getCashierName(order);

    // ✅ Barcode
    const barcodeText = String(orderNumber || order._id);
    const barcodeDataUrl = await makeBarcodePngDataUrl(barcodeText);

    // ✅ QR
    const transferText = buildTransferText({
      amount: total,
      note: `TT ${orderNumber}`,
    });
    const qrDataUrl = await makeQrDataUrl(transferText);

    const data = {
      store: {
        name: store.name,
        brandName: store.brandName,
        address: store.address,
        phone: store.phone,
        logoUrl: store.logoUrl,
        taxCode: store.taxCode,
      },
      order: {
        _id: String(order._id),
        orderNumber,
        status: orderStatus,
        createdAt,
        barcodeText,
        barcodeDataUrl,
      },
      cashier: { name: cashierName },
      customer: {
        name: customerName,
        phone: customerPhone,
        address: customerAddress,
      },
      loyalty: {
        pointsEarned,
        pointsRedeemed,
        redeemAmount: pointsRedeemAmount,
        pointsBalance, // ✅ hiển thị "Còn lại"
      },
      items: items.map((x) => ({
        name: x.name,
        qty: x.qty,
        price: x.price,
        total: x.total,
      })),
      summary: {
        subtotal: money(subtotal),
        discount: money(discount),
        extraFee: money(extraFee),
        total: money(total),
        paid: money(paid),
        due: money(due),
        pricingNote,
      },
      payments,
      qr: {
        text: transferText,
        dataUrl: qrDataUrl,
      },
    };

    let html = "";

    // ✅ NEW: blocks template
    if (blocks) {
      html = renderBlocksReceipt({ blocks, data, paper });
    } else {
      // OLD: html/css template
      html = renderReceiptHtml({ html: tpl.html, css: tpl.css, data });
    }

    // ✅ Inject auto print script with nonce
    if (autoPrint) {
      console.log(`🖨️ Injecting auto print script with nonce`);

      const autoScript = `
      <script nonce="${nonce}">
        console.log('🖨️ Auto print script loaded');
        function triggerPrint() {
          try {
            console.log('🖨️ Triggering window.print()...');
            window.print();
            console.log('✅ Print dialog opened');
          } catch (e) {
            console.error('❌ Print error:', e);
            alert('Không thể tự động in. Vui lòng bấm Ctrl+P để in.');
          }
        }
        if (document.readyState === 'complete') {
          setTimeout(triggerPrint, 800);
        } else {
          window.addEventListener('load', function() {
            setTimeout(triggerPrint, 800);
          });
        }
      </script>
      `;

      if (html.includes("</body>")) {
        html = html.replace("</body>", `${autoScript}</body>`);
      } else {
        html += autoScript;
      }
    }

    // ✅ CSP allow nonce script + inline css + images
    res.setHeader(
      "Content-Security-Policy",
      `script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:;`
    );

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);

    console.log(`✅ [Print Receipt] Sent HTML for order ${orderNumber}`);
  })
);

module.exports = router;
