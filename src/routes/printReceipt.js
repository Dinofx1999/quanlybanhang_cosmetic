const router = require("express").Router();
const bwipjs = require("bwip-js");
const QRCode = require("qrcode");
const crypto = require("crypto"); // ✅ Thêm crypto

const Order = require("../models/Order");
const Branch = require("../models/Branch");
const ReceiptTemplate = require("../models/ReceiptTemplate");
const { asyncHandler } = require("../utils/asyncHandler");
const { renderReceiptHtml } = require("./receiptTemplates");
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
      address: process.env.STORE_ADDRESS || "",
      phone: process.env.STORE_PHONE || "",
      logoUrl: process.env.STORE_LOGO_URL || "",
    };
  }
  const br = await Branch.findById(branchId).lean();
  return {
    name: br?.name || process.env.STORE_NAME || "STORE",
    address: br?.address || process.env.STORE_ADDRESS || "",
    phone: br?.phone || process.env.STORE_PHONE || "",
    logoUrl: br?.logoUrl || process.env.STORE_LOGO_URL || "",
  };
}

async function getCashierName(order) {
  const uid = order?.createdBy || order?.CreatedBy || order?.confirmedBy || order?.ConfirmedBy;
  if (!uid) return "";
  const u = await User.findById(uid).lean();
  return u?.name || u?.username || "";
}

/**
 * GET /print/receipt/:orderId
 * Query params:
 * - templateId (optional): ID của template
 * - autoPrint hoặc autoprint: "1" hoặc "true" để tự động in
 * - paper: "80" cho khổ 80mm (optional)
 */
router.get("/receipt/:orderId", asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  
  const templateId = req.query.templateId ? String(req.query.templateId) : "";
  const autoPrintParam = req.query.autoPrint || req.query.autoprint;
  const autoPrint = autoPrintParam === "1" || autoPrintParam === "true";
  
  console.log(`🖨️ [Print Receipt] OrderID: ${orderId} | Auto print: ${autoPrint}`);

  // ✅ Generate nonce cho CSP
  const nonce = crypto.randomBytes(16).toString("base64");

  const order = await Order.findById(orderId).lean();
  if (!order) {
    console.error(`❌ Order not found: ${orderId}`);
    return res.status(404).send("Order not found");
  }

  let tpl = null;
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

  const store = await getStoreByBranch(order.branchId || order.branch || null);
  const createdAt = order.createdAt ? new Date(order.createdAt).toLocaleString("vi-VN") : "";
  const orderNumber = order.orderNumber || order.code || String(order._id).slice(-6);

  const itemsRaw = Array.isArray(order.items) ? order.items : [];
  const items = itemsRaw.map((it) => {
    const name = it.name || it.productName || "Sản phẩm";
    const qty = Number(it.qty ?? it.quantity ?? 0);
    const price = Number(it.price ?? 0);
    const total = Number(it.total ?? (qty * price));
    return {
      name,
      qty,
      price: money(price),
      total: money(total),
    };
  });

  const subtotal = Number(order.subtotal ?? order.subTotal ?? 0) || itemsRaw.reduce((s, it) => {
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
      address: store.address,
      phone: store.phone,
      logoUrl: store.logoUrl,
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

  let html = renderReceiptHtml({ html: tpl.html, css: tpl.css, data });

  // ✅ Inject auto print script với nonce
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
    
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${autoScript}</body>`);
    } else {
      html += autoScript;
    }
  }

  // ✅ Set CSP header với nonce
  res.setHeader(
    "Content-Security-Policy",
    `script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;`
  );
  
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
  
  console.log(`✅ [Print Receipt] Sent HTML for order ${orderNumber}`);
}));
//OK
module.exports = router;