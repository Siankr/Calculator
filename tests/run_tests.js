const fs = require("fs");
const path = require("path");
const { calcDutyNSW, calcDuty } = require("../src/duty");

// --- NSW golden tests (unchanged) ---
const testsPath = path.join(__dirname, "golden_nsw.json");
if (!fs.existsSync(testsPath)) {
  console.error("Missing tests/golden_nsw.json");
  process.exit(1);
}
const tests = JSON.parse(fs.readFileSync(testsPath, "utf8"));

let passed = 0;
for (const t of tests) {
  const got = calcDutyNSW({
    price: t.price,
    isLand: t.isLand,
    isFhb: t.isFhb,
    contractDate: "2025-10-10"
  });
  const ok = got === t.expectedDuty;
  console.log(`${ok ? "✅" : "❌"} NSW price=${t.price} expected=${t.expectedDuty} got=${got}`);
  if (ok) passed++;
}

// --- VIC PPR sanity checks ---
const dPpr500 = calcDuty({ state: "VIC", price: 500000, isPpr: true });
const dStd500 = calcDuty({ state: "VIC", price: 500000, isPpr: false });
const vicPprLowerAt500 = dPpr500 < dStd500;

const dPpr560 = calcDuty({ state: "VIC", price: 560000, isPpr: true });
const dStd560 = calcDuty({ state: "VIC", price: 560000, isPpr: false });
const vicPprDisabledAbove550 = dPpr560 === dStd560;

// --- QLD checks ---
// General (non-home) boundary at $540k: should equal 17,325
const qldGen540 = calcDuty({ state: "QLD", price: 540000, isPpr: false });
const qldGen540OK = qldGen540 === 17325;

// PPR (home concession) at $350k: 1% = $3,500
const qldPpr350 = calcDuty({ state: "QLD", price: 350000, isPpr: true });
const qldPpr350OK = qldPpr350 === 3500;

// FHB (established, owner-occ): full exemption ≤ $700k; step rebate to $800k
const qldFhb700 = calcDuty({ state: "QLD", price: 700000, isPpr: true, isFhb: true }); // expect 0
const qldFhb710 = calcDuty({ state: "QLD", price: 710000, isPpr: true, isFhb: true }); // expect 2,185
const qldFhb750 = calcDuty({ state: "QLD", price: 750000, isPpr: true, isFhb: true }); // expect 10,925
const qldFhb800 = calcDuty({ state: "QLD", price: 800000, isPpr: true, isFhb: true }); // expect PPR duty 21,850

const qldFhbOK =
  qldFhb700 === 0 &&
  qldFhb710 === 2185 &&
  qldFhb750 === 10925 &&
  qldFhb800 === 21850;

// --- Summary & exit ---
const okAll =
  passed === tests.length &&
  vicPprLowerAt500 &&
  vicPprDisabledAbove550 &&
  qldGen540OK &&
  qldPpr350OK &&
  qldFhbOK;

console.log(`\n${passed}/${tests.length} NSW tests passed`);
console.log(`VIC PPR @ $500k lower than non-PPR: ${vicPprLowerAt500 ? "OK" : "FAIL"} (PPR=${dPpr500}, Std=${dStd500})`);
console.log(`VIC PPR disabled above $550k: ${vicPprDisabledAbove550 ? "OK" : "FAIL"} (PPR@560k=${dPpr560}, Std@560k=${dStd560})`);
console.log(`QLD general @ $540k = 17325: ${qldGen540OK ? "OK" : "FAIL"} (got ${qldGen540})`);
console.log(`QLD PPR @ $350k = 3500: ${qldPpr350OK ? "OK" : "FAIL"} (got ${qldPpr350})`);
console.log(`QLD FHB 700k→0, 710k→2185, 750k→10925, 800k→21850: ${qldFhbOK ? "OK" : "FAIL"} (got ${qldFhb700}, ${qldFhb710}, ${qldFhb750}, ${qldFhb800})`);

process.exit(okAll ? 0 : 1);
