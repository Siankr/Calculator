const fs = require("fs");
const path = require("path");

function loadNSW(contractDate) {
  const p = path.join(__dirname, "..", "nsw.json");
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  // For multi-period, pick by date. We have one period here.
  return data;
}

function pickSchedule(rules, isLand) {
  const land = rules.modes.land;
  if (isLand) {
    if (land && land.schedule) return land;
    if (land && land.inherits && rules.modes[land.inherits]) return rules.modes[land.inherits];
  }
  return rules.modes.established;
}

function calcBaseDuty(price, schedule) {
  // find tier where price ∈ [lower, upper)
  const tier = schedule.schedule.find(t => t.upper_exclusive === null ? price >= t.lower_inclusive : (price >= t.lower_inclusive && price < t.upper_exclusive));
  if (!tier) throw new Error("No duty tier matched");
  const amount = tier.base + tier.marginal_rate * (price - tier.applies_above);
  return amount;
}

function applyFHB(price, baseDuty, rules, isLand, isFhb) {
  if (!isFhb || !rules.fhb || !rules.fhb.enabled) return baseDuty;
  const type = isLand ? "land" : "established";
  const fhbRule = (rules.fhb.rules || []).find(r => r.property_type === type);
  if (!fhbRule) return baseDuty;
  const { full_exemption_upto, concession_to, concession_formula } = fhbRule;
  if (price <= full_exemption_upto) return 0;
  if (concession_to && price < concession_to && concession_formula === "linear") {
    const ratio = (concession_to - price) / (concession_to - full_exemption_upto);
    return baseDuty * (1 - ratio);
  }
  return baseDuty;
}

function roundNearestDollar(x) {
  return Math.round(x);
}

function calcDutyNSW({ price, isLand=false, isFhb=false, contractDate="2025-10-10" }) {
  const rules = loadNSW(contractDate);
  const schedule = pickSchedule(rules, isLand);
  const base = calcBaseDuty(price, schedule);
  const withFhb = applyFHB(price, base, rules, isLand, isFhb);
  return roundNearestDollar(withFhb);
}

module.exports = { calcDutyNSW };
