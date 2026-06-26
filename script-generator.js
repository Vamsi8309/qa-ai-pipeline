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

// ── Fallback: generate a Playwright script WITHOUT AI ─────────────────────────
// For automationexercise.com (well-known stable selectors) we emit real,
// runnable signup/login/cart flows based on the scenario keywords. For other
// sites we emit a smoke-test + stub.
function ruleBasedScript(scenario, url) {
  const target = url || "https://automationexercise.com/";
  const s   = scenario.toLowerCase();
  const isAE = /automationexercise\.com/.test(target);
  const wantSignup = /sign\s?up|register|new user|create.*account/.test(s);
  const wantLogin  = /log\s?in|login|sign\s?in/.test(s);
  const wantCart   = /cart|add.*product|add.*item|basket/.test(s);

  const testCases = [];
  const blocks = [];

  if (isAE && wantSignup) {
    testCases.push({ id: "TC-01", title: "New user can sign up and register successfully",
      steps: ["Open home page", "Click Signup / Login", "Enter name + unique email under New User Signup", "Click Signup", "Fill account information", "Click Create Account", "Verify Account Created", "Continue"],
      expected: "‘ACCOUNT CREATED!’ is shown and user is logged in" });
    blocks.push(`  test('TC-01 New user can sign up and register successfully', async ({ page }) => {
    const email = \`qa_\${Date.now()}@example.com\`;
    await page.goto('https://automationexercise.com/');
    await page.click("a[href='/login']");
    await expect(page.getByText('New User Signup!')).toBeVisible();
    await page.fill("input[data-qa='signup-name']", 'QA Tester');
    await page.fill("input[data-qa='signup-email']", email);
    await page.click("button[data-qa='signup-button']");
    await expect(page.getByText('Enter Account Information')).toBeVisible();
    await page.check('#id_gender1');
    await page.fill('#password', 'Test@12345');
    await page.selectOption('#days', '10');
    await page.selectOption('#months', '5');
    await page.selectOption('#years', '1995');
    await page.fill('#first_name', 'QA');
    await page.fill('#last_name', 'Tester');
    await page.fill('#address1', '123 Test Street');
    await page.selectOption('#country', 'India');
    await page.fill('#state', 'Telangana');
    await page.fill('#city', 'Hyderabad');
    await page.fill('#zipcode', '500001');
    await page.fill('#mobile_number', '9999999999');
    await page.click("button[data-qa='create-account']");
    await expect(page.getByText('Account Created!')).toBeVisible();
    await page.click("a[data-qa='continue-button']");
    await expect(page.getByText(/Logged in as/)).toBeVisible();
  });`);
  }

  if (isAE && wantLogin) {
    testCases.push({ id: `TC-${String(testCases.length + 1).padStart(2, "0")}`, title: "Registered user can log in",
      steps: ["Create an account", "Log out", "Open Signup / Login", "Enter the registered email + password", "Click Login"],
      expected: "Header shows ‘Logged in as <name>’" });
    blocks.push(`  test('TC-${String(blocks.length + 1).padStart(2, "0")} Registered user can log in', async ({ page }) => {
    // Create a fresh account first so the login is self-contained
    const email = \`qa_\${Date.now()}@example.com\`;
    const password = 'Test@12345';
    await page.goto('https://automationexercise.com/');
    await page.click("a[href='/login']");
    await page.fill("input[data-qa='signup-name']", 'QA Tester');
    await page.fill("input[data-qa='signup-email']", email);
    await page.click("button[data-qa='signup-button']");
    await page.check('#id_gender1');
    await page.fill('#password', password);
    await page.selectOption('#days', '10'); await page.selectOption('#months', '5'); await page.selectOption('#years', '1995');
    await page.fill('#first_name', 'QA'); await page.fill('#last_name', 'Tester');
    await page.fill('#address1', '123 Test Street'); await page.selectOption('#country', 'India');
    await page.fill('#state', 'Telangana'); await page.fill('#city', 'Hyderabad');
    await page.fill('#zipcode', '500001'); await page.fill('#mobile_number', '9999999999');
    await page.click("button[data-qa='create-account']");
    await page.click("a[data-qa='continue-button']");
    // Log out, then log back in
    await page.click("a[href='/logout']");
    await page.fill("input[data-qa='login-email']", email);
    await page.fill("input[data-qa='login-password']", password);
    await page.click("button[data-qa='login-button']");
    await expect(page.getByText(/Logged in as/)).toBeVisible();
  });`);
  }

  if (isAE && wantCart) {
    testCases.push({ id: `TC-${String(testCases.length + 1).padStart(2, "0")}`, title: "User can add a product to the cart",
      steps: ["Open Products", "Add the first product to cart", "View Cart"],
      expected: "Product appears in the cart" });
    blocks.push(`  test('TC-${String(blocks.length + 1).padStart(2, "0")} User can add a product to the cart', async ({ page }) => {
    await page.goto('https://automationexercise.com/products');
    await page.locator('.product-image-wrapper').first().hover();
    await page.locator('.product-overlay .add-to-cart').first().click();
    await page.click("button:has-text('Continue Shopping')");
    await page.click("a[href='/view_cart']");
    await expect(page.locator('#cart_info_table')).toBeVisible();
  });`);
  }

  // Fallback if nothing matched
  if (blocks.length === 0) {
    testCases.push({ id: "TC-01", title: "Page loads successfully", steps: [`Navigate to ${target}`], expected: "Page title is visible" });
    blocks.push(`  test('TC-01 Page loads successfully', async ({ page }) => {
    await page.goto('${target}');
    await expect(page).toHaveTitle(/.*/);
  });`);
  }

  const script = `const { test, expect } = require('@playwright/test');

// Scenario: ${scenario.replace(/\n/g, " ").slice(0, 200)}
test.describe('${target}', () => {
${blocks.join("\n\n")}
});
`;

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
