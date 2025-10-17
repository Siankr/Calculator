const { calcDuty } = require('./duty');

/**
 * Purchasing power solver (v2).
 * Policies:
 *  - no_lmi:        max LVR 80%; no LMI; duty/fees paid from cash.
 *  - allow_lmi:     LVR up to targetLvr (≤0.95); LMI premium capitalised into the loan by default.
 *  - fhb_guarantee: if eligible at price (HGS caps), NO LMI with LVR up to 0.95; otherwise fall back to allow_lmi.
 *
 * Key rules (fixes vs v1):
 *  - Cash feasibility: savings must cover depositPortion + duty + fees + (non-capitalised LMI, if any).
 *  - Borrowing feasibility: compare BP against BASE loan only (exclude capitalised LMI).
 *  - HGS never "caps" price; it only toggles whether LMI applies. If not eligible, fall back to allow_lmi.
 */
function solvePurchasingPower(input) {
  const {
    state, isFhb = false, isPpr = false, isLand = false, region,
    borrowingPower,        // max loan the lender will approve (base loan, excludes any capitalised LMI)
    depositCash = 0,       // cash on hand for settlement
    targetLvr = 0.90,      // desired LVR (0.50..0.95 typical)
    lmi_policy = 'allow_lmi', // 'no_lmi' | 'allow_lmi' | 'fhb_guarantee'
    includeOtherGovtFees = false,
    contractDate
  } = input;

  if (!Number.isFinite(borrowingPower) || borrowingPower <= 0) {
    throw new Error('borrowingPower must be a positive number');
  }
  const otherGovtFees = includeOtherGovtFees ? 3000 : 0;

  // Optional helpers (soft dependency)
  let lmiFn = null;
  try { lmiFn = require('./lmi').calculateLmi; } catch (_) {}
  let hgsFn = null;
  try { hgsFn = require('./hgs').checkHgsEligibility; } catch (_) {}

  // Decide the active mode for a given price (HGS eligibility depends on price)
  function resolveModeAtPrice(price) {
    if (lmi_policy === 'fhb_guarantee' && hgsFn) {
      try {
        const h = hgsFn({ state, price, isFhb: !!isFhb });
        return h && h.eligible ? 'fhb_guarantee' : 'allow_lmi';
      } catch { return 'allow_lmi'; }
    }
    return lmi_policy;
  }

  // Policy LVR cap for a given mode
  function policyLvrCap(mode) {
    if (mode === 'no_lmi') return 0.80;
    // FHG eligible -> no LMI but up to 95%; allow_lmi also up to 95% in v1
    return 0.95;
  }

  // Feasibility check for a candidate price
  function feasible(price) {
    if (!Number.isFinite(price) || price <= 0) return { ok: false };

    // Determine effective mode and LVR used (respect target and policy cap)
    const mode = resolveModeAtPrice(price);
    const cap = policyLvrCap(mode);
    const lvrUsed = Math.min(Math.max(targetLvr, 0.50), cap);

    // Core duty at this price
    const duty = calcDuty({ state, price, isFhb, isPpr, isLand, region, contractDate });

    // Base loan and deposit portion (base loan is what counts toward Borrowing Power)
    const baseLoan = lvrUsed * price;
    const depositPortion = Math.max(0, price - baseLoan);

    // LMI handling
    let lmiPrem = 0;
    let lmiCashPortion = 0;
    let capitalised = false;

    if (mode === 'allow_lmi') {
      // By default in v1 we capitalise the premium (cash portion = 0)
      if (lmiFn) {
        try {
          const res = lmiFn({ price, targetLvr: lvrUsed, capitalise: true });
          lmiPrem = Math.max(0, Number(res?.premium || 0));
          capitalised = !!res?.capitalised || true;
        } catch { lmiPrem = 0; capitalised = true; }
      } else {
        // Minimal fallback (very rough): 2% at ~90% LVR
        lmiPrem = Math.round(price * 0.02);
        capitalised = true;
      }
      lmiCashPortion = capitalised ? 0 : lmiPrem;
    } else {
      // 'no_lmi' or 'fhb_guarantee' (eligible) → no LMI
      lmiPrem = 0;
      lmiCashPortion = 0;
      capitalised = false;
    }

    // --- Feasibility tests ---

    // 1) Cash constraint: savings must cover deposit + duty + fees + any non-capitalised LMI
    const cashNeeded = depositPortion + duty + otherGovtFees + lmiCashPortion;
    const cashOK = depositCash >= cashNeeded;

    // 2) Borrowing constraint: base loan (excluding capitalised LMI) must be ≤ borrowingPower
    const bpOK = baseLoan <= borrowingPower;

    const ok = cashOK && bpOK;

    // For display/explain:
    const effectiveLvr = (baseLoan + (capitalised ? lmiPrem : 0)) / price;

    return {
      ok,
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

  // Binary search for max feasible price
  let lo = 1;
  // Upper bound: BP + cash + a little headroom (duty/fees reduce feasibility; search will pull down)
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
    // Infeasible even at a trivial price
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
        mode: f0.mode || lmi_policy,
        note: 'Infeasible with current inputs'
      }
    };
  }

  // Package a clear explanation at the optimum price
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

module.exports = { solvePurchasingPower };
