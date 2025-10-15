#!/usr/bin/env node
// src/cli/calc.js
const readline = require('readline');
const { calcDuty } = require('../duty');

const VALID_STATES = ['NSW','VIC','QLD','WA','SA','TAS','ACT','NT'];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i+1];
    const set = (k,v=true)=>{ args[k]=v; };
    if (a === '--state' || a === '-s') { set('state', String(next).toUpperCase()); i++; continue; }
    if (a === '--price' || a === '-p') { set('price', Number(next)); i++; continue; }
    if (a === '--ppr') set('isPpr', true);
    if (a === '--fhb') set('isFhb', true);
    if (a === '--land') set('isLand', true);
    if (a === '--region' || a === '-r') { set('region', next); i++; continue; }
    if (a === '--date' || a === '--contractDate') { set('contractDate', next); i++; continue; }
    if (a === '--json') set('json', true);
    if (a === '--interactive' || a === '-i') set('interactive', true);
    if (a === '--help' || a === '-h') set('help', true);
  }
  return args;
}

function usage() {
  console.log(`
AU Transfer Duty CLI

Usage:
  node src/cli/calc.js --state QLD --price 750000 --ppr --fhb
  node src/cli/calc.js -s WA -p 600000 --fhb --region metro
  node src/cli/calc.js --interactive

Options:
  -s, --state           NSW|VIC|QLD|WA|SA|TAS|ACT|NT
  -p, --price           Purchase price (integer dollars)
      --ppr             Owner-occupier / PPR
      --fhb             First-home buyer
      --land            Vacant land
  -r, --region          WA only: metro | non_metro
      --date            Contract date (YYYY-MM-DD)
      --json            Print JSON only
  -i, --interactive     Step-by-step prompts
  -h, --help            Show this help
`);
}

function fmtAUD(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n);
}

async function promptInteractive(prefill = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, res));

  const state = (await ask(`State [${prefill.state || 'NSW'}]: `)).trim().toUpperCase() || prefill.state || 'NSW';
  const priceStr = (await ask(`Price (AUD) [${prefill.price || 750000}]: `)).trim() || String(prefill.price || 750000);
  const isFhbStr = (await ask(`First-home buyer? (y/N) `)).trim().toLowerCase();
  const isPprStr = (await ask(`Owner-occupier (PPR)? (y/N) `)).trim().toLowerCase();
  const isLandStr = (await ask(`Vacant land? (y/N) `)).trim().toLowerCase();
  let region = undefined;
  if (state === 'WA') {
    const r = (await ask(`WA region [metro|non_metro] (default metro): `)).trim();
    region = r || 'metro';
  }
  const contractDate = (await ask(`Contract date (YYYY-MM-DD, optional): `)).trim() || undefined;

  rl.close();
  return {
    state,
    price: Number(priceStr),
    isFhb: ['y','yes','1','true'].includes(isFhbStr),
    isPpr: ['y','yes','1','true'].includes(isPprStr),
    isLand: ['y','yes','1','true'].includes(isLandStr),
    region, contractDate
  };
}

(async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();

  let input = {
    state: args.state,
    price: args.price,
    isFhb: !!args.isFhb,
    isPpr: !!args.isPpr,
    isLand: !!args.isLand,
    region: args.region,
    contractDate: args.contractDate
  };

  if (args.interactive || !input.state || !input.price) {
    input = await promptInteractive(input);
  }

  // Basic validation
  if (!VALID_STATES.includes(String(input.state).toUpperCase())) {
    console.error(`Error: invalid state "${input.state}". Use one of: ${VALID_STATES.join(', ')}`);
    process.exit(1);
  }
  if (!Number.isFinite(input.price) || input.price <= 0) {
    console.error(`Error: price must be a positive number. Got: ${input.price}`);
    process.exit(1);
  }
  if (String(input.state).toUpperCase() !== 'WA') {
    delete input.region; // only WA uses region
  }

  try {
    const duty = calcDuty(input);
    const out = { input, outputs: { duty } };
    if (args.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log('\nResult');
      console.log('======');
      console.log(`State: ${input.state}`);
      console.log(`Price: ${fmtAUD(input.price)}`);
      console.log(`FHB: ${input.isFhb ? 'Yes' : 'No'}`);
      console.log(`PPR: ${input.isPpr ? 'Yes' : 'No'}`);
      if (input.state === 'WA') console.log(`Region: ${input.region}`);
      if (input.contractDate) console.log(`Contract date: ${input.contractDate}`);
      console.log(`\nDuty: ${fmtAUD(duty)}\n`);
    }
  } catch (e) {
    console.error('Calculation failed:', e.message);
    process.exit(1);
  }
})();
