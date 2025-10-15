// src/api/server.js
const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const fs = require('fs');
const path = require('path');

const { calcDuty, getStateFeatures } = require('../duty'); // you already export these

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

/** Utility: list available state codes from rules folder (nsw, vic, ...) */
function listStateCodes() {
  const rulesDir = path.join(__dirname, '..', '..', 'rules', 'duty', '2025-26');
  return fs.readdirSync(rulesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

/** Health */
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'calculator-api', version: 1 });
});

/** Features per state (supports_ppr etc.) */
app.get('/states', (_req, res) => {
  const codes = listStateCodes();
  const states = codes.map(code => {
    try {
      const f = getStateFeatures(code.toUpperCase());
      return { code: code.toUpperCase(), ...f };
    } catch (e) {
      return { code: code.toUpperCase(), error: e.message };
    }
  });
  res.json({ states });
});

app.get('/features/:state', (req, res) => {
  try {
    const f = getStateFeatures(req.params.state.toUpperCase());
    res.json(f);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Schema for POST /calculate (duty-first; extend later with LMI options) */
const CalcBody = z.object({
  state: z.enum(['NSW','VIC','QLD','WA','SA','TAS','ACT','NT']),
  price: z.number().int().positive(),
  isLand: z.boolean().optional().default(false),
  isFhb: z.boolean().optional().default(false),
  isPpr: z.boolean().optional().default(false),
  region: z.enum(['metro','non_metro']).optional(), // only used by WA FHOR
  contractDate: z.string().optional() // ISO date, optional for now
});

app.post('/calculate', (req, res) => {
  const parse = CalcBody.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: 'Invalid request', details: parse.error.flatten() });
  }
  const input = parse.data;

  try {
    // Step 1: duty only (everything you’ve implemented is in calcDuty)
    const duty = calcDuty(input);

    // Response is versionable; add more fields later without breaking the UI
    res.json({
      input,
      outputs: {
        duty
        // lmi: null, // step 2
        // purchasingPower: null // step 2
      },
      meta: {
        schema: 1,
        currency: 'AUD'
      }
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Start server */
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`[calculator-api] listening on :${PORT}`);
});
