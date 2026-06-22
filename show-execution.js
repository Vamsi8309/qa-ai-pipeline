// show-execution.js — shows exactly how each test case executes
require("dotenv").config();
const fs   = require("fs");
const path = require("path");

// Load the last generated test cases
const tcFile = path.join(__dirname, "ai-testcases.json");
if (!fs.existsSync(tcFile)) {
  console.log("❌ No ai-testcases.json found. Run a test first from the dashboard.");
  process.exit(1);
}

const testCases = JSON.parse(fs.readFileSync(tcFile, "utf8"));

console.log("\n" + "═".repeat(70));
console.log("   HOW EACH TEST CASE EXECUTES");
console.log("═".repeat(70));
console.log(`\n📋 Total test cases loaded: ${testCases.length}\n`);

testCases.forEach((tc, i) => {
  console.log(`${"─".repeat(70)}`);
  console.log(`TEST ${i + 1}: ${tc.id} — ${tc.name}`);
  console.log(`${"─".repeat(70)}`);
  console.log(`  Area     : ${tc.area}`);
  console.log(`  Expected : ${tc.expected}`);
  console.log(`  Check    : ${tc.check}`);

  if (tc.check === "html_contains") {
    console.log(`  Logic    : ✅ PASS if HTML source CONTAINS → "${tc.value}"`);
    console.log(`             ❌ FAIL if that string is MISSING from HTML`);
  }
  else if (tc.check === "html_not_contains") {
    console.log(`  Logic    : ✅ PASS if HTML source does NOT CONTAIN → "${tc.value}"`);
    console.log(`             ❌ FAIL if that string IS found in HTML`);
  }
  else if (tc.check === "attribute_value") {
    console.log(`  Logic    : Finds element with id="${tc.elementId}"`);
    console.log(`             Checks ${tc.attribute} === "${tc.expectedValue}"`);
    console.log(`             ✅ PASS if match | ❌ FAIL if different or missing`);
  }
  console.log();
});

console.log("═".repeat(70));
console.log("\n🔍 WHERE CHECKS RUN:\n");
console.log("  Each check runs against the raw HTML of the website.");
console.log("  No browser clicks — it's a text search inside the HTML source.\n");
console.log("  html_contains    → like Ctrl+F searching for a string");
console.log("  html_not_contains → making sure a bad string doesn't exist");
console.log("  attribute_value  → find element by ID, read its attribute value\n");
console.log("═".repeat(70) + "\n");
