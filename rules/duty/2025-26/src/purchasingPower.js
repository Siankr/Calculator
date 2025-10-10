const { calcDutyNSW } = require("./duty");
const { calcLmi } = require("./lmi");
const { hgsEligible } = require("./hgs");

function solveMaxPrice({
  state="NSW",
  isLand=false,
  isFhb=false,
  region="capital_and_regional_centres",
  contractDate="2025-10-10",
  borrowingPower,   // B
  depositCash,      // D
  targetLvr,        // 0.80..0.95
  lmiPolicy,        // "no_lmi" | "allow_lmi" | "fhb_guarantee"
  includeOtherGovtFees=true
}) {
  const fees = includeOtherGovtFees ? 3000 : 0;

  // mode
  let maxLvr = targetLvr;
  let lmiAllowed = lmiPolicy === "allow_lmi";
  let lmiForcedZero = false;

  // HGS path (LMI-free up to 95% if eligible)
  if (lmiPolicy === "fhb_guarantee" && isFhb) {
    maxLvr = Math.min(0.95, targetLvr);
    lmiAllowed = false;
    lmiForcedZero = true;
  }

  if (lmiPolicy === "no_lmi") {
    maxLvr = Math.min(maxLvr, 0.80);
    lmiAllowed = false;
  }

  // initial guess
  let p = (borrowingPower + depositCash - fees) / (1 - maxLvr);
  if (!isFinite(p) || p <= 0) p = borrowingPower / maxLvr;

  for (let iter = 0; iter < 12; iter++) {
    const duty = calcDutyNSW({ price: p, isLand, isFhb, contractDate });
    const upfront = duty + fees;

    // Loan suggested by LVR & constrained by borrowing power
    let loanBase = Math.min(borrowingPower, maxLvr * p);
    let lvr = loanBase / p;

    // HGS eligibility check if selected
    if (lmiForcedZero) {
      const eligible = hgsEligible({ state, region, price: p, contractDate });
      if (!eligible) {
        // fallback: if not eligible, behave like allow_lmi (or no_lmi if target <=0.80)
        lmiForcedZero = false;
        lmiAllowed = maxLvr > 0.80;
      }
    }

    // LMI calculation (capitalised) if allowed and above 80%
    let lmi = 0;
    if (!lmiForcedZero && lmiAllowed && lvr > 0.80) {
      // small inner fixed-point to ensure (loanBase + LMI) <= borrowingPower
      for (let k = 0; k < 5; k++) {
        lmi = calcLmi({ loan: loanBase, lvr });
        if (!isFinite(lmi)) { lmi = 0; break; }
        const totalLoan = loanBase + lmi;
        if (totalLoan <= borrowingPower + 1) break;
        // reduce loanBase so totalLoan fits B
        loanBase = Math.max(0, borrowingPower - lmi);
        lvr = loanBase / p;
        if (lvr <= 0.80) { lmi = 0; break; }
      }
    }

    // Cash constraint: deposit funds upfront costs (LMI is capitalised)
    const p_cash = (borrowingPower + depositCash - upfront) / maxLvr;
    const p_loan = (borrowingPower - lmi) / maxLvr; // loan can include capitalised LMI
    const p_new = Math.min(p_cash, p_loan);

    if (!isFinite(p_new) || p_new <= 0) return 0;
    if (Math.abs(p_new - p) < 1) {
      return Math.round(p_new);
    }
    p = p_new;
  }
  return Math.round(p);
}

module.exports = { solveMaxPrice };
