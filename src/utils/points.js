// src/utils/points.js
const Customer = require("../models/Customer");

const toNum = (v) => Number(v || 0);

/**
 * Revert points earned for an order (idempotent)
 * - Uses order.pointsEarned OR order.loyalty.earnedPoints as source of truth
 * - Marks:
 *   - order.pointsRevertedAt
 *   - order.loyalty.revertedAt / revertedById / revertReason
 *
 * NOTE:
 * - This function does NOT handle "redeem" rollback.
 *   Redeem rollback is handled in orders.routes.js (pointsRedeemedAt / pointsRedeemRevertedAt)
 */
async function revertEarnPointsForOrder({ order, userId = null, reason = "REVERT" }) {
  if (!order) return { ok: false, reason: "NO_ORDER" };
  if (!order.customerId) return { ok: false, reason: "NO_CUSTOMER" };

  // ✅ Idempotent: already reverted
  if (order.pointsRevertedAt || order.loyalty?.revertedAt) {
    return { ok: true, skipped: true, reason: "ALREADY_REVERTED" };
  }

  // ✅ Only revert if it was ever applied
  const earnedPoints = toNum(order.pointsEarned || order.loyalty?.earnedPoints || 0);
  const appliedAt = order.pointsAppliedAt || order.loyaltyAppliedAt || order.loyalty?.earnedAt;

  if (!appliedAt || earnedPoints <= 0) {
    return { ok: true, skipped: true, reason: "NOTHING_TO_REVERT" };
  }

  const customer = await Customer.findById(order.customerId);
  if (!customer) return { ok: false, reason: "CUSTOMER_NOT_FOUND" };

  // subtract but never go below 0
  customer.points = Math.max(0, toNum(customer.points) - earnedPoints);
  await customer.save();

  const now = new Date();

  order.pointsRevertedAt = now;

  order.loyalty = order.loyalty || {};
  order.loyalty.revertedAt = now;
  order.loyalty.revertedById = userId || null;
  order.loyalty.revertReason = String(reason || "REVERT");

  await order.save();

  return { ok: true, reverted: true, points: earnedPoints };
}

module.exports = {
  revertEarnPointsForOrder,
};
