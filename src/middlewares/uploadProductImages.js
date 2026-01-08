const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { safeExt, genFileName } = require("../utils/file");

const UPLOAD_DIR = path.join(process.cwd(), "uploads", "products");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (_req, file, cb) {
    const fname = genFileName(file.originalname);
    if (!fname) return cb(new Error("INVALID_FILE_TYPE"));
    cb(null, fname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB/ảnh
  fileFilter: (_req, file, cb) => {
    const ext = safeExt(file.originalname);
    if (!ext) return cb(new Error("INVALID_FILE_TYPE"));
    cb(null, true);
  },
});

function getFilenameFromUrl(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname || ""; // /uploads/products/xxx.jpg
    const parts = pathname.split("/");
    return parts[parts.length - 1] || "";
  } catch {
    // trường hợp url không phải absolute (ví dụ /uploads/products/xxx.jpg)
    const parts = String(url || "").split("/");
    return parts[parts.length - 1] || "";
  }
}

function buildFileUrl(req, filename) {
  const base = `${req.protocol}://${req.get("host")}`;
  return `${base}/uploads/products/${filename}`;
}

module.exports = { upload, buildFileUrl, UPLOAD_DIR ,getFilenameFromUrl };
