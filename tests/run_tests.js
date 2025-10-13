const fs = require("fs");
const path = require("path");
const { calcDutyNSW, calcDuty } = require("../src/duty");
const { loadStateRules, calcDutyFromBrackets } = require('../src/duty');

function test(name, fn) {
  try { fn(); console.log(`✅ ${name}`); }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); process.exit(1); }
}
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
const qldGen540 = calcDuty({ state: "QLD", price: 540000, isPpr: false });
const qldGen540OK = qldGen540 === 17325;

const qldPpr350 = calcDuty({ state: "QLD", price: 350000, isPpr: true });
const qldPpr350OK = qldPpr350 === 3500;

const qldFhb700 = calcDuty({ state: "QLD", price: 700000, isPpr: true, isFhb: true }); // expect 0
const qldFhb710 = calcDuty({ state: "QLD", price: 710000, isPpr: true, isFhb: true }); // expect 2,185
const qldFhb750 = calcDuty({ state: "QLD", price: 750000, isPpr: true, isFhb: true }); // expect 10,925
const qldFhb800 = calcDuty({ state: "QLD", price: 800000, isPpr: true, isFhb: true }); // expect 21,850
const qldFhbOK =
  qldFhb700 === 0 &&
  qldFhb710 === 2185 &&
  qldFhb750 === 10925 &&
  qldFhb800 === 21850;

// --- WA checks ---
// General: boundary sanity (725k base is 28,453 in the rules; we’ll test a simpler interior point)
const waGen360 = calcDuty({ state: "WA", price: 360000 }); // base for next tier = 11,115
const waGen360OK = waGen360 === 11115;

// FHOR (homes) — Metro/Peel (cap 700k): 0 ≤500k; 13.63% over 500k to 700k
const waMetro500 = calcDuty({ state: "WA", price: 500000, isFhb: true, region: "metro" }); // 0
const waMetro600 = calcDuty({ state: "WA", price: 600000, isFhb: true, region: "metro" }); // (100k)*0.1363 = 13,630
const waMetro700 = calcDuty({ state: "WA", price: 700000, isFhb: true, region: "metro" }); // (200k)*0.1363 = 27,260
// Above cap should fall back to established (PPR=established for WA)
const waMetro720Fhb = calcDuty({ state: "WA", price: 720000, isFhb: true, region: "metro" });
const waMetro720Std = calcDuty({ state: "WA", price: 720000, isFhb: false });
const waMetroOK = (waMetro500 === 0) && (waMetro600 === 13630) && (waMetro700 === 27260) && (waMetro720Fhb === waMetro720Std);

// FHOR (homes) — Outside Metro (cap 750k): 0 ≤500k; 11.89% over 500k to 750k
const waNonMetro500 = calcDuty({ state: "WA", price: 500000, isFhb: true, region: "non_metro" }); // 0
const waNonMetro600 = calcDuty({ state: "WA", price: 600000, isFhb: true, region: "non_metro" }); // (100k)*0.1189 = 11,890
const waNonMetro750 = calcDuty({ state: "WA", price: 750000, isFhb: true, region: "non_metro" }); // (250k)*0.1189 = 29,725
const waNonMetro760Fhb = calcDuty({ state: "WA", price: 760000, isFhb: true, region: "non_metro" });
const waNonMetro760Std = calcDuty({ state: "WA", price: 760000, isFhb: false });
const waNonMetroOK = (waNonMetro500 === 0) && (waNonMetro600 === 11890) && (waNonMetro750 === 29725) && (waNonMetro760Fhb === waNonMetro760Std);

// FHOR (vacant land) — state-wide cap 450k: 0 ≤350k; 15.39% over 350k to 450k
const waLand350 = calcDuty({ state: "WA", price: 350000, isLand: true, isFhb: true }); // 0
const waLand400 = calcDuty({ state: "WA", price: 400000, isLand: true, isFhb: true }); // (50k)*0.1539 = 7,695
const waLand450 = calcDuty({ state: "WA", price: 450000, isLand: true, isFhb: true }); // (100k)*0.1539 = 15,390
const waLandOK = (waLand350 === 0) && (waLand400 === 7695) && (waLand450 === 15390);

// ---------- SA boundary checks ----------
{
  const sa = loadStateRules('sa');

  // 1) Exact lower threshold at $12,000
  {
    const price = 12000;
    const got = calcDutyFromBrackets(price, sa.general);
    const expected = 120; // 1% of 12,000
    assertEqual(got, expected, 'SA $12,000 exact');
  }

  // 2) Crossover just above $300,000 (+$100)
  {
    const price = 300100; // $100 over 300k
    const got = calcDutyFromBrackets(price, sa.general);
    // Base at 300k = 11,330; marginal 5% on 100 = 5 → 11,335
    const expected = 11335;
    assertEqual(got, expected, 'SA $300,100 crossover');
  }

  // 3) Top bracket example at $1,000,000
  {
    const price = 1000000;
    const got = calcDutyFromBrackets(price, sa.general);
    // Base at 500k = 21,330; marginal 5.5% on 500,000 = 27,500 → 48,830
    const expected = 48830;
    assertEqual(got, expected, 'SA $1,000,000');
  }
}


// --- Summary & exit ---
const okAll =
  passed === tests.length &&
  vicPprLowerAt500 &&
  vicPprDisabledAbove550 &&
  qldGen540OK &&
  qldPpr350OK &&
  qldFhbOK &&
  waGen360OK &&
  waMetroOK &&
  waNonMetroOK &&
  waLandOK;

console.log(`\n${passed}/${tests.length} NSW tests passed`);
console.log(`VIC PPR @ $500k lower than non-PPR: ${vicPprLowerAt500 ? "OK" : "FAIL"} (PPR=${dPpr500}, Std=${dStd500})`);
console.log(`VIC PPR disabled above $550k: ${vicPprDisabledAbove550 ? "OK" : "FAIL"} (PPR@560k=${dPpr560}, Std@560k=${dStd560})`);
console.log(`QLD general @ $540k = 17325: ${qldGen540OK ? "OK" : "FAIL"} (got ${qldGen540})`);
console.log(`QLD PPR @ $350k = 3500: ${qldPpr350OK ? "OK" : "FAIL"} (got ${qldPpr350})`);
console.log(`QLD FHB 700k→0, 710k→2185, 750k→10925, 800k→21850: ${qldFhbOK ? "OK" : "FAIL"} (got ${qldFhb700}, ${qldFhb710}, ${qldFhb750}, ${qldFhb800})`);
console.log(`WA general @ $360k = 11115: ${waGen360OK ? "OK" : "FAIL"} (got ${waGen360})`);
console.log(`WA FHOR Metro: 500k→0, 600k→13630, 700k→27260, 720k fallback equal: ${waMetroOK ? "OK" : "FAIL"} (got ${waMetro500}, ${waMetro600}, ${waMetro700}, fhb@720=${waMetro720Fhb}, std@720=${waMetro720Std})`);
console.log(`WA FHOR Non-Metro: 500k→0, 600k→11890, 750k→29725, 760k fallback equal: ${waNonMetroOK ? "OK" : "FAIL"} (got ${waNonMetro500}, ${waNonMetro600}, ${waNonMetro750}, fhb@760=${waNonMetro760Fhb}, std@760=${waNonMetro760Std})`);
console.log(`WA FHOR Land: 350k→0, 400k→7695, 450k→15390: ${waLandOK ? "OK" : "FAIL"} (got ${waLand350}, ${waLand400}, ${waLand450})`);

process.exit(okAll ? 0 : 1);
