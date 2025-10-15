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

// minimal demo UI at GET /
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>AU Duty Calculator (Demo)</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; }
    fieldset { border: 1px solid #eee; border-radius: 12px; padding: 16px; }
    label { display:block; margin: 8px 0; }
    button { padding: 8px 14px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .muted { color: #666; font-size: 12px; }
    pre { background:#fafafa; padding:12px; border-radius:8px; overflow:auto; }
  </style>
</head>
<body>
  <h2>AU Transfer Duty (Demo)</h2>
  <form id="calcForm">
    <fieldset>
      <div class="row">
        <label>State
          <select name="state" id="state">
            <option>NSW</option><option>VIC</option><option>QLD</option><option>WA</option>
            <option>SA</option><option>TAS</option><option>ACT</option><option>NT</option>
          </select>
        </label>
        <label>Price (AUD)
          <input type="number" name="price" id="price" value="750000" step="1000" min="1" />
        </label>
      </div>
      <label><input type="checkbox" id="isFhb" /> First-home buyer</label>
      <label><input type="checkbox" id="isPpr" /> Owner-occupier (PPR) <span class="muted" id="pprNote"></span></label>
      <label><input type="checkbox" id="isLand" /> Vacant land</label>
      <label id="waRegion" style="display:none;">WA region
        <select id="region"><option value="metro">Metro/Peel</option><option value="non_metro">Outside Metro</option></select>
      </label>
      <label>Contract date (optional)
        <input type="date" id="contractDate" />
      </label>
      <button type="submit">Calculate</button>
    </fieldset>
  </form>

  <h3>Result</h3>
  <div id="out"><em class="muted">Enter inputs and click Calculate.</em></div>

  <script>
    const stateSel = document.getElementById('state');
    const priceEl  = document.getElementById('price');
    const isFhbEl  = document.getElementById('isFhb');
    const isPprEl  = document.getElementById('isPpr');
    const isLandEl = document.getElementById('isLand');
    const regionEl = document.getElementById('region');
    const waRegion = document.getElementById('waRegion');
    const pprNote  = document.getElementById('pprNote');
    const out      = document.getElementById('out');

    let features = {};
    fetch('/states').then(r=>r.json()).then(d=>{
      (d.states||[]).forEach(s => { features[s.state] = s; });
      applyStateUI();
    });

    function applyStateUI() {
      const st = stateSel.value;
      waRegion.style.display = (st === 'WA') ? '' : 'none';
      const supportsPpr = !!(features[st] && features[st].supports_ppr);
      isPprEl.disabled = !supportsPpr;
      if (!supportsPpr) { isPprEl.checked = false; pprNote.textContent = '(not applicable)'; }
      else { pprNote.textContent = ''; }
    }
    stateSel.addEventListener('change', applyStateUI);

    document.getElementById('calcForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      out.innerHTML = '<em class="muted">Calculating…</em>';
      const payload = {
        state: stateSel.value,
        price: Number(priceEl.value),
        isFhb: isFhbEl.checked,
        isPpr: isPprEl.checked,
        isLand: isLandEl.checked,
        region: (stateSel.value === 'WA') ? regionEl.value : undefined,
        contractDate: document.getElementById('contractDate').value || undefined
      };
      try {
        const res = await fetch('/calculate', {
          method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Calculation failed');
        const duty = json?.outputs?.duty;
        const formatted = (typeof duty === 'number')
          ? duty.toLocaleString('en-AU', { style:'currency', currency:'AUD' })
          : 'n/a';
        out.innerHTML = '<pre>'+JSON.stringify(json, null, 2)+'</pre><p><strong>Duty:</strong> '+formatted+'</p>';
      } catch (err) {
        out.innerHTML = '<p style="color:crimson">Error: '+(err.message||err)+'</p>';
      }
    });
  </script>
</body>
</html>`);
});

/** Start server */
const PORT = process.env.PORT || 8787;
// minimal demo UI at GET /
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>Duty Demo</title>
<style>body{font-family:system-ui;margin:2rem auto;max-width:640px}label{display:block;margin:.5rem 0}pre{background:#fafafa;padding:12px;border-radius:8px}</style>
</head><body>
<h2>AU Transfer Duty (Demo)</h2>
<form id="f">
  <label>State
    <select id="state">
      <option>NSW</option><option>VIC</option><option>QLD</option><option>WA</option>
      <option>SA</option><option>TAS</option><option>ACT</option><option>NT</option>
    </select>
  </label>
  <label>Price (AUD) <input id="price" type="number" value="750000" step="1000" min="1"></label>
  <label><input id="isFhb" type="checkbox"> First-home buyer</label>
  <label><input id="isPpr" type="checkbox"> Owner-occupier (PPR) <span id="pprNote" style="color:#666;font-size:.85em"></span></label>
  <label><input id="isLand" type="checkbox"> Vacant land</label>
  <label id="waRow" style="display:none">WA region
    <select id="region"><option value="metro">Metro/Peel</option><option value="non_metro">Outside Metro</option></select>
  </label>
  <label>Contract date (optional) <input id="contractDate" type="date"></label>
  <button>Calculate</button>
</form>
<h3>Result</h3>
<div id="out"><em>Enter inputs and click Calculate.</em></div>
<script>
  const qs = id => document.getElementById(id);
  const features = {};
  fetch('/states').then(r=>r.json()).then(d => {
    (d.states||[]).forEach(s => { features[s.state] = s; });
    applyStateUI();
  });
  function applyStateUI(){
    const st = qs('state').value;
    qs('waRow').style.display = st==='WA' ? '' : 'none';
    const supportsPpr = !!(features[st] && features[st].supports_ppr);
    qs('isPpr').disabled = !supportsPpr;
    qs('pprNote').textContent = supportsPpr ? '' : '(not applicable)';
    if (!supportsPpr) qs('isPpr').checked = false;
  }
  qs('state').addEventListener('change', applyStateUI);
  qs('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    qs('out').innerHTML = '<em>Calculating…</em>';
    const payload = {
      state: qs('state').value,
      price: Number(qs('price').value),
      isFhb: qs('isFhb').checked,
      isPpr: qs('isPpr').checked,
      isLand: qs('isLand').checked,
      region: qs('state').value==='WA' ? qs('region').value : undefined,
      contractDate: qs('contractDate').value || undefined
    };
    const res = await fetch('/calculate', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    const json = await res.json();
    if (!res.ok) { qs('out').innerHTML = '<span style="color:crimson">Error: '+(json.error||'failed')+'</span>'; return; }
    const duty = json?.outputs?.duty;
    qs('out').innerHTML = '<pre>'+JSON.stringify(json, null, 2)+'</pre><p><strong>Duty:</strong> '+(typeof duty==='number'? duty.toLocaleString('en-AU',{style:'currency',currency:'AUD'}) : 'n/a')+'</p>';
  });
</script>
</body></html>`);
});

app.listen(PORT, '0.0.0.0', () => console.log(`[calculator-api] listening on :${PORT}`));


