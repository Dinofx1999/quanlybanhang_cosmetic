// src/services/loyalty.service.js
const LoyaltySetting = require("../models/LoyaltySetting");
const Tier = require("../models/Tier");
const Customer = require("../models/Customer");
const Order = require("../models/Order");

// ---------- helpers ----------
function toNum(v) {
  const x = Number(v || 0);
  return Number.isFinite(x) ? x : 0;
}
function up(s) {
  return String(s || "").toUpperCase().trim();
}
function roundPoints(x, mode) {
  if (!Number.isFinite(x) || x <= 0) return 0;
  const m = up(mode);
  if (m === "CEIL") return Math.ceil(x);
  if (m === "ROUND") return Math.round(x);
  return Math.floor(x); // FLOOR default
}

// ---------- config loaders ----------
async function getSetting() {
  return await LoyaltySetting.findOne({ key: "default" }).lean();
}

async function getActiveTiersOrdered() {
  const tiers = await Tier.find({ isActive: true }).sort({ priority: -1 }).lean();
  return Array.isArray(tiers) ? tiers : [];
}

function findTierByCode(tiersOrdered, code) {
  const c = up(code);
  return tiersOrdered.find((t) => up(t.code) === c) || null;
}

function getLowestTier(tiersOrdered, fallback = "BRONZE") {
  return (
    tiersOrdered[tiersOrdered.length - 1] || {
      code: fallback,
      priority: 0,
      qualify: { thresholdVnd: 0 },
      earn: {},
    }
  );
}

// bậc thấp hơn 1 step (tiersOrdered sort priority DESC)
function nextLowerTier(tiersOrdered, currentCode, floorCode) {
  const cur = up(currentCode);
  const idx = tiersOrdered.findIndex((t) => up(t.code) === cur);
  if (idx < 0) return getLowestTier(tiersOrdered, floorCode);

  const next = tiersOrdered[idx + 1];
  if (!next) return getLowestTier(tiersOrdered, floorCode);

  // clamp không xuống thấp hơn floorCode
  const floor = up(floorCode);
  const floorTier = findTierByCode(tiersOrdered, floor) || getLowestTier(tiersOrdered, floor);
  if (toNum(next.priority) < toNum(floorTier.priority)) return floorTier;
  return next;
}

function calcStepsByInactivity(lastOrderAt, daysPerStep) {
  if (!lastOrderAt) return 0;
  const ms = Date.now() - new Date(lastOrderAt).getTime();
  const days = Math.floor(ms / (24 * 3600 * 1000));
  if (daysPerStep <= 0) return 0;
  return Math.floor(days / daysPerStep);
}

// tier cao nhất thỏa threshold <= spendForTier
function bestTierBySpend(tiersOrdered, spendForTier) {
  const s = toNum(spendForTier);
  for (const t of tiersOrdered) {
    const th = toNum(t?.qualify?.thresholdVnd);
    if (s >= th) return t;
  }
  return getLowestTier(tiersOrdered);
}

/**
 * Apply loyalty for CONFIRM order (Flow A)
 *
 * Redeem:
 * - Subtract customer.points by order.pointsRedeemed (clamp)
 * - Idempotent by order.pointsRedeemedAt
 *
 * Earn + Tier:
 * - Idempotent by order.pointsAppliedAt OR order.loyaltyAppliedAt
 * - Updates Customer stats + tierProgress + tier upgrade/downgrade
 * - Earn points by tier.earn.amountPerPoint & round
 * - Snapshot to Order: pointsEarned, pointsAppliedAt, loyaltyAppliedAt, loyalty{}
 *
 * IMPORTANT:
 * - Orders with status DEBT MUST NOT call this (routes should gate)
 */
