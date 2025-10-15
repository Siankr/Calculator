const fs = require('fs');
const path = require('path');
const { calcDutyNSW, calcDuty } = require('../src/duty');

// ---- tiny assert helper (single place) ----
function assertEqual(got, expected, label) {
  if (got !== expected) {
    console.error(`❌ ${label} expected=${expected} got=${got}`);
    process.exit(1);
  }
  console.log(`✅ ${label} expected=${expected} got=${got}`);
}

// ---- Rules schema sanity (WA-style rows) ----
function _schemaCheckState(code) {
  const rules = require(`../rules/duty/2025-26/${code}.json`);
  const sched = rules?.modes?.established?.schedule;
  if (!Array.isArray(sched) || !sched.length) {
    console.error(`❌ ${code.toUpperCase()} schedule missing/empty`);
    return false;
  }
  const row = sched[0];
  const required = ['lower_inclusive', 'upper_exclusive', 'base', 'marginal_rate', 'applies_above'];
  const missing = required.filter(k => !(k in row));
  if (missing.length) {
    console.error(`❌ ${code.toUpperCase()} schema missing keys: ${missing.join(', ')}`);
    return false;
  }
  console.log(`✅ ${code.toUpperCase()} schedule schema OK`);
  return true;
}
const _schemaAllOK = ['sa', 'tas', 'act', 'nt'].every(_schemaCheckState);

// --- NSW golden tests ---
const testsPath = path.join(__dirname, 'golden_nsw.json');
if (!fs.existsSync(testsPath)) {
  console.error('Missing tests/golden_nsw.json');
  process.exit(1);
}
const tests = JSON.parse(fs.readFileSync(testsPath, 'utf8'));

let passed = 0;
for (const t of tests) {
  const got = calcDutyNSW({
    price: t.price,
    isLand: t.isLand,
    isFhb: t.isFhb,
    contractDate: '2025-10-10'
  });
  const ok = got === t.expectedDuty;
  console.log(`${ok ? '✅' : '❌'} NSW price=${t.price} expected=${t.expectedDuty} got=${got}`);
  if (ok) passed++;
}

// --- VIC PPR sanity checks ---
const dPpr500 = calcDuty({ state: 'VIC', price: 500000, isPpr: true });
const dStd500 = calcDuty({ state: 'VIC', price: 500000, isPpr: false });
const vicPprLowerAt500 = dPpr500 < dStd500;

const dPpr560 = calcDuty({ state: 'VIC', price: 560000, isPpr: true });
const dStd560 = calcDuty({ state: 'VIC', price: 560000, isPpr: false });
const vicPprDisabledAbove550 = dPpr560 === dStd560;

// --- QLD checks ---
const qldGen540 = calcDuty({ state: 'QLD', price: 540000, isPpr: false });
const qldGen540OK = qldGen540 === 17325;

const qldPpr350 = calcDuty({ state: 'QLD', price: 350000, isPpr: true });
const qldPpr350OK = qldPpr350 === 3500;

// FHB step-rebate (against PPR): 700k→0 linear to 800k→full PPR
const qldFhb700 = calcDuty({ state: 'QLD', price: 700000, isPpr: true, isFhb: true }); // 0
const qldFhb710 = calcDuty({ state: 'QLD', price: 710000, isPpr: true, isFhb: true }); // 2,185
const qldFhb750 = calcDuty({ state: 'QLD', price: 750000, isPpr: true, isFhb: true }); // 10,925
const qldFhb800 = calcDuty({ state: 'QLD', price: 800000, isPpr: true, isFhb: true }); // 21,850
const qldFhbOK =
  qldFhb700 === 0 &&
  qldFhb710 === 2185 &&
  qldFhb750 === 10925 &&
  qldFhb800 === 21850;

// --- WA checks ---
// General: boundary sanity
const waGen360 = calcDuty({ state: 'WA', price: 360000 });
const waGen360OK = waGen360 === 11115;

// FHOR (homes) — Metro/Peel (cap 700k): 0 ≤500k; 13.63% over 500k to 700k
const waMetro500 = calcDuty({ state: 'WA', price: 500000, isFhb: true, region: 'metro' }); // 0
const waMetro600 = calcDuty({ state: 'WA', price: 600000, isFhb: true, region: 'metro' }); // 13,630
const waMetro700 = calcDuty({ state: 'WA', price: 700000, isFhb: true, region: 'metro' }); // 27,260
// Above cap should fall back to established (PPR=established for WA)
const waMetro720Fhb = calcDuty({ state: 'WA', price: 720000, isFhb: true, region: 'metro' });
const waMetro720Std = calcDuty({ state: 'WA', price: 720000, isFhb: false });
const waMetroOK = (waMetro500 === 0) && (waMetro600 === 13630) && (waMetro700 === 27260) && (waMetro720Fhb === waMetro720Std);

