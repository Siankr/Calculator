// src/purchasingPower.js
'use strict';

const { calcDuty } = require('./duty');

// Soft deps (guarded requires)
let lmiFn = null;
try { lmiFn = require('./lmi').calculateLmi; } catch (e) {}
let hgsFn = null;
try { hgsFn = require('./hgs').checkHgsEligibility; } catch (e) {}

/**
 * Purchasing power solver (v2, compat-safe).
 *
 * Policies:
 *  - 'no_lmi'        → max LVR 80%; no LMI; duty/fees from cash.
 *  - 'allow_lmi'     → LVR up to targetLvr (≤ 0.95 by policy); LMI premium capitalised (default).
 *  - 'fhb_guarantee' → if HGS-eligible AT PRICE: no LMI up to 95%; else falls back to 'allow_lmi'.
 *
 * Rules:
 *  - Cash feasibility: savings ≥ depositPortion + duty + fees + (non-capitalised LMI).
 *  - Borrowing feasibility: compare BP against BASE loan ONLY (exclude capitalised LMI).
 *  - HGS does NOT cap price; it only toggles LMI on/off at that price.
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
  } = input || {};

  if (!Number.isFinite(borrowingPower) || borrowingPower <= 0) {
    throw new Error('borrowingPower must be a positive number');
  }

  // Normalise and validate state early (prevents deep errors inside calcDuty)
  var stateCode = typeof state === 'string' ? state.trim().toUpperCase() : '';
  var validStates = { NSW:1, VIC:1, QLD:1, WA:1, SA:1, TAS:1, ACT:1, NT:1 };
  if (!validStates[stateCode]) {
    throw new Error('state is required (one of NSW, VIC, QLD, WA, SA, TAS, ACT, NT)');
  }

  var otherGovtFees = includeOtherGovtFees ? 3000 : 0;

  function resolveModeAtPrice(price) {
    if (lmi_policy === 'fhb_guarantee' && hgsFn) {
      try {
        var h = hgsFn({ state: stateCode, price: price, isFhb: !!isFhb });
        return (h && h.eligible) ? 'fhb_guarantee' : 'allow_lmi';
      } catch (e) {
        return 'allow_lmi';
      }
    }
    return lmi_policy;
  }

  function policyLvrCap(mode) {
    if (mode === 'no_lmi') return 0.80;
    // allow_lmi or fhb_guarantee (eligible) up to 95%
    return 0.95;
  }

  function feasible(price) {
    if (!Number.isFinite(price) || price <= 0) return { ok: false };

    var mode = resolveModeAtPrice(price);
    var cap = policyLvrCap(mode);
    var lvrUsed = Math.min(Math.max(targetLvr, 0.50), cap);

    // Duty at this price and input flags
    var duty = calcDuty({
      state: stateCode,
      price: price,
      isFhb: isFhb,
      isPpr: isPpr,
      isLand: isLand,
      region: region,
      contractDate: contractDate
    });

    // Base loan (what servicing/BP is tested against) and deposit portion
    var baseLoan = lvrUsed * price;
    var depositPortion = Math.max(0, price - baseLoan);

    // LMI handling
    var lmiPrem = 0;
    var lmiCashPortion = 0;
    var capitalised = false;

    if (mode === 'allow_lmi') {
      if (lmiFn) {
        try {
          var res = lmiFn({ price: price, targetLvr: lvrUsed, capitalise: true });
          var resPrem = res && typeof res.premium === 'number' ? res.premium : 0;
          lmiPrem = Math.max(0, Number(resPrem));
          var resCap = res && typeof res.capitalised !== 'undefined' ? !!res.capitalised : true;
          capitalised = resCap;
        } catch (e) {
          lmiPrem = Math.round(price * 0.02); // coarse fallback
          capitalised = true;
        }
      } else {
        lmiPrem = Math.round(price * 0.02);   // coarse fallback if no lmi.js yet
        capitalised = true;
      }
      lmiCashPortion = capitalised ? 0 : lmiPrem;
    } else {
      // 'no_lmi' or 'fhb_guarantee' (eligible)
      lmiPrem = 0;
      lmiCashPortion = 0;
      capitalised = false;
    }

    // Constraints
    var cashNeeded = depositPortion + duty + otherGovtFees + lmiCashPortion; // cash at settlement
    var cashOK = depositCash >= cashNeeded;

    var bpOK = baseLoan <= borrowingPower; // BP compared to base loan only (exclude cap LMI)

    var effectiveLvr = (baseLoan + (capitalised ? lmiPrem : 0)) / price;

    return {
      ok: (cashOK && bpOK),
      duty: duty,
      otherGovtFees: otherGovtFees,
      depositPortion: depositPortion,
      lmiPrem: lmiPrem,
      lmiCashPortion: lmiCashPortion,
      capitalised: capitalised,
      baseLoan: baseLoan,
      loanWithCapLmi: baseLoan + (capitalised ? lmiPrem : 0),
      cashNeeded: cashNeeded,
      effectiveLvr: effectiveLvr,
      mode: mode
    };
  }

  // Binary search for max feasible price
  var lo = 1;
  var hi = Math.max(1, Math.floor((borrowingPower + depositCash) * 1.2));
  var best = { price: 0, proof: null };

  for (var i = 0; i < 42; i++) {
    var mid = Math.floor((lo + hi) / 2);
    var f = feasible(mid);
    if (f.ok) {
      best = { price: mid, proof: f };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
    if (hi < lo) break;
  }

  if (!best.proof) {
    var f0 = feasible(1) || {};
    return {
      maxPrice: 0,
      explain: {
        borrowingPower: borrowingPower,
        depositCash: depositCash,
        dutyAtMax: f0.duty || 0,
        otherGovtFees: otherGovtFees,
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

  var p = best.proof;
  return {
    maxPrice: best.price,
    explain: {
      borrowingPower: borrowingPower,
      depositCash: depositCash,
      dutyAtMax: p.duty,
      otherGovtFees: otherGovtFees,
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
  solvePurchasingPower: solvePurchasingPower,
  solveMaxPrice: solveMaxPrice,
  default: solvePurchasingPower
};