async function onOrderConfirmedOrDone({ customerId, orderId, order, userId = null }) {
  const setting = await getSetting();
  if (!setting || setting.isActive === false) return { ok: false, reason: "LOYALTY_DISABLED" };

  const tiersOrdered = await getActiveTiersOrdered();
  if (!tiersOrdered.length) return { ok: false, reason: "NO_TIERS" };

  const floorCode = up(setting.downgradeTo || "BRONZE");
  const lowestTier = getLowestTier(tiersOrdered, floorCode);

  // ---- Load order as Mongoose document ----
  let ord = null;

  if (order && order._id) {
    // nếu routes truyền object/lean, vẫn load lại doc để save an toàn
    ord = await Order.findById(order._id);
  } else if (orderId) {
    ord = await Order.findById(orderId);
  }

  if (!ord) return { ok: false, reason: "ORDER_NOT_FOUND" };

  // hard gate: only CONFIRM
  if (up(ord.status) !== "CONFIRM") return { ok: false, reason: "ORDER_NOT_CONFIRMED" };

  // resolve customerId
  const cid = customerId || ord.customerId;
  if (!cid) {
    // mark applied=0 để tránh re-process mãi
    const now0 = new Date();
    ord.pointsEarned = ord.pointsEarned || 0;
    ord.pointsAppliedAt = ord.pointsAppliedAt || now0;
    ord.loyaltyAppliedAt = ord.loyaltyAppliedAt || now0;
    await ord.save();
    return { ok: true, skipped: true, reason: "NO_CUSTOMER" };
  }

  const customer = await Customer.findById(cid);
  if (!customer) return { ok: false, reason: "CUSTOMER_NOT_FOUND" };

  const now = new Date();

  // =========================
  // (A) REDEEM (idempotent)
  // =========================
  let redeemedPointsApplied = 0;

  const reqRedeem = Math.max(0, Math.floor(toNum(ord.pointsRedeemed || 0)));

  if (reqRedeem > 0 && !ord.pointsRedeemedAt) {
    const curPts = Math.max(0, Math.floor(toNum(customer.points || 0)));
    const deduct = Math.min(curPts, reqRedeem);

    customer.points = curPts - deduct;

    // normalize on order (để đúng thực tế)
    ord.pointsRedeemed = deduct;
    ord.pointsRedeemedAt = now;

    redeemedPointsApplied = deduct;
  }

  // =========================
  // (B) EARN + TIER (idempotent)
  // =========================
  const earnAlready = !!(ord.pointsAppliedAt || ord.loyaltyAppliedAt);
  let pointsEarned = toNum(ord.pointsEarned || 0);

  if (!earnAlready) {
    const locked = !!customer?.tier?.locked;
    const permanent = !!customer?.tier?.permanent;

    // 1) Downgrade by inactivity (reset progress when downgraded)
    if (!locked && !permanent && setting?.inactivity?.enabled) {
      const daysPerStep = toNum(setting?.inactivity?.daysPerStep || 90);
      const steps = calcStepsByInactivity(customer?.stats?.lastOrderAt, daysPerStep);

      if (steps > 0) {
        let curCode = up(customer?.tier?.code || lowestTier.code);

        for (let i = 0; i < steps; i++) {
          const lower = nextLowerTier(tiersOrdered, curCode, floorCode);
          curCode = up(lower.code || floorCode);
          if (curCode === floorCode) break;
        }

        const safe = findTierByCode(tiersOrdered, curCode)
          ? curCode
          : up(lowestTier.code);

        customer.tier = customer.tier || {};
        customer.tier.code = safe;
        customer.tier.startsAt = now;
        customer.tierUpdatedAt = now;

        customer.tierProgress = customer.tierProgress || {};
        customer.tierProgress.spendForTier = 0;
        customer.tierProgress.resetAt = now;
      }
    }

    // 2) Spend stats + progress
    customer.stats = customer.stats || {};
    customer.tierProgress = customer.tierProgress || {};

    const ordTotal = toNum(ord.total || 0);
    customer.stats.spendAll = toNum(customer.stats.spendAll) + ordTotal;
    customer.stats.ordersAll = toNum(customer.stats.ordersAll) + 1;
    customer.stats.lastOrderAt = now;

    customer.tierProgress.spendForTier = toNum(customer.tierProgress.spendForTier) + ordTotal;

    // 3) Upgrade by spend
    if (!locked && !permanent && setting?.autoUpgrade?.enabled) {
      const best = bestTierBySpend(tiersOrdered, customer.tierProgress.spendForTier);
      const curTier = findTierByCode(tiersOrdered, customer.tier.code) || lowestTier;

      if (toNum(best.priority) > toNum(curTier.priority)) {
        customer.tier.code = up(best.code);
        customer.tier.startsAt = now;
        customer.tierUpdatedAt = now;
      }
    }

    // 4) Earn points by current tier
    const tier = findTierByCode(tiersOrdered, customer.tier.code) || lowestTier;

    const baseField = String(setting?.pointBase?.field || "total");
    const baseAmount = toNum(ord?.[baseField] || 0);

    const amountPerPoint = toNum(tier?.earn?.amountPerPoint || 0);
    const minOrderAmount = toNum(tier?.earn?.minOrderAmount || 0);
    const roundMode = tier?.earn?.round || "FLOOR";

    pointsEarned = 0;
    if (amountPerPoint > 0 && baseAmount >= minOrderAmount) {
      pointsEarned = roundPoints(baseAmount / amountPerPoint, roundMode);
    }

    customer.points = toNum(customer.points) + toNum(pointsEarned);

    // snapshot to order (compatible old fields + audit)
    ord.pointsEarned = pointsEarned;
    ord.pointsAppliedAt = now;
    ord.loyaltyAppliedAt = now;

    ord.loyalty = ord.loyalty || {};
    ord.loyalty.enabled = true;

    ord.loyalty.baseField = baseField;
    ord.loyalty.baseAmount = baseAmount;

    ord.loyalty.tier = up(customer?.tier?.code || lowestTier.code);
    // store amountPerPoint as "vndPerPoint" (schema name), even though semantics = amountPerPoint
    ord.loyalty.vndPerPoint = amountPerPoint;

    ord.loyalty.earnedPoints = pointsEarned;
    ord.loyalty.earnedAt = now;
    ord.loyalty.earnedById = userId || null;
  }

  // persist changes (redeem may have happened even if earnAlready)
  await customer.save();
  await ord.save();

  return {
    ok: true,
    redeemedPoints: redeemedPointsApplied,
    pointsEarned: toNum(ord.pointsEarned || 0),
    tier: up(customer?.tier?.code || lowestTier.code),
    spendForTier: toNum(customer?.tierProgress?.spendForTier || 0),
    skippedEarn: earnAlready,
  };
}

module.exports = { onOrderConfirmedOrDone };
