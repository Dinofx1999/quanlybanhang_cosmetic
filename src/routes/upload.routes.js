const router = require("express").Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { genFileName, safeExt } = require("../utils/file");

// (Nếu bạn có authRequired thì mở lại)
// const { authRequired } = require("../middlewares/auth");

// =====================
// PRODUCTS (GIỮ NGUYÊN)
// =====================
const UPLOAD_DIR = path.join(process.cwd(), "uploads", "products");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const fname = genFileName(file.originalname);
    if (!fname) return cb(new Error("INVALID_FILE_TYPE"));
    cb(null, fname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB/ảnh (tuỳ bạn)
  fileFilter: (req, file, cb) => {
    const ext = safeExt(file.originalname);
    if (!ext) return cb(new Error("INVALID_FILE_TYPE"));
    cb(null, true);
  },
});

function buildFileUrl(req, filename) {
  // server đang serve /uploads -> http://localhost:9009/uploads/...
  const base = `${req.protocol}://${req.get("host")}`;
  return `${base}/uploads/products/${filename}`;
}

// Upload 1 ảnh
router.post(
  "/product-image",
  // authRequired,
  upload.single("file"),
  (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, message: "Missing file" });

    const url = buildFileUrl(req, req.file.filename);
    res.json({
      ok: true,
      file: {
        filename: req.file.filename,
        url,
        size: req.file.size,
        mimetype: req.file.mimetype,
      },
    });
  }
);

// Upload nhiều ảnh (tối đa 8)
router.post(
  "/product-images",
  // authRequired,
  upload.array("files", 8),
  (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, message: "Missing files" });

    const items = files.map((f) => ({
      filename: f.filename,
      url: buildFileUrl(req, f.filename),
      size: f.size,
      mimetype: f.mimetype,
    }));

    res.json({ ok: true, files: items });
  }
);

// =====================
// BRANCH LOGO (THÊM MỚI)
// =====================
const BRANCH_UPLOAD_DIR = path.join(process.cwd(), "uploads", "branches");
fs.mkdirSync(BRANCH_UPLOAD_DIR, { recursive: true });

const branchStorage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, BRANCH_UPLOAD_DIR);
  },
  filename: function (_req, file, cb) {
    const fname = genFileName(file.originalname);
    if (!fname) return cb(new Error("INVALID_FILE_TYPE"));
    cb(null, fname);
  },
});

const uploadBranch = multer({
  storage: branchStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // logo nhỏ hơn: 2MB
  fileFilter: (_req, file, cb) => {
    const ext = safeExt(file.originalname);
    if (!ext) return cb(new Error("INVALID_FILE_TYPE"));
    cb(null, true);
  },
});

function buildBranchFileUrl(req, filename) {
  const base = `${req.protocol}://${req.get("host")}`;
  return `${base}/uploads/branches/${filename}`;
}

// Upload logo cửa hàng (Branch)
router.post(
  "/branch-logo",
  // authRequired,
  uploadBranch.single("file"),
  (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, message: "Missing file" });

    const url = buildBranchFileUrl(req, req.file.filename);
    res.json({
      ok: true,
      file: {
        filename: req.file.filename,
        url,
        size: req.file.size,
        mimetype: req.file.mimetype,
      },
    });
  }
);

module.exports = router;
