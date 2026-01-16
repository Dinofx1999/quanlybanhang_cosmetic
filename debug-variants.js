// generate-all-variants.js - Tự động generate variants cho tất cả products có options
require("dotenv").config();
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL;

if (!MONGODB_URI) {
  console.error("❌ Không tìm thấy MONGODB_URI trong .env");
  process.exit(1);
}

console.log("🔌 Đang kết nối MongoDB...\n");
mongoose.connect(MONGODB_URI);

// Helper functions (giống trong route)
function normalizeKey(s) {
  return String(s || "").toLowerCase().trim();
}

function normalizeToken(s) {
  return String(s || "")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_]/g, "");
}

function buildVariantName(masterName, attrs) {
  const parts = [String(masterName || "")];
  for (const a of attrs || []) {
    parts.push(`${String(a.key || "").toUpperCase()}: ${String(a.value || "")}`);
  }
  return parts.filter(Boolean).join(" - ");
}

function skuFrom(masterSku, attrs) {
  return [String(masterSku || ""), ...(attrs || []).map((a) => normalizeToken(a.value))].join("-");
}

function cartesianOptions(options) {
  let acc = [[]];
  for (const opt of options || []) {
    const key = normalizeKey(opt.key);
    const values = Array.isArray(opt.values) ? opt.values : [];
    if (!key || values.length === 0) continue;

    const next = [];
    for (const base of acc) {
      for (const val of values) {
        next.push([...base, { key, value: String(val) }]);
      }
    }
    acc = next;
  }
  return acc;
}

async function generateAllVariants() {
  console.log("=== AUTO GENERATE VARIANTS ===\n");

  try {
    await mongoose.connection.asPromise();
    console.log("✅ Kết nối thành công!\n");

    // Define schemas
    const ProductSchema = new mongoose.Schema({
      sku: String,
      name: String,
      price: Number,
      cost: Number,
      basePrice: Number,
      baseTier: Array,
      price_tier: Array,
      hasVariants: Boolean,
      options: Array,
      pricingRules: Array,
    }, { strict: false, collection: "products" });

    const ProductVariantSchema = new mongoose.Schema({
      productId: mongoose.Schema.Types.ObjectId,
      sku: String,
      barcode: String,
      name: String,
      attributes: Array,
      price: Number,
      cost: Number,
      price_tier: Array,
      isActive: Boolean,
      thumbnail: String,
      images: Array,
    }, { strict: false, collection: "product_variants" });

    const Product = mongoose.model("Product", ProductSchema);
    const ProductVariant = mongoose.model("ProductVariant", ProductVariantSchema);

    // Tìm tất cả products có options
    console.log("1️⃣ Tìm products có options...");
    const productsWithOptions = await Product.find({
      options: { $exists: true, $ne: [] },
    }).lean();

    console.log(`   ✅ Tìm thấy ${productsWithOptions.length} products có options\n`);

    if (productsWithOptions.length === 0) {
      console.log("   ⚠️ Không có products nào có options để generate variants!");
      await mongoose.connection.close();
      return;
    }

    let totalCreated = 0;

    // Generate variants cho từng product
    for (const product of productsWithOptions) {
      console.log(`\n2️⃣ Processing Product: ${product.name}`);
      console.log(`   SKU: ${product.sku}`);
      console.log(`   Options:`, JSON.stringify(product.options));

      const combos = cartesianOptions(product.options || []);
      console.log(`   → Sẽ tạo ${combos.length} variants`);

      if (combos.length === 0) {
        console.log("   ⚠️ Không tạo được combos từ options");
        continue;
      }

      // Kiểm tra variants đã tồn tại
      const existingVariants = await ProductVariant.find(
        { productId: product._id },
        { sku: 1 }
      ).lean();
      const existingSkus = new Set(existingVariants.map((x) => String(x.sku)));

      const docsToCreate = [];
      for (const attrs of combos) {
        const sku = skuFrom(product.sku, attrs);
        
        if (existingSkus.has(sku)) {
          console.log(`   ⏭️  Skip: ${sku} (đã tồn tại)`);
          continue;
        }

        // Convert {key,value} -> {k,v} đúng schema
        const attrsKV = (attrs || [])
          .map((a) => ({
            k: String(a.key || "").trim(),
            v: String(a.value || "").trim(),
          }))
          .filter((x) => x.k && x.v);

        docsToCreate.push({
          productId: product._id,
          sku,
          barcode: "",
          name: buildVariantName(product.name, attrs),
          attributes: attrsKV,
          cost: Math.round(Number(product.cost || 0)),
          price: Math.round(Number(product.basePrice || product.price || 0)),
          price_tier: (product.baseTier && product.baseTier.length ? product.baseTier : product.price_tier) || [],
          isActive: true,
          thumbnail: "",
          images: [],
        });
      }

      if (docsToCreate.length > 0) {
        const inserted = await ProductVariant.insertMany(docsToCreate);
        console.log(`   ✅ Đã tạo ${inserted.length} variants:`);
        inserted.forEach(v => {
          console.log(`      - ${v.sku}: ${v.name}`);
        });
        totalCreated += inserted.length;

        // Update product hasVariants=true
        await Product.updateOne(
          { _id: product._id },
          { 
            $set: { 
              hasVariants: true,
              basePrice: product.basePrice || product.price,
              baseTier: product.baseTier?.length ? product.baseTier : product.price_tier,
            } 
          }
        );
      } else {
        console.log(`   ⚠️ Không có variants mới để tạo`);
      }
    }

    console.log("\n═══════════════════════════════════════════════");
    console.log("📊 TỔNG KẾT:");
    console.log("═══════════════════════════════════════════════");
    console.log(`✅ Đã tạo ${totalCreated} variants mới`);
    console.log(`✅ Từ ${productsWithOptions.length} products`);
    console.log("═══════════════════════════════════════════════\n");

    // Verify kết quả
    console.log("3️⃣ Verify kết quả:");
    const finalCount = await ProductVariant.countDocuments();
    const activeCount = await ProductVariant.countDocuments({ isActive: true });
    console.log(`   - Tổng variants: ${finalCount}`);
    console.log(`   - Variants active: ${activeCount}`);
    console.log("");

    if (finalCount > 0) {
      // Test aggregation
      console.log("4️⃣ Test aggregation:");
      const testProduct = productsWithOptions[0];
      const testResult = await Product.aggregate([
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

      if (testResult.length > 0 && testResult[0].variantsCount > 0) {
        console.log("   ✅ Aggregation hoạt động!");
        console.log(`   ✅ Product "${testResult[0].name}" có ${testResult[0].variantsCount} variants`);
        console.log("\n🎉 API mode=pos sẽ hoạt động bình thường!\n");
      } else {
        console.log("   ⚠️ Aggregation không tìm thấy variants");
      }
    }

    console.log("📝 Bước tiếp theo:");
    console.log("   1. Restart server: npm start");
    console.log("   2. Test API: GET /api/products?mode=pos");
    console.log("   3. Hoặc test: GET /api/products/:productId/variants\n");

  } catch (error) {
    console.error("❌ Error:", error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log("🔌 Đã đóng kết nối\n");
  }
}

generateAllVariants().catch(err => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});