// FHOR (homes) — Outside Metro (cap 750k): 0 ≤500k; 11.89% over 500k to 750k
const waNonMetro500 = calcDuty({ state: 'WA', price: 500000, isFhb: true, region: 'non_metro' }); // 0
const waNonMetro600 = calcDuty({ state: 'WA', price: 600000, isFhb: true, region: 'non_metro' }); // 11,890
const waNonMetro750 = calcDuty({ state: 'WA', price: 750000, isFhb: true, region: 'non_metro' }); // 29,725
const waNonMetro760Fhb = calcDuty({ state: 'WA', price: 760000, isFhb: true, region: 'non_metro' });
const waNonMetro760Std = calcDuty({ state: 'WA', price: 760000, isFhb: false });
const waNonMetroOK = (waNonMetro500 === 0) && (waNonMetro600 === 11890) && (waNonMetro750 === 29725) && (waNonMetro760Fhb === waNonMetro760Std);

// FHOR (vacant land) — state-wide cap 450k: 0 ≤350k; 15.39% over 350k to 450k
const waLand350 = calcDuty({ state: 'WA', price: 350000, isLand: true, isFhb: true }); // 0
const waLand400 = calcDuty({ state: 'WA', price: 400000, isLand: true, isFhb: true }); // 7,695
const waLand450 = calcDuty({ state: 'WA', price: 450000, isLand: true, isFhb: true }); // 15,390
const waLandOK = (waLand350 === 0) && (waLand400 === 7695) && (waLand450 === 15390);

// ---------- SA boundary checks ----------
{
  const got1 = calcDuty({ state: 'SA', price: 12000 });
  assertEqual(got1, 120, 'SA $12,000 exact');

  const got2 = calcDuty({ state: 'SA', price: 300100 }); // base 11,330 + 5% of 100 = 11,335
  assertEqual(got2, 11335, 'SA $300,100 crossover');

  const got3 = calcDuty({ state: 'SA', price: 1000000 }); // base 21,330 + 5.5% of 500,000 = 48,830
  assertEqual(got3, 48830, 'SA $1,000,000');
}

// ---------- TAS boundary checks ----------
{
  const t1 = calcDuty({ state: 'TAS', price: 3000 });
  assertEqual(t1, 50, 'TAS $3,000 exact');

  const t2 = calcDuty({ state: 'TAS', price: 725100 }); // base 27,810 + 4.5% of 100 = 27,815
  assertEqual(t2, 27815, 'TAS $725,100 crossover');

  const t3 = calcDuty({ state: 'TAS', price: 1000000 }); // 27,810 + 4.5% of 275,000 = 40,185
  assertEqual(t3, 40185, 'TAS $1,000,000');
}

// ---------- ACT boundary checks (general / non-PPR) ----------
{
  const act1 = calcDuty({ state: 'ACT', price: 200000 });
  assertEqual(act1, 2400, 'ACT $200,000 exact');

  const act2 = calcDuty({ state: 'ACT', price: 300100 });
  assertEqual(act2, 4603, 'ACT $300,100 crossover');

  const act3 = calcDuty({ state: 'ACT', price: 2000000 });
  assertEqual(act3, 90800, 'ACT $2,000,000 flat tier');
}

// ---------- ACT PPR boundary checks ----------
{
  const actP1 = calcDuty({ state: 'ACT', price: 260000, isPpr: true });
  assertEqual(actP1, 728, 'ACT PPR $260,000 exact');

  const actP2 = calcDuty({ state: 'ACT', price: 300100, isPpr: true });
  assertEqual(actP2, 1611, 'ACT PPR $300,100 crossover');

  const actP3 = calcDuty({ state: 'ACT', price: 2000000, isPpr: true });
  assertEqual(actP3, 90800, 'ACT PPR $2,000,000 flat tier');
}

// ---------- NT polynomial checks (< $525k) ----------
{
  const ntPoly1 = calcDuty({ state: 'NT', price: 500000 });
  assertEqual(ntPoly1, 23929, 'NT poly @ $500,000');

  const ntPoly2 = calcDuty({ state: 'NT', price: 525000 });
  assertEqual(ntPoly2, 25988, 'NT poly @ $525,000 (boundary)');
}

