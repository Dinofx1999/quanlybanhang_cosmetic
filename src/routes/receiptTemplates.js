const router = require("express").Router();
const bwipjs = require("bwip-js");
const QRCode = require("qrcode");
const crypto = require("crypto");

const Order = require("../models/Order");
const Branch = require("../models/Branch");
const ReceiptTemplate = require("../models/ReceiptTemplate");
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
    // ✅ FIX: schema Branch là "logo"
    logoUrl: br?.logo || process.env.STORE_LOGO_URL || "",
    taxCode: br?.taxCode || process.env.STORE_TAX_CODE || "",
  };
}

async function getCashierName(order) {
  // ✅ ưu tiên CONFIRMED trước (thu ngân xác nhận)
  const uid =
    order?.confirmedBy ||
    order?.createdById ||
    order?.createdBy ||
    order?.CreatedBy;

  if (!uid) return "";
  const u = await User.findById(uid).lean();
  return u?.name || u?.username || "";
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


function toNumberLike(n) {
  const x = Number(n || 0);
  return Number.isFinite(x) ? x : 0;
}

// Items from data.items are strings (money formatted) in your current code.
// For block renderer, we output in a simple table style, still OK as string.
function renderBlocksReceipt({ blocks, data, paper = 56 }) {
  const w = paper === 80 ? 302 : 210;

  const line = `<div style="border-top:1px dashed #999;margin:6px 0;"></div>`;

  const styleOf = (b) => {
    const fs = b.fontSize || 11;
    const fw = b.bold ? 700 : 400;
    const ta = b.align || "left";
    return `style="font-size:${fs}px;font-weight:${fw};text-align:${ta};line-height:1.25;margin:2px 0;"`;
  };

  const itemsHtml = (data?.items || [])
    .map((it) => {
      const name = escapeHtml(it?.name || "");
      const qty = escapeHtml(it?.qty);
      const price = escapeHtml(it?.price);
      const total = escapeHtml(it?.total);
      return `
        <div style="display:flex;gap:6px;">
          <div style="flex:1;min-width:0;">
            ${name}
            <div style="color:#666;font-size:10px;">${qty} x ${price}</div>
          </div>
          <div style="text-align:right;white-space:nowrap;">${total}</div>
        </div>
      `;
    })
    .join("");

  const metaHtml = `
    <div style="text-align:left;">
      <div>Mã: <b>${escapeHtml(data?.order?.orderNumber || "")}</b></div>
      <div>Giờ: ${escapeHtml(data?.order?.createdAt || "")}</div>
      ${
        data?.cashier?.name
          ? `<div>Thu ngân: ${escapeHtml(data.cashier.name)}</div>`
          : ""
      }
    </div>
  `;

  const totalsHtml = `
    <div style="text-align:left;">
      <div style="display:flex;justify-content:space-between;">
        <span>Tạm tính</span><b>${escapeHtml(data?.summary?.subtotal || "")}</b>
      </div>
      ${
        (data?.summary?.discount && data.summary.discount !== "0") ||
        (data?.summary?.discount && data.summary.discount !== "0")
          ? `<div style="display:flex;justify-content:space-between;"><span>Giảm giá</span><span>- ${escapeHtml(
              data.summary.discount
            )}</span></div>`
          : ""
      }
      ${
        data?.summary?.extraFee && data.summary.extraFee !== "0"
          ? `<div style="display:flex;justify-content:space-between;"><span>Phụ thu</span><span>+ ${escapeHtml(
              data.summary.extraFee
            )}</span></div>`
          : ""
      }
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-top:4px;">
        <span>Tổng</span><b>${escapeHtml(data?.summary?.total || "")}</b>
      </div>
    </div>
  `;

  const paymentHtml = `
    <div style="text-align:left;">
      ${
        data?.qr?.dataUrl
          ? `<div style="margin-top:6px;text-align:center;">
              <img src="${escapeHtml(data.qr.dataUrl)}" style="max-width:180px;"/>
              <div style="font-size:10px;color:#555;margin-top:2px;">QR chuyển khoản</div>
            </div>`
          : ""
      }
    </div>
  `;

  const barcodeHtml = data?.order?.barcodeDataUrl
    ? `<div style="text-align:center;margin-top:6px;">
        <img src="${escapeHtml(data.order.barcodeDataUrl)}" style="max-width:100%;height:40px;object-fit:contain;" />
      </div>`
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

      case "ITEMS_TABLE":
        return `${line}<div ${styleOf(b)}>${itemsHtml}</div>${line}${barcodeHtml}`;

      case "TOTALS":
        return `<div ${styleOf(b)}>${totalsHtml}</div>`;

      case "PAYMENT":
        return `<div ${styleOf(b)}>${paymentHtml}</div>`;

      case "FOOTER_TEXT":
      return `<div ${styleOf(b)}>${escapeHtmlWithNewline(b.text || "Cảm ơn quý khách!")}</div>`;

      default:
        return "";
    }
  };

  const body = (blocks || []).map(blockHtml).filter(Boolean).join("");

  // CSS base for 56/80mm printing
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
    const br = order.branchId || order.branch ? await Branch.findById(order.branchId || order.branch).lean() : null;

    // paper priority: branch.receipt.paperSize > query.paper > default 56
    const paperFromBranch = Number(br?.receipt?.paperSize || 0);
    const paperFromQuery = String(req.query.paper || "") === "80" ? 80 : 0;
    const paper = paperFromBranch === 80 ? 80 : paperFromQuery === 80 ? 80 : 56;

    // ✅ If branch has blocks template -> use it
    const blocks = Array.isArray(br?.receipt?.template) && br.receipt.template.length ? br.receipt.template : null;

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

    const createdAt = order.createdAt ? new Date(order.createdAt).toLocaleString("vi-VN") : "";
    const orderNumber = order.orderNumber || order.code || String(order._id).slice(-6);

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

    const subtotal =
      Number(order.subtotal ?? order.subTotal ?? 0) ||
      itemsRaw.reduce((s, it) => {
        const qty = Number(it.qty ?? it.quantity ?? 0);
        const price = Number(it.price ?? 0);
        return s + qty * price;
      }, 0);

    const discount = Number(order.discount ?? 0);
    const extraFee = Number(order.extraFee ?? 0);
    const total = Math.max(0, subtotal - discount + extraFee);

    const cashierName = await getCashierName(order);
    const barcodeText = String(orderNumber || order._id);
    const barcodeDataUrl = await makeBarcodePngDataUrl(barcodeText);

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
        createdAt,
        barcodeText,
        barcodeDataUrl,
      },
      cashier: { name: cashierName },
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
      },
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
