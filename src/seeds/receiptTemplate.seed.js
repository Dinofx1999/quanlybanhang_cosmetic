const ReceiptTemplate = require("../models/ReceiptTemplate");

const DEFAULT_HTML = `
<div class="center">
  {{#if store.logoUrl}}
    <img src="{{store.logoUrl}}" style="max-height:60px;margin:0 auto 6px;display:block"/>
  {{/if}}
  <div style="font-size:16px;font-weight:900">{{store.name}}</div>
  <div class="muted" style="font-size:11px">{{store.address}}</div>
  <div class="muted" style="font-size:11px">{{store.phone}}</div>
</div>

<div class="hr"></div>

<div style="font-size:12px">
  <div>Mã đơn: <b>{{order.orderNumber}}</b></div>
  <div>Ngày: {{order.createdAt}}</div>
  {{#if cashier.name}}<div>Thu ngân: {{cashier.name}}</div>{{/if}}
</div>

<div class="hr"></div>

<table style="width:100%;font-size:12px;border-collapse:collapse">
<thead>
<tr>
  <th style="text-align:left">SP</th>
  <th style="width:36px;text-align:center">SL</th>
  <th style="width:70px;text-align:right">Giá</th>
  <th style="width:78px;text-align:right">Tổng</th>
</tr>
</thead>
<tbody>
{{#each items}}
<tr>
  <td>{{name}}</td>
  <td style="text-align:center">{{qty}}</td>
  <td style="text-align:right">{{price}}</td>
  <td style="text-align:right"><b>{{total}}</b></td>
</tr>
{{/each}}
</tbody>
</table>

<div class="hr"></div>

<div class="row"><div>Tạm tính</div><div>{{summary.subtotal}}</div></div>
<div class="row"><div>Giảm giá</div><div>{{summary.discount}}</div></div>
<div class="row"><div>Phụ phí</div><div>{{summary.extraFee}}</div></div>
<div class="row" style="font-size:14px;font-weight:900">
  <div>TỔNG</div><div>{{summary.total}}</div>
</div>

<div class="hr"></div>

<div class="center">
  <div style="font-size:11px;font-weight:700">QR chuyển khoản</div>
  {{#if qr.dataUrl}}
    <img src="{{qr.dataUrl}}" style="width:160px;margin:6px auto;display:block"/>
  {{/if}}
</div>

<div class="hr"></div>

<div class="center">
  {{#if order.barcodeDataUrl}}
    <img src="{{order.barcodeDataUrl}}" style="width:100%;max-width:260px;margin:auto"/>
  {{/if}}
  <div class="mono" style="font-size:11px">{{order.barcodeText}}</div>
</div>

<div class="center muted" style="font-size:11px;margin-top:6px">
  Cảm ơn quý khách ❤️ dino
</div>
`;

const DEFAULT_CSS = `
.hr { border-top:1px dashed #bbb; margin:6px 0 }
.row { display:flex; justify-content:space-between }
.center { text-align:center }
.muted { color:#666 }
.mono { font-family:monospace }
`;

async function seedReceiptTemplate() {
  const exists = await ReceiptTemplate.findOne({ isDefault: true });
  if (exists) return;

  await ReceiptTemplate.create({
    name: "Bill mặc định 80mm",
    paperWidth: "80mm",
    html: DEFAULT_HTML,
    css: DEFAULT_CSS,
    isDefault: true,
    isActive: true,
  });

  console.log("✅ Seeded default receipt template");
}

module.exports = { seedReceiptTemplate };
