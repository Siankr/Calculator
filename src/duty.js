// src/duty.js
const fs = require('fs');
const path = require('path');

// ---- config ----
const RULES_ROOT = path.join(__dirname, '..', 'rules', 'duty', '2025-26');

const STATE_FILES = {
  nsw: 'nsw.json',
  vic: 'vic.json',
  qld: 'qld.json',
  wa:  'wa.json',
  sa:  'sa.json',
  tas: 'tas.json',
  act: 'act.json',
  nt:  'nt.json'
  // more later…
};

// ---- helpers ----
function loadRules(state) {
  const key = String(state || '').toLowerCase();
  const file = STATE_FILES[key];
  if (!file) throw new Error(`Unsupported state: ${state}`);
  const full = path.join(RULES_ROOT, file);
  const raw = fs.readFileSync(full, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse ${file}: ${e.message}`);
  }
  return json;
}
function applyFhbConcessions(rules, { price, isPpr, isLand, isFhb }, baseDuty, mode, rows) {
  // Only apply if the buyer is FHB
  if (!isFhb) return baseDuty;

  const cfg = rules?.fhb;
  if (!cfg?.enabled || !Array.isArray(cfg.concessions)) return baseDuty;

  const propType = isLand ? 'land' : 'established';
  // ...rest of the function unchanged...

  for (const c of cfg.concessions) {
    const when = c.when || {};
    const propOk = (when.property_type || 'established') === propType;
    const pprOk = (when.isPpr == null) ? true : (!!isPpr === !!when.isPpr);
    if (!propOk || !pprOk) continue;

    const from = Number(c.from), to = Number(c.to);
    if (!(from >= 0 && to > from)) continue;

    if (price <= from) return 0;        // full exemption at/below from
    if (price >= to) continue;          // outside taper band → leave baseDuty

    const t = (price - from) / (to - from); // 0..1 ramp

    // Determine the target (what we are tapering *to*)
    let targetDuty = baseDuty;

    if (c.type === 'linear_to_full') {
      let basisRows = rows; // default: current mode
      if (c.basis === 'general')   basisRows = resolveModeSchedule(rules.modes.established, rules);
      if (c.basis === 'ppr')       basisRows = resolveModeSchedule(rules.modes.ppr, rules);
      targetDuty = calcFromRows(basisRows, price);
    } else if (c.type === 'linear_to_cap' && c.cap?.price) {
      const capMode =
        (c.cap.mode === 'ppr') ? resolveModeSchedule(rules.modes.ppr, rules) : rows;
      targetDuty = calcFromRows(capMode, Number(c.cap.price));
    } else {
      continue; // unknown type → ignore
    }

    return Math.round(targetDuty * t);
  }

  return baseDuty;
}

// NT polynomial (< $525k)
function calcDutyNtPoly(price) {
  const V = price / 1000; // thousands
  return Math.round(0.06571441 * V * V + 15 * V);
}

// Resolve a mode to its effective schedule rows (handles inherits)
function resolveModeSchedule(mode, rules) {
  // Follow simple inherits chain once
  let m = mode;
  if ((!m || (!m.schedule && !m.brackets)) && m && m.inherits && rules?.modes?.[m.inherits]) {
    m = rules.modes[m.inherits];
  }
  // Accept: array; {schedule: array}; {schedule:{brackets:array}}; {brackets:array}
  if (Array.isArray(m)) return m;
  if (m && Array.isArray(m.schedule)) return m.schedule;
  if (m && m.schedule && Array.isArray(m.schedule.brackets)) return m.schedule.brackets;
  if (m && Array.isArray(m.brackets)) return m.brackets;
  return [];
}

// Normalise row shapes (WA/SA/ACT/TAS vs legacy)
function normaliseRows(rows) {
  // Expect either:
  // - WA-style: { lower_inclusive, upper_exclusive, base, marginal_rate, applies_above }
  // - Legacy:   { to|up_to|max, base, rate }  (lower bound = prev upper, applies_above = lower bound)
  let lower = 0;
  return rows.map((r, idx) => {
    const hasWA = r.hasOwnProperty('lower_inclusive') || r.hasOwnProperty('upper_exclusive') || r.hasOwnProperty('marginal_rate');
    const to = (r.to ?? r.up_to ?? r.max ?? r.upper_exclusive ?? null);
    const li = hasWA ? Number(r.lower_inclusive ?? lower) : Number(idx === 0 ? 0 : lower);
    const ue = to === null ? null : Number(to);
    const rate = Number(r.marginal_rate ?? r.rate ?? 0);
    const base = Number(r.base ?? 0);
    const applies = Number(r.applies_above ?? li);
    // update lower for next row if legacy
    lower = ue ?? lower;
    return { lower_inclusive: li, upper_exclusive: ue, base, rate, applies_above: applies };
  });
}

// Core calculator for a list of rows
function calcFromRows(rows, price) {
  const nrows = normaliseRows(rows);
  if (!nrows.length) throw new Error('Empty or invalid schedule');
  // Find the first row where price < upper_exclusive (or upper_exclusive == null)
  const idx = nrows.findIndex(r => r.upper_exclusive == null ? true : price < r.upper_exclusive);
  const i = idx === -1 ? (nrows.length - 1) : idx;
  const row = nrows[i];
  const duty = row.base + row.rate * (price - row.applies_above);
  return Math.round(duty);
}

// Pick a duty mode based on inputs
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

  // 3b) ACT PPR (owner-occupier)
  if (isPpr && st === "ACT" && rules.modes.ppr) {
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

// Public: base+rate directly from a schedule/mode container
function calcDutyFromBrackets(price, scheduleOrMode, rulesForInherits) {
  const rows = resolveModeSchedule(scheduleOrMode, rulesForInherits ? { modes: rulesForInherits.modes } : {});
  return calcFromRows(rows, price);
}

// Main calculator
function calcDuty({ state, price, isLand = false, isFhb = false, isPpr = false, region = 'metro', contractDate }) {
  if (!state) throw new Error('state is required');
  if (typeof price !== 'number') throw new Error('price must be a number');

  const rules = loadRules(state);

  // Guard: block using draft rules
  const status = rules?.meta?.status || 'ready';
  if (status !== 'ready') {
    const st = (rules?.meta?.state || state || '').toString().toUpperCase();
    const fy = rules?.meta?.financial_year || 'unknown FY';
    throw new Error(`Rules for ${st} (${fy}) not ready: ${status}`);
  }

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

  const st = String(state).toUpperCase();

const mode = pickSchedule(rules, { state, price, isLand, isPpr, isFhb, region });
const rows = resolveModeSchedule(mode, rules);
const baseDuty = calcFromRows(rows, price);
  
// JSON-driven FHB (VIC/QLD and any future states using this schema)
const dutyViaJsonFhb = applyFhbConcessions(rules, { price, isPpr, isLand }, baseDuty, mode, rows);
if (dutyViaJsonFhb !== baseDuty) return dutyViaJsonFhb;

// NSW FHBAS (homes + land): full waiver ≤ $800k; linear concession to $1.0m
if (isFhb && st === 'NSW') {
  const zeroCap = 800000;
  const taperEnd = 1000000;
  if (price <= zeroCap) return 0;
  if (price < taperEnd) {
    const t = (price - zeroCap) / (taperEnd - zeroCap); // 0..1
    return Math.round(baseDuty * t);
  }
}
  
// VIC FHB (PPR): ≤$600k = 0; $600k–$750k = linear to full GENERAL duty
if (isFhb && isPpr && st === 'VIC') {
  const start = 600000, end = 750000;
  if (price <= start) return 0;
  if (price < end) {
    // Use VIC GENERAL (established) schedule as the target
    const generalRows = resolveModeSchedule(rules.modes.established, rules);
    const generalDuty = calcFromRows(generalRows, price);
    const t = (price - start) / (end - start); // 0..1
    return Math.round(generalDuty * t);
  }
}

  
// QLD FHB step-rebate against PPR: 700k→0 linearly to 800k→full PPR
if (isFhb && isPpr && st === 'QLD') {
  const start = 700000, end = 800000;
  if (price <= start) return 0;
  if (price >= end) return baseDuty; // full PPR beyond the taper

  // Scale to the PPR duty at the cap (800k), linearly by position in the band
  const capDuty = calcFromRows(rows, end); // PPR schedule at 800k
  const t = (price - start) / (end - start); // 0..1
  return Math.round(capDuty * t);
}

return baseDuty;

}

// Convenience wrapper (kept for your NSW golden tests)
function calcDutyNSW({ price, isLand = false, isFhb = false, contractDate }) {
  return calcDuty({ state: 'NSW', price, isLand, isFhb, isPpr: false, region: 'metro', contractDate });
}
function getStateFeatures(state) {
  const rules = loadRules(state);
  // Prefer explicit flag; fall back to presence of a PPR mode
  const supportsPpr =
    (typeof rules?.meta?.supports_ppr === 'boolean')
      ? rules.meta.supports_ppr
      : !!rules?.modes?.ppr;

  return {
    state: (rules?.meta?.state || String(state).toUpperCase()),
    financial_year: rules?.meta?.financial_year || null,
    supports_ppr: supportsPpr
  };
}

module.exports = {
  calcDuty,
  calcDutyNSW,
  calcDutyFromBrackets,
  getStateFeatures
};

