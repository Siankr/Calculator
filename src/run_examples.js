const { solveMaxPrice } = require("./purchasingPower");
const { calcDutyNSW } = require("./duty");

console.log("Duty on $900,000 (NSW, non-FHB):", calcDutyNSW({ price: 900000, isFhb: false }));
console.log("Duty on $800,000 (NSW, FHB home):", calcDutyNSW({ price: 800000, isFhb: true }));

const scenario = {
  state: 'NSW',           // <-- required
  borrowingPower: 700000,
  depositCash: 180000,
  targetLvr: 0.90,
  lmiPolicy: "allow_lmi", // try "no_lmi" or "fhb_guarantee"
  isFhb: true,
  isPpr: true,
  isLand: false,
  includeOtherGovtFees: true,
  contractDate: "2025-10-10",  // optional; helps version selection if you use it
  region: "capital_and_regional_centres"
};
console.log("Max price (scenario):", solveMaxPrice(scenario));
