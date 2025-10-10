const fs = require("fs");
const path = require("path");
const { calcDutyNSW } = require("../src/duty");

const tests = JSON.parse(fs.readFileSync(path.join(__dirname, "golden_nsw.json"), "utf8"));

let passed = 0;
for (const t of tests) {
  const got = calcDutyNSW({ price: t.price, isLand: t.isLand, isFhb: t.isFhb, contractDate: "2025-10-10" });
  const ok = got === t.expectedDuty;
  console.log(`${ok ? "✅" : "❌"} price=${t.price} expected=${t.expectedDuty} got=${got}`);
  if (ok) passed++;
}
console.log(`\n${passed}/${tests.length} tests passed`);
process.exit(passed === tests.length ? 0 : 1);
