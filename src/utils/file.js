const path = require("path");
const crypto = require("crypto");

function safeExt(originalName = "") {
  const ext = path.extname(originalName || "").toLowerCase();
  const ok = [".jpg", ".jpeg", ".png", ".webp"];
  return ok.includes(ext) ? ext : "";
}

function genFileName(originalName) {
  const ext = safeExt(originalName);
  if (!ext) return null;
  const id = crypto.randomBytes(12).toString("hex");
  return `${Date.now()}-${id}${ext}`;
}

module.exports = { safeExt, genFileName };
