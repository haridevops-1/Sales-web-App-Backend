"use strict";

const { generateBusinessSlug } = require("../functions/spikra_experience_deploy/deploy_worker");
const cases = [
  ["Monin Pvt Ltd", "monin-pvt-ltd_proposal"],
  ["ABC Manufacturing", "abc-manufacturing_proposal"],
  ["ABC Manufacturing & Foods", "abc-manufacturing-foods_proposal"],
  ["XYZ Logistics", "xyz-logistics_proposal"],
  ["  Special --- Name && Co.  ", "special-name-co_proposal"],
  ["", "customer_proposal"],
  [null, "customer_proposal"]
];
let passed = 0;
for (const [input, expected] of cases) {
  const actual = generateBusinessSlug(input);
  if (actual === expected) {
    passed++;
  } else {
    console.error("FAILED for:", input, "expected:", expected, "got:", actual);
  }
}
console.log("Slug tests passed: " + passed + "/" + cases.length);
if (passed !== cases.length) process.exit(1);