// ---------- NT flat % checks (≥ $525k) ----------
{
  const nt1 = calcDuty({ state: 'NT', price: 525100 }); // 4.95% of total
  assertEqual(nt1, 25992, 'NT $525,100 (flat 4.95%)');

  const nt2 = calcDuty({ state: 'NT', price: 3000000 }); // 5.75% of total
  assertEqual(nt2, 172500, 'NT $3,000,000 (flat 5.75%)');

  const nt3 = calcDuty({ state: 'NT', price: 6000000 }); // 5.95% of total
  assertEqual(nt3, 357000, 'NT $6,000,000 (flat 5.95%)');
}

// ---------- NSW FHB partial concession (800k–1.0m) ----------
{
  // 800k remains 0 (already covered by goldens)
  const nswStd900 = calcDuty({ state: 'NSW', price: 900000 }); // standard
  const nswFhb900 = calcDuty({ state: 'NSW', price: 900000, isFhb: true });
  // 900k is midpoint of 800–1000 => ~50% of standard
  assertEqual(nswFhb900, Math.round(nswStd900 * 0.5), 'NSW FHB @ $900k = 50% standard');

  const nswStd1000 = calcDuty({ state: 'NSW', price: 1000000 });
  const nswFhb1000 = calcDuty({ state: 'NSW', price: 1000000, isFhb: true });
  assertEqual(nswFhb1000, nswStd1000, 'NSW FHB @ $1.0m = full standard');
}

// ---------- VIC FHB (PPR) 0 to full between 600k–750k ----------
{
  const vicFhb600 = calcDuty({ state: 'VIC', price: 600000, isPpr: true, isFhb: true });
  assertEqual(vicFhb600, 0, 'VIC FHB PPR @ $600k = 0');

  const vicStd750 = calcDuty({ state: 'VIC', price: 750000, isPpr: false });
  const vicFhb750 = calcDuty({ state: 'VIC', price: 750000, isPpr: true, isFhb: true });
  assertEqual(vicFhb750, vicStd750, 'VIC FHB PPR @ $750k = full general duty');

  // Midpoint at $675k should be ~50% of general duty at 675k
  const vicStd675 = calcDuty({ state: 'VIC', price: 675000, isPpr: false });
  const vicFhb675 = calcDuty({ state: 'VIC', price: 675000, isPpr: true, isFhb: true });
  assertEqual(vicFhb675, Math.round(vicStd675 * 0.5), 'VIC FHB PPR @ $675k ≈ 50% general');
}


// --- Summary & exit ---
const okAll =
  _schemaAllOK &&
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
console.log(`VIC PPR @ $500k lower than non-PPR: ${vicPprLowerAt500 ? 'OK' : 'FAIL'} (PPR=${dPpr500}, Std=${dStd500})`);
console.log(`VIC PPR disabled above $550k: ${vicPprDisabledAbove550 ? 'OK' : 'FAIL'} (PPR@560k=${dPpr560}, Std@560k=${dStd560})`);
console.log(`QLD general @ $540k = 17325: ${qldGen540OK ? 'OK' : 'FAIL'} (got ${qldGen540})`);
console.log(`QLD PPR @ $350k = 3500: ${qldPpr350OK ? 'OK' : 'FAIL'} (got ${qldPpr350})`);
console.log(`QLD FHB 700k→0, 710k→2185, 750k→10925, 800k→21850: ${qldFhbOK ? 'OK' : 'FAIL'} (got ${qldFhb700}, ${qldFhb710}, ${qldFhb750}, ${qldFhb800})`);
console.log(`WA general @ $360k = 11115: ${waGen360OK ? 'OK' : 'FAIL'} (got ${waGen360})`);
console.log(`WA FHOR Metro: 500k→0, 600k→13630, 700k→27260, 720k fallback equal: ${waMetroOK ? 'OK' : 'FAIL'} (got ${waMetro500}, ${waMetro600}, ${waMetro700}, fhb@720=${waMetro720Fhb}, std@720=${waMetro720Std})`);
console.log(`WA FHOR Non-Metro: 500k→0, 600k→11890, 750k→29725, 760k fallback equal: ${waNonMetroOK ? 'OK' : 'FAIL'} (got ${waNonMetro500}, ${waNonMetro600}, ${waNonMetro750}, fhb@760=${waNonMetro760Fhb}, std@760=${waNonMetro760Std})`);
console.log(`WA FHOR Land: 350k→0, 400k→7695, 450k→15390: ${waLandOK ? 'OK' : 'FAIL'} (got ${waLand350}, ${waLand400}, ${waLand450})`);

process.exit(okAll ? 0 : 1);
