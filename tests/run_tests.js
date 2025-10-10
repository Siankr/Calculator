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
  console.log(`${ok ? "✅" : "❌"} price=${t.price} expected=${t.expectedDuty} got=${got}`);
  if (ok) passed++;
}

// --- VIC PPR sanity checks ---
const dPpr500 = calcDuty({ state: "VIC", price: 500000, isPpr: true });
const dStd500 = calcDuty({ state: "VIC", price: 500000, isPpr: false });
const vicPprLowerAt500 = dPpr500 < dStd500;

const dPpr560 = calcDuty({ state: "VIC", price: 560000, isPpr: true });
const dStd560 = calcDuty({ state: "VIC", price: 560000, isPpr: false });
const vicPprDisabledAbove550 = dPpr560 === dStd560;

// --- Summary & exit code ---
const okAll = passed === tests.length && vicPprLowerAt500 && vicPprDisabledAbove550;

console.log(`\n${passed}/${tests.length} NSW tests passed`);
console.log(`VIC PPR @ $500k lower than non-PPR: ${vicPprLowerAt500 ? "OK" : "FAIL"} (PPR=${dPpr500}, Std=${dStd500})`);
console.log(`VIC PPR disabled above $550k: ${vicPprDisabledAbove550 ? "OK" : "FAIL"} (PPR@560k=${dPpr560}, Std@560k=${dStd560})`);

process.exit(okAll ? 0 : 1);
