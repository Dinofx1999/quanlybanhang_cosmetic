const router = require("express").Router();

router.use("/auth", require("./auth.routes"));
router.use("/branches", require("./branch.routes"));
router.use("/products", require("./product.routes"));
router.use("/stocks", require("./stock.routes"));
router.use("/customers", require("./customer.routes"));
router.use("/orders", require("./order.routes"));
router.use("/checkout", require("./checkout.routes"));
router.use("/pos", require("./pos.routes"));
router.use("/sync", require("./sync.routes"));
router.use("/categories", require("./category.routes"));
router.use("/stock-total", require("./stockTotal.routes"));
router.use("/inbounds", require("./inbound.routes"));
router.use("/receipt-templates", require("./receiptTemplates"));
router.use("/uploads", require("./upload.routes"));
module.exports = router;
