// script-generator.js
// Takes a plain-English test scenario → AI generates test cases + executable Playwright test script
require("dotenv").config();
const fs    = require("fs");
const path  = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModels = [
  genAI.getGenerativeModel({ model: "gemini-2.0-flash" }),
  genAI.getGenerativeModel({ model: "gemini-2.0-flash-001" }),
];

// ── Generate test cases + Playwright script from a scenario ──────────────────
async function generateScript(scenario, url = "") {
  const prompt = `
You are a senior QA automation engineer. A tester has given you a test scenario in plain English.

TEST SCENARIO:
"${scenario}"
${url ? `TARGET URL: ${url}` : ""}

Do TWO things:

1. Break the scenario into clear, numbered TEST CASES (each with: id, title, steps, expected result).

2. Write a complete, RUNNABLE Playwright test script in JavaScript that automates these test cases.
   - Use @playwright/test syntax (import { test, expect })
   - Each test case = one test() block
   - Use realistic selectors (getByRole, getByPlaceholder, getByText, locator)
   - Add expect() assertions for each expected result
   - Add comments explaining each step

Return ONLY valid JSON in this exact format — no extra text:
{
  "testCases": [
    {
      "id": "TC-01",
      "title": "Short title",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected": "What should happen"
    }
  ],
  "script": "const { test, expect } = require('@playwright/test');\\n\\ntest('...', async ({ page }) => {\\n  // full script here\\n});"
}`;

  const modelNames = ["Gemini 2.0 Flash", "Gemini 2.0 Flash 001"];
  for (let m = 0; m < geminiModels.length; m++) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await geminiModels[m].generateContent(prompt);
        const raw = result.response.text().trim()
          .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        const parsed = JSON.parse(raw);
        console.log(`   🔵 Script generated (${modelNames[m]})`);
        return parsed;
      } catch (err) {
        const isQuota = err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
        if (isQuota) { console.log(`   ⚠️  ${modelNames[m]} quota — switching…`); break; }
        const retryable = err.message?.includes("429") || err.message?.includes("503");
        if (!retryable || attempt === 3) throw err;
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }

  // ── Rule-based fallback — basic script template ───────────────────────────
  console.log("   ⚠️  AI unavailable — generating template script…");
  return ruleBasedScript(scenario, url);
}

// ── Fallback: generate a basic Playwright template without AI ────────────────
function ruleBasedScript(scenario, url) {
  const target = url || "https://example.com";
  const testCases = [
    { id: "TC-01", title: "Page loads successfully", steps: [`Navigate to ${target}`, "Wait for page load"], expected: "Page title is visible" },
    { id: "TC-02", title: "Main scenario check", steps: [scenario], expected: "Scenario behaviour works correctly" }
  ];

  const script = `const { test, expect } = require('@playwright/test');

// Scenario: ${scenario}
test('Page loads successfully', async ({ page }) => {
  // Navigate to the target URL
  await page.goto('${target}');
  // Verify the page loaded
  await expect(page).toHaveTitle(/.*/);
});

test('${scenario.slice(0, 50)}', async ({ page }) => {
  await page.goto('${target}');
  // TODO: Add steps for: ${scenario}
  // Example:
  // await page.getByRole('button', { name: 'Search' }).click();
  // await expect(page.getByText('Results')).toBeVisible();
});`;

  return { testCases, script };
}

// ── Save script to file ───────────────────────────────────────────────────────
function saveScript(scenario, result) {
  const dir = path.join(__dirname, "generated-scripts");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const safeName = scenario.slice(0, 30).replace(/[^a-z0-9]/gi, "-").toLowerCase();
  const ts       = new Date().toISOString().replace(/[:.]/g, "-").split("T")[0];
  const file     = path.join(dir, `${safeName}-${ts}.spec.js`);

  fs.writeFileSync(file, result.script, "utf8");
  return file;
}

module.exports = { generateScript, saveScript };
