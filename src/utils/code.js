const { customAlphabet } = require("nanoid");
const nanoid = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10);

function genOrderCode(prefix = "OD") {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${prefix}-${y}${m}${day}-${nanoid(6)}`;
}

function genReceiptCode(prefix = "GR") {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${prefix}-${y}${m}${day}-${nanoid(6)}`;
}

module.exports = { genOrderCode , genReceiptCode};
