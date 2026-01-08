function notFound(_req, res) {
  res.status(404).json({ ok: false, message: "Not Found" });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  const msg = err?.message || "Server Error";

  // Mongo duplicate key
  if (err?.code === 11000) {
    return res.status(409).json({ ok: false, message: "Duplicate key", key: err.keyValue });
  }

  // Custom errors
  if (err?.code === "PRODUCT_NOT_FOUND") {
    return res.status(400).json({ ok: false, message: "Product not found" });
  }

  console.error("[ERROR]", err);
  res.status(500).json({ ok: false, message: msg });
}

module.exports = { notFound, errorHandler };
