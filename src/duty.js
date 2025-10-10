const fs = require("fs");
const path = require("path");

// --- Load rules by state (2025-26). Extend the map as you add more states.
function loadRules(state, contractDate) {
  const fileMap = {
    NSW: "nsw.json",
    VIC: "vic.json",
    QLD: "qld.json",
    // WA:  "wa.json",
    // SA:  "sa.json",
    // TAS: "tas.json",
    // ACT: "act.json",
    // NT:  "nt.json"
  };
  const key = String(state || "").toUpperCase();
  const file = fileMap[key];
  if (!file) throw new Error(`Unsupported state: ${state}`);
  const p = path.join(__dirname, "..", "rules", "duty", "2025-26", file);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function pickSchedule(rules, { state, isLand, isPpr, price }) {
  if (isLand) {
    const land = rules.modes.land;
    if (land && land.schedule) return land;
    if (land && land.inherits && rules.modes[land.inherits]) return rules.modes[land.inherits];
    return rules.modes.established;
  }

  const st = String(state).toUpperCase();

  // VIC PPR concession only up to $550k
  if (isPpr && st === "VIC" && price <= 550000 && rules.modes.ppr) {
    return rules.modes.ppr;
  }

  // QLD home concession (PPR) has no $ cap in our encoded schedule
  if (isPpr && st === "QLD" && rules.modes.ppr) {
    return rules.modes.ppr;
  }

  return rules.modes.established;
}


function calcBaseDuty(price, schedule) {
  const tier = schedule.schedule.find(t =>
    t.upper_exclusive === null
      ? price >= t.lower_inclusive
      : price >= t.lower_inclusive && price < t.upper_exclusive
  );
  if (!tier) throw new Error("No duty tier matched (check schedule)");
  const amount = tier.base + tier.marginal_rate * (price - tier.applies_above);
  return amount;
}

function applyFHB(price, baseDuty, rules, isLand, isFhb, { state, isPpr }) {
  if (!isFhb || !rules.fhb || !rules.fhb.enabled) return baseDuty;

  const type = isLand ? "land" : "established";
  const fhbRule = (rules.fhb.rules || []).find(r => r.property_type === type);
  if (!fhbRule) return baseDuty;

  const { full_exemption_upto, concession_to, concession_formula, step_amount, step_interval, rebate_base_reference } = fhbRule;

  // Full exemption threshold
  if (price <= (full_exemption_upto ?? 0)) return 0;

  // Linear phase-out (e.g., NSW, VIC)
  if (concession_formula === "linear" && concession_to && price < concession_to) {
    const ratio = (concession_to - price) / (concession_to - full_exemption_upto);
    return baseDuty * (1 - ratio);
  }

  // Full-at-or-below threshold only, no concession above (simple pass-through)
  if (concession_formula === "full_at_or_below_threshold") {
    return baseDuty; // already handled the <= threshold case above
  }

  // QLD: step_10k_rebate (stub)
  // Logic outline (to implement later):
  // - compute duty using rebate_base_reference schedule (usually "ppr")
  // - compute steps = ceil((price - 700k)/10k)
  // - rebate = max(0, max_rebate - steps * 1,735)
  // - duty = max(0, duty_base - rebate)
  if (concession_formula === "step_10k_rebate") {
    // STUB for now: return baseDuty unchanged above threshold
    return baseDuty;
  }

  return baseDuty;
}

function roundNearestDollar(x) {
  return Math.round(x);
}

// Generic calculator (state-aware)
function calcDuty({ state = "NSW", price, isLand = false, isPpr = false, isFhb = false, contractDate = "2025-10-10" }) {
  const rules = loadRules(state, contractDate);
  const schedule = pickSchedule(rules, { state, isLand, isPpr, price });
  const base = calcBaseDuty(price, schedule);
  const withFhb = applyFHB(price, base, rules, isLand, isFhb, { state, isPpr });
  return roundNearestDollar(withFhb);
}

// Backward-compatible NSW wrapper (keeps existing tests working)
function calcDutyNSW(args) {
  return calcDuty({ state: "NSW", ...args });
}

module.exports = { calcDuty, calcDutyNSW };
