const fs = require("fs");
const path = require("path");
const { calcDutyNSW } = require("../src/duty");

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
console.log(`\n${passed}/${tests.length} tests passed`);
process.exit(passed === tests.length ? 0 : 1);
