const { calcDuty } = require('./duty');

/**
 * Purchasing power solver.
 * Policies:
 *  - no_lmi:   max LVR 80%; no LMI; duty/fees paid from cash.
 *  - allow_lmi: LVR up to targetLvr (≤0.95); LMI premium capitalised into the loan.
 *  - fhb_guarantee: if eligible (HGS caps), allow 95% with NO LMI; else fall back to allow_lmi.
 */
function solvePurchasingPower(input) {
  const {
    state, isFhb = false, isPpr = false, isLand = false, region,
    borrowingPower,        // max loan the lender will approve
    depositCash = 0,       // cash on hand
    targetLvr = 0.90,      // desired LVR (0.5..0.95)
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

  // Determine policy path
  const hgsInfo = (() => {
    if (lmi_policy !== 'fhb_guarantee') return { eligible: false, cap: null };
    if (!hgsFn) return { eligible: false, cap: null };
    try { return hgsFn({ state, price: 0, isFhb: !!isFhb }); } catch { return { eligible: false, cap: null }; }
  })();

  // Effective LVR cap by policy
  const maxLvrBase =
    lmi_policy === 'no_lmi' ? 0.80 :
    lmi_policy === 'fhb_guarantee' && hgsInfo.eligible ? 0.95 :
    Math.min(0.95, Math.max(0.50, targetLvr));

  // Feasibility check for a candidate price
  function feasible(price) {
    if (!Number.isFinite(price) || price <= 0) return { ok: false };

    // Enforce HGS price cap if using HGS
    if (lmi_policy === 'fhb_guarantee' && hgsFn) {
      try {
        const h = hgsFn({ state, price, isFhb: !!isFhb });
        if (!h.eligible) return { ok: false, reason: 'hgs_cap' };
      } catch { /* ignore */ }
    }

    // Base duty at this price
    const duty = calcDuty({ state, price, isFhb, isPpr, isLand, region, contractDate });

    // Deposit required by LVR cap (exclude any LMI premium)
    const reqDeposit = Math.max(0, price - maxLvrBase * price);

    // LMI premium (only if policy allows LMI and not using HGS)
    let lmiPrem = 0;
    let lvrEff = (price - reqDeposit) / price; // loan/price, excl. any capitalised premium

    if (lmi_policy === 'allow_lmi' && lmiFn) {
      try {
        const res = lmiFn({ price, targetLvr: maxLvrBase, capitalise: true });
        lmiPrem = Math.max(0, Number(res?.premium || 0));
      } catch { lmiPrem = 0; }
    }

    // Cash constraint: cash must cover duty + other fees + deposit
    const cashNeeded = duty + otherGovtFees + reqDeposit;
    const cashOK = depositCash >= cashNeeded;

    // Borrowing constraint: total loan including capitalised LMI must be ≤ borrowingPower
    const loanPrincipalExclLmi = price - reqDeposit;    // base loan
    const loanPrincipalInclLmi = loanPrincipalExclLmi + lmiPrem; // capitalised premium
    const loanOK = loanPrincipalInclLmi <= borrowingPower;

    const ok = cashOK && loanOK;
    return {
      ok,
      duty,
      otherGovtFees,
      reqDeposit,
      lmiPrem,
      lvrEff,
      loanPrincipalExclLmi,
      loanPrincipalInclLmi,
      cashNeeded
    };
  }

  // Binary search for max feasible price
  let lo = 1;
  // A generous high bound: borrowing + cash + 20% headroom
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
    // Infeasible even at very low price
    const f0 = feasible(1);
    return {
      maxPrice: 0,
      explain: {
        borrowingPower,
        depositCash,
        dutyAtMax: f0?.duty ?? 0,
        otherGovtFees,
        lmiPremiumAtMax: f0?.lmiPrem ?? 0,
        cashNeededAtMax: f0?.cashNeeded ?? 0,
        loanAtMax: f0?.loanPrincipalInclLmi ?? 0,
        lvr_effective: f0?.lvrEff ?? maxLvrBase,
        mode: lmi_policy,
        note: 'Infeasible with current inputs'
      }
    };
  }

  // Package nice explanation at the optimum price
  const p = best.proof;
  return {
    maxPrice: best.price,
    explain: {
      borrowingPower,
      depositCash,
      dutyAtMax: p.duty,
      otherGovtFees,
      depositRequiredAtMax: p.reqDeposit,
      lmiPremiumAtMax: p.lmiPrem,
      cashNeededAtMax: p.cashNeeded,
      loanAtMax: p.loanPrincipalInclLmi,
      loanExclLmiAtMax: p.loanPrincipalExclLmi,
      lvr_effective: p.lvrEff,
      mode: lmi_policy
    }
  };
}

module.exports = { solvePurchasingPower };
