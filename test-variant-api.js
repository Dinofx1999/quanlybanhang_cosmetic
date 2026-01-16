// test-variant-api.js - Test các API endpoints
const axios = require("axios");

const BASE_URL = "http://localhost:3000"; // Thay đổi theo server của bạn
const TOKEN = "YOUR_JWT_TOKEN"; // Thay bằng token thật

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  },
});

async function testVariantAPIs() {
  console.log("=== TEST VARIANT APIs ===\n");

  try {
    // Test 1: List products với mode=product (default)
    console.log("1️⃣ Test: GET /api/products (mode=product - default)");
    const r1 = await api.get("/api/products?limit=5");
    console.log("   Status:", r1.status);
    console.log("   Mode:", r1.data.mode);
    console.log("   Total:", r1.data.total);
    console.log("   Items:", r1.data.items?.length || 0);
    if (r1.data.items?.[0]) {
      console.log("   First item _id:", r1.data.items[0]._id);
      console.log("   First item hasVariants:", r1.data.items[0].hasVariants);
    }
    console.log("");

    // Test 2: List với mode=pos (sellables)
    console.log("2️⃣ Test: GET /api/products?mode=pos");
    const r2 = await api.get("/api/products?mode=pos&limit=5");
    console.log("   Status:", r2.status);
    console.log("   Mode:", r2.data.mode);
    console.log("   Total:", r2.data.total);
    console.log("   Items:", r2.data.items?.length || 0);
    if (r2.data.items?.[0]) {
      console.log("   First item _id:", r2.data.items[0]._id);
      console.log("   First item isVariant:", r2.data.items[0].isVariant);
      console.log("   First item sku:", r2.data.items[0].sku);
      console.log("   First item attributes:", JSON.stringify(r2.data.items[0].attributes || []));
    }
    console.log("");

    // Test 3: List với mode=variant
    console.log("3️⃣ Test: GET /api/products?mode=variant");
    const r3 = await api.get("/api/products?mode=variant&limit=5");
    console.log("   Status:", r3.status);
    console.log("   Mode:", r3.data.mode);
    console.log("   Total:", r3.data.total);
    console.log("   Items:", r3.data.items?.length || 0);
    if (r3.data.items?.[0]) {
      console.log("   First item _id:", r3.data.items[0]._id);
      console.log("   First item productId:", r3.data.items[0].productId);
      console.log("   First item sku:", r3.data.items[0].sku);
    }
    console.log("");

    // Test 4: Get variants by product
    if (r2.data.items?.[0]?.productId) {
      const productId = r2.data.items[0].productId;
      console.log("4️⃣ Test: GET /api/products/:id/variants");
      console.log("   ProductId:", productId);
      const r4 = await api.get(`/api/products/${productId}/variants`);
      console.log("   Status:", r4.status);
      console.log("   Variants count:", r4.data.items?.length || 0);
      if (r4.data.items?.[0]) {
        console.log("   First variant _id:", r4.data.items[0]._id);
        console.log("   First variant sku:", r4.data.items[0].sku);
        console.log("   First variant name:", r4.data.items[0].name);
      }
      console.log("");
    }

    // Test 5: Search với query
    console.log("5️⃣ Test: Search with query");
    const r5 = await api.get("/api/products?mode=pos&q=test&limit=5");
    console.log("   Status:", r5.status);
    console.log("   Total:", r5.data.total);
    console.log("   Items:", r5.data.items?.length || 0);
    console.log("");

    // Test 6: Filter by barcode
    console.log("6️⃣ Test: Filter by barcode (nếu có)");
    try {
      const r6 = await api.get("/api/products?mode=pos&barcode=TEST123");
      console.log("   Status:", r6.status);
      console.log("   Total:", r6.data.total);
      console.log("   Items:", r6.data.items?.length || 0);
    } catch (e) {
      console.log("   ⚠️ No item with barcode TEST123");
    }
    console.log("");

    console.log("✅ TEST HOÀN THÀNH\n");

    // Tổng kết
    console.log("📊 TỔNG KẾT:");
    console.log("─────────────────────────────────");
    console.log("Mode Product - Total:", r1.data.total, "items");
    console.log("Mode POS     - Total:", r2.data.total, "items");
    console.log("Mode Variant - Total:", r3.data.total, "items");
    console.log("");
    
    if (r2.data.total === 0) {
      console.log("⚠️ WARNING: Mode POS không có items!");
      console.log("   Kiểm tra:");
      console.log("   1. Có variants trong DB không?");
      console.log("   2. Collection name đúng 'product_variants' chưa?");
      console.log("   3. Variants có isActive=true không?");
      console.log("   4. BranchId filter có đúng không?");
    }

  } catch (error) {
    console.error("❌ ERROR:", error.response?.data || error.message);
    if (error.response?.status === 401) {
      console.error("   → Token không hợp lệ hoặc đã hết hạn");
    } else if (error.response?.status === 403) {
      console.error("   → Không có quyền truy cập");
    }
  }
}

// Chạy test
testVariantAPIs().catch(console.error);