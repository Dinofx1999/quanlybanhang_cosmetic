// src/services/pricing.service.js

function attrsToMap(attrs = []) {
  return Object.fromEntries((attrs || []).map((a) => [String(a.key || "").toLowerCase(), String(a.value || "")]));
}

function matchRule(rule, attrsMap) {
  const conds = Array.isArray(rule?.when) ? rule.when : [];
  return conds.every((c) => {
    const key = String(c?.key || "").toLowerCase();
    const v = attrsMap[key];
    const op = String(c?.op || "eq").toLowerCase();
    const val = String(c?.value || "");

    if (op === "eq") return v === val;
    if (op === "neq") return v !== val;
    if (op === "in") return val.split("|").includes(v);
    return false;
  });
}

function applyRulesToVariant(product, variant) {
  const attrsMap = attrsToMap(variant.attributes || []);

  let retail = Number(product.basePrice || 0);

  const tierMap = new Map();
  for (const x of product.baseTier || []) {
    tierMap.set(String(x.tierId), Number(x.price || 0));
  }

  const rules = [...(product.pricingRules || [])].sort((a, b) => (a.priority || 100) - (b.priority || 100));

  for (const r of rules) {
    if (!matchRule(r, attrsMap)) continue;

    // retail
    if (r.actionRetail?.type === "SET") retail = Number(r.actionRetail.amount || 0);
    if (r.actionRetail?.type === "ADD") retail += Number(r.actionRetail.amount || 0);

    // tiers
    for (const t of r.actionTiers || []) {
      const id = String(t.tierId);
      const cur = tierMap.has(id) ? tierMap.get(id) : retail; // fallback
      if (t.type === "SET") tierMap.set(id, Number(t.amount || 0));
      if (t.type === "ADD") tierMap.set(id, Number(cur || 0) + Number(t.amount || 0));
    }
  }

  return {
    price: Math.round(retail),
    price_tier: [...tierMap.entries()].map(([tierId, price]) => ({ tierId, price: Math.round(Number(price || 0)) })),
  };
}

module.exports = { applyRulesToVariant };
