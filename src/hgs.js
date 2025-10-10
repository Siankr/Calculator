const fs = require("fs");
const path = require("path");

function loadHGS() {
  const p = path.join(__dirname, "..", "rules", "guarantees", "2025-10", "hgs_caps_nsw.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function hgsEligible({ state="NSW", region="capital_and_regional_centres", price, contractDate="2025-10-10" }) {
  const rules = loadHGS();
  if (new Date(contractDate) < new Date(rules.effective_from)) return false;
  const cap = rules.caps.find(c => c.state === state && c.region === region);
  if (!cap) return false;
  return price <= cap.property_cap;
}

module.exports = { hgsEligible, loadHGS };
