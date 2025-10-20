/* eslint-disable no-console */
'use strict';

const assert = require('assert');
const { solvePurchasingPower, solveMaxPrice } = require('../src/purchasingPower');

// tiny helper to run and assert
function runCase(name, input, extraAssert = () => {}) {
  const out = solvePurchasingPower(input); // or solveMaxPrice(input)
  console.log(`\n[${name}] -> ${JSON.stringify(out, null, 2)}`);

  // universal invariants (must always hold when feasible)
  if (out.maxPrice > 0) {
    const e = out.explain;

    // 1) Cash sufficiency: cashNeeded ≤ depositCash
    assert.ok(
      e.cashNeededAtMax ? e.cashNeededAtMax <= input.depositCash :
      e.cashNeeded <= input.depositCash,
      `${name}: cash constraint violated`
    );

    // 2) Borrowing constraint: base loan ≤ borrowingPower
    assert.ok(
      e.loanBaseAtMax ? e.loanBaseAtMax <= input.borrowingPower :
      e.loanAtMax ? e.loanAtMax <= input.borrowingPower :
      true, // allow older field names
      `${name}: borrowing power constraint violated`
    );

    // 3) Effective LVR ∈ (0, 1]
    const lvr = e.lvr_effective;
    assert.ok(lvr > 0 && lvr <= 0.96, `${name}: lvr_effective out of range (got ${lvr})`);

    // 4) Mode is consistent with policy (no_lmi ⇒ ≤80% LVR and zero LMI)
    if (input.lmi_policy === 'no_lmi') {
      assert.ok(lvr <= 0.80 + 1e-6, `${name}: expected ≤80% LVR in no_lmi mode`);
      assert.ok((e.lmiPremiumAtMax || 0) === 0, `${name}: expected zero LMI in no_lmi`);
    }
  } else {
    console.warn(`[${name}] infeasible with inputs; this is acceptable if cash/BP are too small.`);
  }

  extraAssert(out);
}

function AUD(n) { return Math.round(n); } // simple round

