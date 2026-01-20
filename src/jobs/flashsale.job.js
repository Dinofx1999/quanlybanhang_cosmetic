// src/jobs/flashsale.job.js
const cron = require("node-cron");
const FlashSale = require("../models/FlashSale");
const Product = require("../models/Product");

/**
 * Cron job chạy mỗi phút để:
 * 1. Cập nhật status flash sales
 * 2. Sync flash sale info to products
 * 3. Clear expired flash sales from products
 */
async function updateFlashSaleStatus() {
  try {
    console.log("[CRON] Updating flash sale status...");

    const flashSales = await FlashSale.find({ isActive: true });

    for (const fs of flashSales) {
      const oldStatus = fs.status;
      fs.updateStatus();

      if (oldStatus !== fs.status) {
        console.log(`[CRON] Flash sale ${fs.code}: ${oldStatus} -> ${fs.status}`);
        await fs.save();
      }

      // Sync to products nếu đang ACTIVE
      if (fs.status === "ACTIVE") {
        const bulkOps = fs.products
          .filter(p => p.isActive)
          .map(p => ({
            updateOne: {
              filter: { _id: p.productId },
              update: {
                $set: {
                  activeFlashSaleId: fs._id,
                  flashSalePrice: p.flashPrice,
                  flashSaleStartDate: fs.startDate,
                  flashSaleEndDate: fs.endDate
                }
              }
            }
          }));

        if (bulkOps.length > 0) {
          await Product.bulkWrite(bulkOps);
        }
      }

      // Clear từ products nếu ENDED/CANCELLED
      if (fs.status === "ENDED" || fs.status === "CANCELLED") {
        await Product.updateMany(
          { activeFlashSaleId: fs._id },
          {
            $set: {
              activeFlashSaleId: null,
              flashSalePrice: null,
              flashSaleStartDate: null,
              flashSaleEndDate: null
            }
          }
        );
      }
    }

    console.log("[CRON] Flash sale status updated successfully");
  } catch (error) {
    console.error("[CRON] Error updating flash sale status:", error);
  }
}

// Chạy mỗi phút
function startFlashSaleCron() {
  cron.schedule("* * * * *", updateFlashSaleStatus);
  console.log("[CRON] Flash sale job started");
}

module.exports = { startFlashSaleCron, updateFlashSaleStatus };