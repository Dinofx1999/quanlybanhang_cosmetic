// quick-fix.js - Sửa nhanh các vấn đề về variants
require("dotenv").config();
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL;

if (!MONGODB_URI) {
  console.error("❌ Không tìm thấy MONGODB_URI trong .env");
  process.exit(1);
}

console.log("🔌 Đang kết nối MongoDB...\n");

// Không dùng deprecated options
mongoose.connect(MONGODB_URI);

async function quickFix() {
  console.log("=== QUICK FIX VARIANTS ===\n");

  try {
    await mongoose.connection.asPromise();
    console.log("✅ Kết nối thành công!\n");

    const Product = mongoose.model("Product", new mongoose.Schema({}, { strict: false, collection: "products" }));
    const ProductVariant = mongoose.model("ProductVariant", new mongoose.Schema({}, { strict: false, collection: "product_variants" }));

    // 1. Kiểm tra collection name
    console.log("1️⃣ Kiểm tra collection name...");
    const collections = await mongoose.connection.db.listCollections().toArray();
    const collectionNames = collections.map((c) => c.name);
    
    if (collectionNames.includes("productvariants") && !collectionNames.includes("product_variants")) {
      console.log("   ⚠️  Tìm thấy 'productvariants' (tên sai)");
      console.log("   🔧 Đang rename collection...");
      
      try {
        await mongoose.connection.db.collection("productvariants").rename("product_variants");
        console.log("   ✅ Đã rename thành 'product_variants'");
      } catch (error) {
        console.log("   ❌ Lỗi rename:", error.message);
      }
    } else if (collectionNames.includes("product_variants")) {
      console.log("   ✅ Collection name đúng: 'product_variants'");
    } else {
      console.log("   ⚠️  Không tìm thấy collection variants");
    }
    console.log("");

    // 2. Kích hoạt tất cả variants
    console.log("2️⃣ Kích hoạt tất cả variants...");
    const updateResult = await ProductVariant.updateMany(
      { isActive: { $ne: true } },
      { $set: { isActive: true } }
    );
    console.log("   ✅ Đã update:", updateResult.modifiedCount, "variants");
    console.log("");

    // 3. Set default thumbnail/images cho variants thiếu
    console.log("3️⃣ Set default thumbnail/images...");
    const updateImages = await ProductVariant.updateMany(
      { 
        $or: [
          { thumbnail: { $exists: false } },
          { images: { $exists: false } }
        ]
      },
      { 
        $set: { 
          thumbnail: "",
          images: []
        } 
      }
    );
    console.log("   ✅ Đã update:", updateImages.modifiedCount, "variants");
    console.log("");

    // 4. Đảm bảo products có hasVariants=true nếu có variants
    console.log("4️⃣ Update hasVariants cho products...");
    const productsWithVariants = await ProductVariant.distinct("productId");
    const updateProducts = await Product.updateMany(
      { _id: { $in: productsWithVariants } },
      { $set: { hasVariants: true } }
    );
    console.log("   ✅ Đã update:", updateProducts.modifiedCount, "products");
    console.log("");

    // 5. Thống kê sau khi fix
    console.log("5️⃣ Thống kê sau khi fix:");
    const totalVariants = await ProductVariant.countDocuments();
    const activeVariants = await ProductVariant.countDocuments({ isActive: true });
    const productsHasVariants = await Product.countDocuments({ hasVariants: true });
    
    console.log("   - Tổng variants:", totalVariants);
    console.log("   - Variants active:", activeVariants);
    console.log("   - Products có hasVariants=true:", productsHasVariants);
    console.log("");

    if (totalVariants === 0) {
      console.log("   ⚠️ WARNING: Không có variants nào!");
      console.log("   → Bạn cần generate variants cho products có options");
      console.log("   → API: POST /api/products/:productId/variants/generate\n");
      await mongoose.connection.close();
      return;
    }

    // 6. Test aggregation
    console.log("6️⃣ Test aggregation...");
    const testProduct = await Product.findOne({ hasVariants: true }).lean();
    
    if (testProduct) {
      const testAgg = await Product.aggregate([
        { $match: { _id: testProduct._id } },
        {
          $lookup: {
            from: "product_variants",
            let: { pid: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$productId", "$$pid"] },
                      { $eq: ["$isActive", true] }
                    ]
                  }
                }
              }
            ],
            as: "_variants",
          },
        },
        {
          $project: {
            name: 1,
            variantsCount: { $size: "$_variants" },
          },
        },
      ]);

      if (testAgg.length > 0) {
        console.log("   ✅ Aggregation hoạt động!");
        console.log("      Product:", testAgg[0].name);
        console.log("      Variants found:", testAgg[0].variantsCount);
        
        if (testAgg[0].variantsCount > 0) {
          console.log("   🎉 API mode=pos sẽ hoạt động bình thường!");
        } else {
          console.log("   ⚠️ Không tìm thấy variants trong aggregation");
        }
      } else {
        console.log("   ⚠️ Aggregation không trả về kết quả");
      }
    } else {
      console.log("   ⚠️ Không có product nào có hasVariants=true");
    }
    console.log("");

    console.log("✅ HOÀN THÀNH!\n");
    console.log("📝 Bước tiếp theo:");
    console.log("   1. Restart server: npm start");
    console.log("   2. Test API: GET /api/products?mode=pos");
    console.log("");

  } catch (error) {
    console.error("❌ Error:", error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log("🔌 Đã đóng kết nối\n");
  }
}

quickFix().catch(err => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});