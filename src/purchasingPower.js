// src/purchasingPower.js
const { calcDuty } = require('./duty');

let lmiFn = null;
try { lmiFn = require('./lmi').calculateLmi; } catch (_) {}
let hgsFn = null;
try { hgsFn = require('./hgs').checkHgsEligibility; } catch (_) {}

/**
 * Purchasing power solver (v2).
 * Policies:
 *  - no_lmi:        max LVR 80%; no LMI; duty/fees paid from cash.
 *  - allow_lmi:     LVR up to targetLvr (≤0.95); LMI premium capitalised (default).
 *  - fhb_guarantee: if eligible at price (HGS caps), NO LMI (up to 95%); else fall back to allow_lmi.
 *
 * Rules:
 *  - Cash: savings ≥ depositPortion + duty + fees + (non-cap LMI).
 *  - Borrowing: compare BP against BASE loan only (exclude capitalised LMI).
 *  - HGS never caps price; it only toggles LMI on/off at that price.
 */
function solvePurchasingPower(input) {
  const {
    state, isFhb = false, isPpr = false, isLand = false, region,
    borrowingPower,
    depositCash = 0,
    targetLvr = 0.90,
    lmi_policy = 'allow_lmi', // 'no_lmi' | 'allow_lmi' | 'fhb_guarantee'
    includeOtherGovtFees = false,
    contractDate
  } = input;

  if (!Number.isFinite(borrowingPower) || borrowingPower <= 0) {
    throw new Error('borrowingPower must be a positive number');
  }

  const otherGovtFees = includeOtherGovtFees ? 3000 : 0;

  function resolveModeAtPrice(price) {
    if (lmi_policy === 'fhb_guarantee' && hgsFn) {
      try {
        const h = hgsFn({ state, price, isFhb: !!isFhb });
        return h && h.eligible ? 'fhb_guarantee' : 'allow_lmi';
      } catch { return 'allow_lmi'; }
    }
    return lmi_policy;
  }

  function policyLvrCap(mode) {
    if (mode === 'no_lmi') return 0.80;
    return 0.95; // allow_lmi or fhb_guarantee (eligible) up to 95%
  }

  function feasible(price) {
    if (!Number.isFinite(price) || price <= 0) return { ok: false };

    const mode = resolveModeAtPrice(price);
    const cap = policyLvrCap(mode);
    const lvrUsed = Math.min(Math.max(targetLvr, 0.50), cap);

    const duty = calcDuty({ state, price, isFhb, isPpr, isLand, region, contractDate });

    const baseLoan = lvrUsed * price;                 // what servicing/BP is tested against
    const depositPortion = Math.max(0, price - baseLoan);

    // LMI
    let lmiPrem = 0;
    let lmiCashPortion = 0;
    let capitalised = false;

    if (mode === 'allow_lmi') {
      if (lmiFn) {
        try {
          const res = lmiFn({ price, targetLvr: lvrUsed, capitalise: true });
          lmiPrem = Math.max(0, Number(res?.premium || 0));
          capitalised = res?.capitalised !== false; // default true
        } catch { lmiPrem = 0; capitalised = true; }
      } else {
        lmiPrem = Math.round(price * 0.02); // coarse fallback
        capitalised = true;
      }
      lmiCashPortion = capitalised ? 0 : lmiPrem;
    } else {
      // no_lmi or fhb_guarantee (eligible)
      lmiPrem = 0;
      lmiCashPortion = 0;
      capitalised = false;
    }

    // Constraints
    const cashNeeded = depositPortion + duty + otherGovtFees + lmiCashPortion;
    const cashOK = depositCash >= cashNeeded;

    const bpOK = baseLoan <= borrowingPower;

    const effectiveLvr = (baseLoan + (capitalised ? lmiPrem : 0)) / price;

    return {
      ok: cashOK && bpOK,
      duty,
      otherGovtFees,
      depositPortion,
      lmiPrem,
      lmiCashPortion,
      capitalised,
      baseLoan,
      loanWithCapLmi: baseLoan + (capitalised ? lmiPrem : 0),
      cashNeeded,
      effectiveLvr,
      mode
    };
  }

  // Binary search
  let lo = 1;
  let hi = Math.max(1, Math.floor((borrowingPower + depositCash) * 1.2));
  let best = { price: 0, proof: null };

  for (let i = 0; i < 42; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const f = feasible(mid);
    if (f.ok) {
      best = { price: mid, proof: f };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
    if (hi < lo) break;
  }

  if (!best.proof) {
    const f0 = feasible(1) || {};
    return {
      maxPrice: 0,
      explain: {
        borrowingPower,
        depositCash,
        dutyAtMax: f0.duty || 0,
        otherGovtFees,
        lmiPremiumAtMax: f0.lmiPrem || 0,
        lmiCashPortionAtMax: f0.lmiCashPortion || 0,
        cashNeededAtMax: f0.cashNeeded || 0,
        loanBaseAtMax: f0.baseLoan || 0,
        loanWithCapLmiAtMax: f0.loanWithCapLmi || 0,
        lvr_effective: f0.effectiveLvr || Math.min(targetLvr, 0.95),
        mode: f0.mode || resolveModeAtPrice(1),
        note: 'Infeasible with current inputs'
      }
    };
  }

  const p = best.proof;
  return {
    maxPrice: best.price,
    explain: {
      borrowingPower,
      depositCash,
      dutyAtMax: p.duty,
      otherGovtFees,
      depositRequiredAtMax: p.depositPortion,
      lmiPremiumAtMax: p.lmiPrem,
      lmiCashPortionAtMax: p.lmiCashPortion,
      cashNeededAtMax: p.cashNeeded,
      loanBaseAtMax: p.baseLoan,
      loanWithCapLmiAtMax: p.loanWithCapLmi,
      lvr_effective: p.effectiveLvr,
      mode: p.mode
    }
  };
}

// ---- exports (place at the very end) ----

// Backwards-compat: some callers expect `solveMaxPrice`.
function solveMaxPrice(input) {
  return solvePurchasingPower(input);
}

module.exports = {
  solvePurchasingPower,
  solveMaxPrice,
  default: solvePurchasingPower,
};