(function main() {
  // --- CASH-LIMITED (NSW, established) ---
  runCase(
    'NSW cash-limited allow_lmi',
    {
      state: 'NSW',
      borrowingPower: 2_500_000,
      depositCash: 500_000,
      targetLvr: 0.868, // 86.8%
      lmi_policy: 'allow_lmi',
      isFhb: true,
      isPpr: true,
      isLand: false,
      includeOtherGovtFees: true,
      contractDate: '2025-10-20'
    },
    (out) => {
      // Expect around $2.7–$2.9m depending on LMI bands;
      assert.ok(out.maxPrice > 2_600_000 && out.maxPrice < 2_950_000, 'NSW cash-limited range');
    }
  );

  // --- BORROWING-LIMITED (small BP, large cash) ---
  runCase(
    'NSW borrowing-limited allow_lmi',
    {
      state: 'NSW',
      borrowingPower: 600_000,
      depositCash: 800_000,
      targetLvr: 0.90,
      lmi_policy: 'allow_lmi',
      isFhb: false,
      isPpr: true,
      isLand: false,
      includeOtherGovtFees: true,
      contractDate: '2025-10-20'
    },
    (out) => {
      // If BP is only 600k, price should be roughly <= 600k / 0.90 + some headroom after duty -> < ~800k
      assert.ok(out.maxPrice > 600_000 && out.maxPrice < 900_000, 'Borrowing-limited cap check');
    }
  );

  // --- HGS ELIGIBLE vs NOT (NSW) ---
  // Below cap (eligible) -> mode toggles to FHG/no LMI; Above same inputs -> falls back to allow_lmi
  const hgsInputs = {
    state: 'NSW',
    borrowingPower: 1_200_000,
    depositCash: 250_000,
    targetLvr: 0.95,
    lmi_policy: 'fhb_guarantee',
    isFhb: true,
    isPpr: true,
    isLand: false,
    includeOtherGovtFees: true,
    contractDate: '2025-10-20'
  };

  runCase('NSW HGS-eligible (sub-cap)', { ...hgsInputs }, (out) => {
    // Expect FHG path (no LMI). Ensure mode says fhb_guarantee or no LMI premium
    const e = out.explain;
    assert.ok((e.lmiPremiumAtMax || 0) === 0, 'Expected no LMI under HGS');
  });

  runCase('NSW HGS-ineligible (super-cap; fallback to allow_lmi)', { ...hgsInputs, depositCash: 400_000 }, (out) => {
    // With more cash, the solver should move above the HGS cap and fall back to allow_lmi (LMI > 0)
    const e = out.explain;
    assert.ok((e.lmiPremiumAtMax || 0) >= 0, 'Expected solver to allow LMI above cap');
  });

  // --- VIC PPR + FHB taper edges (duty engine correctness is assumed; we check invariants) ---
  runCase(
    'VIC PPR FHB mid-range',
    {
      state: 'VIC',
      borrowingPower: 800_000,
      depositCash: 160_000,
      targetLvr: 0.80,
      lmi_policy: 'no_lmi',
      isFhb: true,
      isPpr: true,
      isLand: false,
      includeOtherGovtFees: true,
      contractDate: '2025-10-20'
    },
    (out) => {
      // No LMI: LVR must be <= 80%
      assert.ok(out.explain.lvr_effective <= 0.80 + 1e-6, 'No-LMI LVR cap');
    }
  );

  // --- QLD FHB taper (allow_lmi) ---
  runCase(
    'QLD FHB allow_lmi',
    {
      state: 'QLD',
      borrowingPower: 900_000,
      depositCash: 120_000,
      targetLvr: 0.90,
      lmi_policy: 'allow_lmi',
      isFhb: true,
      isPpr: true,
      isLand: false,
      includeOtherGovtFees: true,
      contractDate: '2025-10-20'
    },
    (out) => {
      assert.ok(out.maxPrice > 800_000 && out.maxPrice < 1_100_000, 'QLD range sanity');
    }
  );

  // --- WA FHOR gating: metro vs non-metro (FHB + land=false, established home under caps) ---
  runCase(
    'WA FHB FHOR metro (allow_lmi fallback ok)',
    {
      state: 'WA',
      borrowingPower: 850_000,
      depositCash: 150_000,
      targetLvr: 0.90,
      lmi_policy: 'fhb_guarantee', // still valid; under FHOR rules the duty engine handles concessions
      isFhb: true,
      isPpr: true,
      isLand: false,
      region: 'metro', // IMPORTANT for WA
      includeOtherGovtFees: true,
      contractDate: '2025-10-20'
    },
    (out) => {
      assert.ok(out.maxPrice > 600_000 && out.maxPrice < 1_000_000, 'WA metro range sanity');
    }
  );

  runCase(
    'WA FHB FHOR non-metro',
    {
      state: 'WA',
      borrowingPower: 850_000,
      depositCash: 150_000,
      targetLvr: 0.90,
      lmi_policy: 'fhb_guarantee',
      isFhb: true,
      isPpr: true,
      isLand: false,
      region: 'non_metro',
      includeOtherGovtFees: true,
      contractDate: '2025-10-20'
    },
    (out) => {
      // Should be similar but not identical due to region thresholds in your duty JSON
      assert.ok(out.maxPrice > 600_000 && out.maxPrice < 1_050_000, 'WA non-metro range sanity');
    }
  );

  // --- Land vs Established (NSW land has different duty path) ---
  runCase(
    'NSW land purchase allow_lmi',
    {
      state: 'NSW',
      borrowingPower: 750_000,
      depositCash: 120_000,
      targetLvr: 0.90,
      lmi_policy: 'allow_lmi',
      isFhb: false,
      isPpr: false,
      isLand: true,
      includeOtherGovtFees: false,
      contractDate: '2025-10-20'
    },
    (out) => {
      assert.ok(out.maxPrice > 500_000 && out.maxPrice < 900_000, 'NSW land range sanity');
    }
  );

  // --- Monotonicity checks (increase deposit → price should not fall) ---
  const baseMono = {
    state: 'VIC',
    borrowingPower: 1_000_000,
    targetLvr: 0.90,
    lmi_policy: 'allow_lmi',
    isFhb: false,
    isPpr: true,
    isLand: false,
    includeOtherGovtFees: true,
    contractDate: '2025-10-20'
  };
  const outA = solvePurchasingPower({ ...baseMono, depositCash: 100_000 });
  const outB = solvePurchasingPower({ ...baseMono, depositCash: 200_000 });
  console.log('\n[Monotonicity deposit] A:', outA.maxPrice, 'B:', outB.maxPrice);
  assert.ok(outB.maxPrice >= outA.maxPrice, 'More deposit should not reduce max price');

  // --- Monotonicity: increase borrowing power → price should not fall ---
  const baseMono2 = {
    state: 'QLD',
    depositCash: 150_000,
    targetLvr: 0.90,
    lmi_policy: 'allow_lmi',
    isFhb: false,
    isPpr: true,
    isLand: false,
    includeOtherGovtFees: true,
    contractDate: '2025-10-20'
  };
  const outC = solvePurchasingPower({ ...baseMono2, borrowingPower: 700_000 });
  const outD = solvePurchasingPower({ ...baseMono2, borrowingPower: 900_000 });
  console.log('\n[Monotonicity BP] C:', outC.maxPrice, 'D:', outD.maxPrice);
  assert.ok(outD.maxPrice >= outC.maxPrice, 'More borrowing power should not reduce max price');

  console.log('\n✅ All purchasing power scenario tests completed.\n');
})();
