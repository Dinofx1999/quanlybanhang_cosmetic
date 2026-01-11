const Customer = require("../models/Customer");
const CustomerPointsLedger = require("../models/CustomerPointsLedger");

// ===== RULE: 10.000đ = 1 point (đổi tuỳ bạn)
function calcEarnPointsFromOrderTotal(total) {
  const t = Number(total || 0);
  if (!t || t <= 0) return 0;
  return Math.floor(t / 10000);
}

/**
 * Earn points when order confirmed
 * - idempotent (chạy nhiều lần không cộng thêm)
 * - nếu order không có customerId => skip
 */
async function earnPointsForOrder({ order, userId }) {
  const customerId = order.customerId;
  if (!customerId) return { ok: true, skipped: true, reason: "NO_CUSTOMER" };

  const earn = calcEarnPointsFromOrderTotal(order.total);
  if (!earn) return { ok: true, skipped: true, reason: "EARN_ZERO" };

  // đảm bảo không cộng lại: dựa vào ledger unique
  const reason = "EARN_ORDER";
  const refType = "Order";
  const refId = order._id;

  // atomic: tăng điểm và lấy số dư mới
  const updatedCustomer = await Customer.findOneAndUpdate(
    { _id: customerId },
    { $inc: { points: earn } },
    { new: true }
  );

  // Nếu vì lý do nào đó customer mất => rollback logic đơn giản: bỏ qua ledger
  if (!updatedCustomer) return { ok: false, message: "CUSTOMER_NOT_FOUND" };

  try {
    await CustomerPointsLedger.create({
      customerId,
      delta: earn,
      balanceAfter: Number(updatedCustomer.points || 0),
      reason,
      refType,
      refId,
      branchId: order.branchId || null,
      createdBy: userId || null,
      expireAt: null,
    });

    return { ok: true, earned: earn, balanceAfter: updatedCustomer.points };
  } catch (e) {
    // nếu ledger bị trùng unique => nghĩa là đã cộng trước đó
    // IMPORTANT: ta đã inc points rồi => phải revert lại để không lệch
    if (String(e.code) === "11000") {
      await Customer.findOneAndUpdate({ _id: customerId }, { $inc: { points: -earn } });
      const c = await Customer.findById(customerId).lean();
      return { ok: true, alreadyApplied: true, earned: 0, balanceAfter: c?.points ?? 0 };
    }
    // lỗi khác: revert points
    await Customer.findOneAndUpdate({ _id: customerId }, { $inc: { points: -earn } });
    throw e;
  }
}

/**
 * Revert earned points when order CANCELLED or REFUNDED
 * - chỉ revert nếu trước đó đã EARN_ORDER
 * - revert đúng số điểm đã earn (không tự tính lại)
 */
async function revertEarnPointsForOrder({ order, userId, reason }) {
  const customerId = order.customerId;
  if (!customerId) return { ok: true, skipped: true, reason: "NO_CUSTOMER" };

  // tìm earned ledger trước đó
  const earnedRow = await CustomerPointsLedger.findOne({
    refType: "Order",
    refId: order._id,
    reason: "EARN_ORDER",
  }).lean();

  if (!earnedRow) return { ok: true, skipped: true, reason: "NO_EARN_LEDGER" };

  const earn = Number(earnedRow.delta || 0);
  if (!earn) return { ok: true, skipped: true, reason: "EARN_ZERO_LEDGER" };

  // tạo ledger revert unique theo reason truyền vào
  const refType = "Order";
  const refId = order._id;

  const updatedCustomer = await Customer.findOneAndUpdate(
    { _id: customerId },
    { $inc: { points: -earn } },
    { new: true }
  );

  if (!updatedCustomer) return { ok: false, message: "CUSTOMER_NOT_FOUND" };

  try {
    await CustomerPointsLedger.create({
      customerId,
      delta: -earn,
      balanceAfter: Number(updatedCustomer.points || 0),
      reason, // "REVERT_EARN_CANCELLED" | "REVERT_EARN_REFUNDED"
      refType,
      refId,
      branchId: order.branchId || null,
      createdBy: userId || null,
      expireAt: null,
    });

    return { ok: true, reverted: earn, balanceAfter: updatedCustomer.points };
  } catch (e) {
    // nếu đã revert rồi => rollback inc vừa trừ để không lệch
    if (String(e.code) === "11000") {
      await Customer.findOneAndUpdate({ _id: customerId }, { $inc: { points: +earn } });
      const c = await Customer.findById(customerId).lean();
      return { ok: true, alreadyReverted: true, balanceAfter: c?.points ?? 0 };
    }
    await Customer.findOneAndUpdate({ _id: customerId }, { $inc: { points: +earn } });
    throw e;
  }
}

module.exports = {
  calcEarnPointsFromOrderTotal,
  earnPointsForOrder,
  revertEarnPointsForOrder,
};
