const fs = require("fs");
const path = require("path");

function loadLMI() {
  const p = path.join(__dirname, "..", "rules", "lmi", "lmi_v1.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function lookupLmiRate(loan, lvr, lmiRules) {
  const bands = lmiRules.bands;
  const band = bands.find(b => loan >= b.loan_min && loan < b.loan_max) || bands[bands.length - 1];
  const bracket = band.lvr_brackets.find(br => lvr >= br.lvr_min && lvr < br.lvr_max);
  return bracket ? bracket.rate : 0;
}

function calcLmi({ loan, lvr }) {
  const rules = loadLMI();
  if (lvr <= rules.caps.min_lvr_for_lmi) return 0;
  if (lvr > rules.caps.max_lvr) return NaN; // invalid
  const rate = lookupLmiRate(loan, lvr, rules);
  return Math.round(loan * rate);
}

module.exports = { calcLmi, loadLMI };
