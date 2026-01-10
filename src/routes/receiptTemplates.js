const router = require("express").Router();
const { z } = require("zod");
const Handlebars = require("handlebars");
const sanitizeHtml = require("sanitize-html");

const ReceiptTemplate = require("../models/ReceiptTemplate");
const { asyncHandler } = require("../utils/asyncHandler");

// nếu bạn có authRequired thì mở ra
// const { authRequired } = require("../middlewares/authRequired");

function pickUserId(req) {
  const id = req.user?.sub || req.user?.id || req.user?._id || null;
  return id ? String(id) : null;
}

/**
 * ✅ Chặn script/iframe + chặn toàn bộ on* handlers.
 * Note: sanitize-html đã remove attributes không nằm trong allowedAttributes,
 * nhưng để chắc chắn, ta filter thêm.
 */
function sanitizeTemplateHtml(html) {
  const cleaned = sanitizeHtml(String(html || ""), {
    allowedTags: [
      "div", "span", "b", "strong", "i", "u", "small", "br", "hr",
      "table", "thead", "tbody", "tr", "td", "th",
      "img", "svg", "path",
      "h1", "h2", "h3", "h4", "h5", "h6",
      "p"
    ],
    allowedAttributes: {
      "*": ["class", "style"],
      img: ["src", "alt", "width", "height"],
      svg: ["xmlns", "width", "height", "viewBox"],
      path: ["d", "fill"]
    },
    allowedSchemes: ["data", "http", "https"],
    disallowedTagsMode: "discard",
    allowVulnerableTags: false,
  });

  // ✅ hard strip any on* attributes if slipped
  return cleaned.replace(/\son\w+\s*=\s*(['"]).*?\1/gi, "");
}

/**
 * ✅ CSS: bạn có thể giữ nguyên, nhưng nên tránh user đưa @import hoặc url(javascript:...)
 * Minimal filter:
 */
function sanitizeTemplateCss(css) {
  const s = String(css || "");
  // chặn @import
  const noImport = s.replace(/@import\s+[^;]+;/gi, "");
  // chặn url(javascript:...)
  const noJsUrl = noImport.replace(/url\(\s*['"]?\s*javascript:[^)]+\)/gi, "url()");
  return noJsUrl;
}

// payload mẫu để preview (FE gọi cũng được)
function buildSampleData() {
  return {
    store: {
      name: "Bảo Ân Cosmetics",
      address: "Tam Kỳ, Quảng Nam",
      phone: "0909 123 456",
      logoUrl: "",
    },
    order: {
      _id: "695d03fbb3424862896c2979",
      orderNumber: "HD-000123",
      createdAt: new Date().toLocaleString("vi-VN"),
      barcodeText: "HD-000123",
    },
    cashier: { name: "Nguyễn Phi Vũ" },
    items: [
      { name: "Son Hông Hồng", qty: 2, price: 120000, total: 240000 },
      { name: "Sữa rửa mặt", qty: 1, price: 89000, total: 89000 },
    ],
    summary: {
      subtotal: 329000,
      discount: 0,
      extraFee: 0,
      total: 329000,
    },
    qr: {
      dataUrl: "",
      text: "CK: 0909123456 - HD-000123",
    },
  };
}

/**
 * ✅ Render HTML: tách rõ paperWidth + autoPrint + autoClose
 */
function renderReceiptHtml({ html, css, data, autoPrint = false }) {
  const cleanHtml = sanitizeTemplateHtml(html);
  const cleanCss = sanitizeTemplateCss(css);

  const tpl = Handlebars.compile(cleanHtml, { noEscape: true });
  const body = tpl(data);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Receipt</title>
  <style>
    @page { size: 80mm auto; margin: 4mm; }
    html, body { width: 80mm; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; }
    img { max-width: 100%; }
    ${cleanCss || ""}
  </style>
</head>
<body>
  ${body}

  <script>
  (function(){
    const AUTO = true; // render server
    if (!AUTO) return;

    function doPrint(){
      try { window.focus(); } catch(e){}
      try { window.print(); } catch(e){}
      setTimeout(() => { try { window.close(); } catch(e){} }, 800);
    }

    // ✅ Chrome: gọi ngay khi DOM ready + fallback load
    if (document.readyState === "complete") {
      setTimeout(doPrint, 50);
    } else {
      window.addEventListener("load", () => setTimeout(doPrint, 50));
    }
  })();
</script>

</body>
</html>`;
}


// ===============================
// GET list
// ===============================
// router.get("/receipt-templates", authRequired, asyncHandler(async (req,res) => {
router.get("/receipt-templates", asyncHandler(async (req, res) => {
  const items = await ReceiptTemplate.find({ isActive: true })
    .sort({ isDefault: -1, updatedAt: -1 })
    .lean();
  res.json({ ok: true, items });
}));

// GET one
router.get("/receipt-templates/:id", asyncHandler(async (req, res) => {
  const t = await ReceiptTemplate.findById(req.params.id).lean();
  if (!t) return res.status(404).json({ ok: false, message: "Template không tồn tại" });
  res.json({ ok: true, template: t });
}));

// GET default
router.get("/receipt-templates-default", asyncHandler(async (req, res) => {
  const t = await ReceiptTemplate.findOne({ isActive: true, isDefault: true }).lean();
  res.json({ ok: true, template: t || null });
}));

// CREATE
router.post("/receipt-templates", asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(1),
    paperWidth: z.enum(["80mm", "58mm"]).optional(),
    html: z.string().min(1),
    css: z.string().optional(),
    isDefault: z.boolean().optional(),
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  const uid = pickUserId(req);

  const doc = await ReceiptTemplate.create({
    name: body.data.name,
    paperWidth: body.data.paperWidth || "80mm",
    html: body.data.html,
    css: body.data.css || "",
    isDefault: !!body.data.isDefault,
    createdBy: uid,
    updatedBy: uid,
  });

  if (doc.isDefault) {
    await ReceiptTemplate.updateMany({ _id: { $ne: doc._id } }, { $set: { isDefault: false } });
  }

  res.json({ ok: true, template: doc });
}));

// UPDATE
router.put("/receipt-templates/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(1).optional(),
    html: z.string().min(1).optional(),
    css: z.string().optional(),
    paperWidth: z.enum(["80mm", "58mm"]).optional(),
    isActive: z.boolean().optional(),
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  const uid = pickUserId(req);

  const t = await ReceiptTemplate.findById(req.params.id);
  if (!t) return res.status(404).json({ ok: false, message: "Template không tồn tại" });

  if (body.data.name !== undefined) t.name = body.data.name;
  if (body.data.html !== undefined) t.html = body.data.html;
  if (body.data.css !== undefined) t.css = body.data.css;
  if (body.data.paperWidth !== undefined) t.paperWidth = body.data.paperWidth;
  if (body.data.isActive !== undefined) t.isActive = body.data.isActive;

  t.updatedBy = uid;
  await t.save();

  res.json({ ok: true, template: t });
}));

// SET DEFAULT
router.post("/receipt-templates/:id/set-default", asyncHandler(async (req, res) => {
  const t = await ReceiptTemplate.findById(req.params.id);
  if (!t) return res.status(404).json({ ok: false, message: "Template không tồn tại" });

  await ReceiptTemplate.updateMany({}, { $set: { isDefault: false } });
  t.isDefault = true;
  await t.save();

  res.json({ ok: true });
}));

// PREVIEW (FE đưa html/css lên để preview nhanh) ✅ KHÔNG auto print
router.post("/receipt-templates/preview", asyncHandler(async (req, res) => {
  const body = z.object({
    html: z.string().min(1),
    css: z.string().optional(),
    data: z.any().optional(),
    paper: z.enum(["80mm", "58mm"]).optional(),
  }).safeParse(req.body);

  if (!body.success) return res.status(400).json({ ok: false, error: body.error.flatten() });

  const data = body.data.data || buildSampleData();
  const out = renderReceiptHtml({
    html: body.data.html,
    css: body.data.css || "",
    data,
    paper: body.data.paper || "80mm",
    autoPrint: false,
    autoClose: false,
  });

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(out);
}));

module.exports = { router, renderReceiptHtml, buildSampleData };
