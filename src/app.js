// src/app.js
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path"); // ✅ ADD

const apiRoutes = require("./routes");
const { env } = require("./config/env");
const { notFound, errorHandler } = require("./middlewares/error");
const receiptTpl = require("./routes/receiptTemplates");
const printReceipt = require("./routes/receiptTemplates");



function createApp() {
  const app = express();

  app.use(cors({ origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN }));
  app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // ✅ cho phép load ảnh từ origin khác
  })
);
  app.use(express.json({ limit: "2mb" }));
  app.use(morgan("dev"));

  // ✅ Serve uploads (để mở được URL ảnh)
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

  app.get("/", (_req, res) => res.send("COSMETICS API OK"));

  app.use("/api", apiRoutes);

  app.use("/print", printReceipt);

  
  

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
