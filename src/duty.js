const fs = require("fs");
const path = require("path");

// --- Load rules by state (2025-26). Extend the map as you add more states.
function loadRules(state, contractDate) {
  const fileMap = {
  NSW: "nsw.json",
  VIC: "vic.json",
  QLD: "qld.json",
  WA:  "wa.json",
  SA:  "sa.json",
  TAS: "tas.json",
  ACT: "act.json",
  NT:  "nt.json"
};
  const key = String(state || "").toUpperCase();
  const file = fileMap[key];
  if (!file) throw new Error(`Unsupported state: ${state}`);
  const p = path.join(__dirname, "..", "rules", "duty", "2025-26", file);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function loadStateRules(state) {
  const file = STATE_FILES[state.toLowerCase()];
  if (!file) throw new Error(`Unsupported state: ${state}`);
  const full = path.join(RULES_ROOT, file);
  const raw = fs.readFileSync(full, 'utf8');
  const json = JSON.parse(raw);
  return json;
}
function calcDutyNtPoly(price) {
  const V = price / 1000; // value in thousands
  // Round to nearest dollar to match your existing guardrails
  return Math.round(0.06571441 * V * V + 15 * V);
}

function pickSchedule(rules, { state, price, isLand, isPpr, isFhb, region }) {
  const st = String(state).toUpperCase();

  // 1) LAND
  if (isLand) {
    // WA FHOR: vacant land (≤ $450k) — otherwise fall back to land/established
    if (isFhb && st === "WA") {
      const landCap = 450000;
      if (price <= landCap && rules.modes.fhb_land && rules.modes.fhb_land.schedule) {
        return rules.modes.fhb_land;
      }
    }
    const land = rules.modes.land;
    if (land && land.schedule) return land;
    if (land && land.inherits && rules.modes[land.inherits]) return rules.modes[land.inherits];
    return rules.modes.established;
  }

  // 2) VIC PPR (owner-occupier) only up to $550k
  if (isPpr && st === "VIC" && price <= 550000 && rules.modes.ppr) {
    return rules.modes.ppr;
  }

  // 3) QLD PPR (owner-occupier) — no explicit cap in our encoded schedule
  if (isPpr && st === "QLD" && rules.modes.ppr) {
    return rules.modes.ppr;
  }

  // 4) WA FHOR (homes) — region-aware caps; above cap fall back to established
  if (isFhb && st === "WA") {
    const isMetro = String(region || "metro").toLowerCase() === "metro";
    const cap = isMetro ? 700000 : 750000;
    const mode = isMetro ? rules.modes.fhb_home_metro : rules.modes.fhb_home_nonmetro;
    if (price <= cap && mode && mode.schedule) {
      return mode;
    }
  }

  // 5) Default
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

  const {
    full_exemption_upto,
    concession_to,
    concession_formula,
    step_amount,
    step_interval,
    rebate_base_reference
  } = fhbRule;

  // 1) Full exemption threshold (all states that have it)
  if (price <= (full_exemption_upto ?? 0)) return 0;

  // 2) Linear phase-out (e.g., NSW, VIC)
  if (concession_formula === "linear" && concession_to && price < concession_to) {
    const ratio = (concession_to - price) / (concession_to - full_exemption_upto);
    return baseDuty * (1 - ratio);
  }

  // 3) “Full at/below” only (no concession above)
  if (concession_formula === "full_at_or_below_threshold") {
    return baseDuty; // already handled ≤ threshold above
  }

  // 4) QLD: step_10k_rebate
  // Rebate applies against duty calculated under the referenced schedule (usually "ppr"),
  // starting from the duty at the full exemption threshold, then reducing by a fixed amount
  // ($1,735) per $10k above $700k, until $800k (duty never < 0).
  if (concession_formula === "step_10k_rebate" && concession_to && price < concession_to) {
    // Choose the reference schedule (e.g., "ppr") to compute the duty to be rebated
    const refMode = rules.modes[rebate_base_reference] || rules.modes.established;
    if (!refMode || !refMode.schedule) return baseDuty;

    // Helper: duty using an explicit schedule object
    const dutyFromSchedule = (p) => {
      const tier = refMode.schedule.find(t =>
        t.upper_exclusive === null ? p >= t.lower_inclusive : (p >= t.lower_inclusive && p < t.upper_exclusive)
      );
      if (!tier) throw new Error("No duty tier matched for rebate reference schedule");
      return tier.base + tier.marginal_rate * (p - tier.applies_above);
    };

    // Duty at current price under the reference (home-concession) schedule
    const dutyAtPriceRef = dutyFromSchedule(price);

    // Maximum rebate equals the duty (under the reference schedule) at the exemption threshold
    const maxRebate = dutyFromSchedule(full_exemption_upto);

    // Number of $10k steps above the threshold (ceil so any $1 over counts as a full step)
    const steps = Math.ceil((price - full_exemption_upto) / (step_interval || 10000));

    // Rebate tapers down by $1,735 per $10k step
    const rebate = Math.max(0, maxRebate - steps * (step_amount || 1735));

    // Net duty cannot be negative
    const net = Math.max(0, dutyAtPriceRef - rebate);

    // Return the rounded result (rounding also happens at the very end, but safe to return raw)
    return net;
  }

  // 5) Past the concession range → no FHB reduction
  return baseDuty;
}


function roundNearestDollar(x) {
  return Math.round(x);
}

// Generic calculator (state-aware)
function calcDuty({ state = "NSW", price, isLand = false, isPpr = false, isFhb = false, region = "metro", contractDate = "2025-10-10" }) {
  const rules = loadRules(state, contractDate);
  // NT polynomial short-circuit (< $525k)
if (
  String(state).toUpperCase() === 'NT' &&
  rules?.modes?.established?.formula?.type === 'nt_poly'
) {
  const cap = Number(rules.modes.established.formula.max_applicable || Infinity);
  if (price <= cap) {
    return calcDutyNtPoly(price);
  }
}
  const schedule = pickSchedule(rules, { state, price, isLand, isPpr, isFhb, region });
  const base = calcBaseDuty(price, schedule);
  const withFhb = applyFHB(price, base, rules, isLand, isFhb, { state, isPpr });
  return roundNearestDollar(withFhb);
}

// Backward-compatible NSW wrapper (keeps existing tests working)
function calcDutyNSW(args) {
  return calcDuty({ state: "NSW", ...args });
}

module.exports = { calcDuty, calcDutyNSW };
