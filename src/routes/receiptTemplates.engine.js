// src/routes/receiptTemplates.engine.js
function getByPath(obj, path) {
  if (!path) return "";
  return String(path)
    .split(".")
    .reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : ""), obj);
}

/**
 * Fallback renderer cho ReceiptTemplate (html/css) dạng {{a.b.c}}
 * - Dùng khi branch không có receipt.template blocks
 */
function renderReceiptHtml({ html = "", css = "", data = {} }) {
  const compiled = String(html || "").replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, p) => {
    const v = getByPath(data, p);
    return v === undefined || v === null ? "" : String(v);
  });

  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Receipt</title>
      <style>${css || ""}</style>
    </head>
    <body>${compiled}</body>
  </html>`;
}

module.exports = { renderReceiptHtml };
