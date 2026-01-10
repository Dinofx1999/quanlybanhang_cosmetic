const Stock = require("../models/Stock");

/**
 * ONLINE (Web) theo yêu cầu:
 * ✅ Luôn trừ vào kho chính (mainBranchId) — không chia sang branch khác
 * ✅ Cho phép âm kho (không throw OUT_OF_STOCK)
 * @returns allocations: [{ branchId, productId, qty }]
 */
async function allocateOnlineStock({ mainBranchId, items }) {
  if (!mainBranchId) {
    const err = new Error("MISSING_MAIN_BRANCH_ID");
    err.code = "MISSING_MAIN_BRANCH_ID";
    throw err;
  }

  const allocations = [];

  for (const it of items || []) {
    const pid = String(it.productId);
    const need = Number(it.qty || 0);

    if (!pid || !Number.isFinite(need) || need <= 0) continue;

    // ✅ luôn allocate vào MAIN, dù tồn hiện tại có 0 hay âm
    allocations.push({
      branchId: String(mainBranchId),
      productId: pid,
      qty: need,
    });
  }

  return allocations;
}

module.exports = { allocateOnlineStock };
