const Stock = require("../models/Stock");

/**
 * Option A: ưu tiên MAIN trước, thiếu mới trừ các branch khác.
 * @returns allocations: [{ branchId, productId, qty }]
 */
async function allocateOnlineStock({ mainBranchId, items }) {
  // items: [{ productId, qty }]
  const productIds = items.map(i => String(i.productId));

  // Lấy tất cả stock liên quan
  const stocks = await Stock.find({ productId: { $in: productIds } }).lean();

  // Group stock by productId
  const byProduct = new Map();
  for (const st of stocks) {
    const pid = String(st.productId);
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    byProduct.get(pid).push({
      branchId: String(st.branchId),
      productId: pid,
      qty: Number(st.qty || 0),
    });
  }

  // sort: MAIN trước, sau đó qty desc (cho các branch còn lại)
  for (const [pid, arr] of byProduct.entries()) {
    arr.sort((a, b) => {
      const aMain = a.branchId === String(mainBranchId) ? 1 : 0;
      const bMain = b.branchId === String(mainBranchId) ? 1 : 0;
      if (aMain !== bMain) return bMain - aMain; // MAIN first
      return (b.qty - a.qty); // còn lại: tồn nhiều trước
    });
    byProduct.set(pid, arr);
  }

  const allocations = [];

  for (const it of items) {
    const pid = String(it.productId);
    let need = Number(it.qty || 0);

    const arr = byProduct.get(pid) || [];
    // Tổng tồn check nhanh
    const totalAvail = arr.reduce((s, x) => s + Math.max(0, x.qty), 0);
    if (totalAvail < need) {
      const err = new Error(`OUT_OF_STOCK productId=${pid} need=${need} avail=${totalAvail}`);
      err.code = "OUT_OF_STOCK";
      throw err;
    }

    for (const st of arr) {
      if (need <= 0) break;
      const canTake = Math.max(0, st.qty);
      if (canTake <= 0) continue;

      const take = Math.min(canTake, need);
      allocations.push({ branchId: st.branchId, productId: pid, qty: take });

      st.qty -= take;
      need -= take;
    }
  }

  return allocations;
}

module.exports = { allocateOnlineStock };
