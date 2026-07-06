// story-runner.js
// Usage: node story-runner.js --url https://flipkart.com --story "As a user I want to search..." --sprint Sprint-23 --count 6
require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { runBatchAutomation } = require("./automation");
const { getHtml, stripHtml, runCheck } = require("./utils");
const { saveTestCases, saveRunResult } = require("./storage");
const { captureAllShots } = require("./screenshot");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModels = [
  genAI.getGenerativeModel({ model: "gemini-2.0-flash" }),
  genAI.getGenerativeModel({ model: "gemini-2.0-flash-001" }),
];

// ── CLI args ──────────────────────────────────────────────────────────────────
const arg  = (flag) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : null; };

const TARGET_URL  = arg("--url");
const USER_STORY  = arg("--story");
const SPRINT_NAME = arg("--sprint") || `run-${new Date().toISOString().split("T")[0]}`;
const TEST_COUNT  = arg("--count")  ? parseInt(arg("--count")) : 8;
const RUN_ID      = `story-run-${Date.now()}`;

// ── Post result to dashboard ──────────────────────────────────────────────────
async function postResult(data) {
  for (let i = 0; i < 3; i++) {
    try {
      await fetch(`http://localhost:${process.env.PORT || 3000}/test-result`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ ...data, runId: RUN_ID }),
        signal:  AbortSignal.timeout(3000)
      });
      return;
    } catch (_) {
      if (i < 2) await new Promise(r => setTimeout(r, 500));
    }
  }
}

// ── AI: generate test cases from user story + HTML ───────────────────────────
async function generateFromStory(html, story, skipAI = false) {
  if (skipAI) {
    console.log("   ✅ Using rule-based test cases (accurate HTML validations)…\n");
    return buildRuleBasedCases(story);
  }
  const stripped = stripHtml(html, 80000);

  const prompt = `
You are a senior QA engineer. A team member has provided a user story.
Your job is to generate EXACTLY ${TEST_COUNT} test cases that validate this user story against the HTML source of the webpage.

USER STORY:
"${story}"

IMPORTANT RULES — follow these strictly:
1. Only generate checks that can be verified against raw HTML source code.
2. NEVER use words like "visible", "displayed", "shown", "rendered" — these cannot be checked in HTML.
3. For html_contains: the "value" MUST be a short exact string that literally appears in the HTML source (e.g. a placeholder, id, type attribute value, or button text). Check the HTML SOURCE below before writing the value.
4. For attribute_value: the "elementId" MUST be an id that actually exists in the HTML source below.
5. Focus on these validations:
   - Input field has correct type (type="email", type="password", type="text")
   - Input field has correct placeholder text (copy exact placeholder from HTML)
   - Button has correct label text (copy exact text from HTML)
   - Form element exists (check for id or placeholder)
   - Security: password field is NOT type="text"
   - Required fields have required attribute or correct input type

Use EXACTLY one check type per test:
1. html_contains      → value must be an EXACT short string found in the HTML below
2. html_not_contains  → value is a string that must NOT appear in HTML (e.g. security bug check)
3. attribute_value    → elementId must exist in HTML below; checks one attribute value

Return ONLY valid JSON — no extra text, no markdown:
{
  "testCases": [
    {
      "id": "US-01",
      "area": "Frontend",
      "name": "Short validation name (max 60 chars)",
      "expected": "What the correct HTML should contain",
      "check": "html_contains",
      "value": "exact string from HTML source"
    }
  ]
}

HTML SOURCE (search this before writing any value):
${stripped}`;

  const modelNames = ["Gemini 2.0 Flash", "Gemini 2.0 Flash 001"];
  for (let m = 0; m < geminiModels.length; m++) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const result = await geminiModels[m].generateContent(prompt);
        console.log(`   🔵 AI generated ${TEST_COUNT} test cases from user story (${modelNames[m]})\n`);
        const raw = result.response.text().trim()
          .replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
        const parsed = JSON.parse(raw);
        return parsed.testCases ?? parsed;
      } catch (err) {
        const isQuota = err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
        if (isQuota) { console.log(`   ⚠️  ${modelNames[m]} quota — switching…`); break; }
        const retryable = err.message?.includes("429") || err.message?.includes("503");
        if (!retryable || attempt === 4) throw err;
        const wait = err.message?.includes("503") ? 15000 : 30000;
        console.log(`   ⏳ Retrying in ${wait / 1000}s… (${attempt}/4)`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }

  // ── Rule-based fallback — generate basic test cases without AI ────────────
  console.log("   ⚠️  All AI models unavailable — generating rule-based test cases…\n");
  return buildRuleBasedCases(story);
}

// ── Rule-based test case builder using exact shop.html strings ───────────────
function buildRuleBasedCases(story) {
  const s = story.toLowerCase();

  // Build accurate test cases using exact strings from shop.html
  const cases = [];
  let n = 1;
  const id = () => `US-${String(n++).padStart(2,"0")}`;

  if (/sign\s?up|register|new user|create.*account/.test(s)) {
    cases.push(
      { id: id(), area: "Frontend",  check: "html_contains",     value: "Register",                    name: "Register tab is present",                   expected: "Register tab exists in auth page" },
      { id: id(), area: "Frontend",  check: "html_contains",     value: "Jane Doe",                    name: "Name input has correct placeholder",         expected: "Name field placeholder is 'Jane Doe'" },
      { id: id(), area: "Frontend",  check: "html_contains",     value: "regName",                     name: "Name input field exists (id=regName)",       expected: "Name input with id=regName exists" },
      { id: id(), area: "Frontend",  check: "html_contains",     value: "regEmail",                    name: "Email input field exists (id=regEmail)",     expected: "Email input with id=regEmail exists" },
      { id: id(), area: "Frontend",  check: "html_contains",     value: "Create Account",              name: "Create Account button is present",           expected: "Create Account submit button exists" },
      { id: id(), area: "Frontend",  check: "html_contains",     value: "Minimum 8 characters",        name: "Password hint text is shown",               expected: "Password hint '8 characters' exists" },
      { id: id(), area: "Security",  check: "html_contains",     value: "regConfirm",                  name: "Confirm password field exists",             expected: "Confirm password input exists" },
      { id: id(), area: "Security",  check: "attribute_value",   value: "", elementId: "regConfirm",   attribute: "type", expectedValue: "password",       name: "Confirm password field is masked",          expected: "regConfirm input has type=password" }
    );
  }

  if (/log\s?in|login|sign\s?in/.test(s)) {
    cases.push(
      { id: id(), area: "Frontend",  check: "html_contains",     value: "Log In",                      name: "Log In button is present",                  expected: "Log In button text exists" },
      { id: id(), area: "Frontend",  check: "html_contains",     value: "loginEmail",                  name: "Login email input exists (id=loginEmail)",  expected: "Email input with id=loginEmail exists" },
      { id: id(), area: "Frontend",  check: "html_contains",     value: "loginPassword",               name: "Login password input exists",               expected: "Password input with id=loginPassword exists" },
      { id: id(), area: "Frontend",  check: "html_contains",     value: "you@example.com",             name: "Email placeholder is correct",              expected: "Email placeholder 'you@example.com' exists" },
      { id: id(), area: "Security",  check: "html_contains",     value: "Password is case-sensitive",  name: "Password hint text is present",             expected: "Password hint text exists on login form" },
      { id: id(), area: "Security",  check: "attribute_value",   value: "", elementId: "loginPassword", attribute: "type", expectedValue: "password",      name: "Login password field is masked",            expected: "loginPassword has type=password" }
    );
  }

  if (/cart|add.*product|add.*item|basket/.test(s)) {
    cases.push(
      { id: id(), area: "Frontend",  check: "html_contains", value: "cartBadge",               name: "Cart badge element exists (id=cartBadge)",  expected: "Cart badge with id=cartBadge exists" },
      { id: id(), area: "Frontend",  check: "html_contains", value: "Proceed to Checkout",     name: "Checkout button is present",                expected: "Proceed to Checkout button exists" },
      { id: id(), area: "Frontend",  check: "html_contains", value: "productGrid",             name: "Product grid exists (id=productGrid)",      expected: "Product grid with id=productGrid exists" },
      { id: id(), area: "Frontend",  check: "html_contains", value: "Add to Cart",             name: "Add to Cart button is present",             expected: "Add to Cart button text exists" }
    );
  }

  if (/search/.test(s)) {
    cases.push(
      { id: id(), area: "Frontend",  check: "html_contains", value: "searchInput",             name: "Search input exists (id=searchInput)",      expected: "Search input with id=searchInput exists" },
      { id: id(), area: "Frontend",  check: "html_contains", value: "Search for products",     name: "Search placeholder text is correct",        expected: "Search placeholder text exists" },
      { id: id(), area: "Frontend",  check: "html_contains", value: "doSearch",                name: "Search button is wired to doSearch()",      expected: "Search button calls doSearch function" }
    );
  }

  if (/checkout|payment|order/.test(s)) {
    cases.push(
      { id: id(), area: "Frontend",  check: "html_contains", value: "Place Order",             name: "Place Order button is present",             expected: "Place Order button exists on checkout" },
      { id: id(), area: "Frontend",  check: "html_contains", value: "cardNumber",              name: "Card number input exists (id=cardNumber)",  expected: "Card number input exists" },
      { id: id(), area: "Frontend",  check: "html_contains", value: "chkEmail",                name: "Checkout email input exists (id=chkEmail)", expected: "Email input on checkout form exists" },
      { id: id(), area: "Frontend",  check: "html_contains", value: "5-digit numeric ZIP",     name: "ZIP code validation hint is present",       expected: "ZIP code hint text exists" }
    );
  }

  // Always add a basic page-load check
  if (cases.length === 0) {
    cases.push(
      { id: id(), area: "Frontend",  check: "html_contains", value: "DemoShop",                name: "DemoShop brand name is present",            expected: "DemoShop text exists on page" },
      { id: id(), area: "Frontend",  check: "html_contains", value: "searchInput",             name: "Search input exists",                       expected: "Search input with id=searchInput exists" },
      { id: id(), area: "Frontend",  check: "html_contains", value: "Log In",                  name: "Log In button is present",                  expected: "Log In button text exists" },
      { id: id(), area: "Frontend",  check: "html_contains", value: "cartBadge",               name: "Cart badge exists",                         expected: "Cart badge element exists" },
      { id: id(), area: "Frontend",  check: "html_contains", value: "productGrid",             name: "Product grid exists",                       expected: "Product grid element exists" }
    );
  }

  return cases.slice(0, 10);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!USER_STORY) {
    console.error("No user story provided. Use: --story 'As a user, I want to…'");
    process.exit(1);
  }

  const domain = TARGET_URL ? new URL(TARGET_URL).hostname : "DemoShop";

  console.log("═".repeat(60));
  console.log(`   📋 Story-Based Test Runner`);
  console.log("═".repeat(60));
  console.log(`   Site   : ${domain}`);
  console.log(`   Sprint : ${SPRINT_NAME}`);
  console.log(`   Story  : ${USER_STORY.slice(0, 80)}${USER_STORY.length > 80 ? "…" : ""}`);
  console.log(`   Tests  : ${TEST_COUNT}`);
  console.log("═".repeat(60) + "\n");

  // Step 1: Fetch HTML
  const html = await getHtml(TARGET_URL);

  // Step 2: Generate test cases
  // For localhost/DemoShop: always use rule-based (exact HTML strings) — AI generates "visible" checks that fail incorrectly.
  // For external URLs: try AI first, fall back to rule-based.
  const isLocalhost = !TARGET_URL || /localhost|127\.0\.0\.1/.test(TARGET_URL);
  let testCases;
  if (isLocalhost) {
    console.log(`🔎 Using rule-based test cases for DemoShop (exact HTML validations)…\n`);
    testCases = await generateFromStory(html, USER_STORY, true); // true = skip AI
  } else {
    console.log(`🤖 Generating ${TEST_COUNT} test cases from your user story…\n`);
    testCases = await generateFromStory(html, USER_STORY, false);
  }

  // Step 3: Save test cases
  saveTestCases(domain, SPRINT_NAME, testCases, {
    source: "user-story",
    url: TARGET_URL,
    story: USER_STORY
  });

  // Step 4: Run all HTML checks and post results to dashboard
  const failures = [];
  let passed = 0;

  for (const tc of testCases) {
    process.stdout.write(`  ${tc.id}  ${tc.name}… `);
    await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "running" });

    try {
      const result = runCheck(html, tc);
      if (result.passed) {
        console.log("✅ PASS");
        passed++;
        await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "pass" });
      } else {
        console.log(`❌ FAIL — ${result.actual}`);
        await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "fail", actual: result.actual });
        failures.push({
          id:         tc.id,
          title:      `${tc.id} — ${tc.name}`,
          errorValue: result.actual,
          culprit:    tc.id,
          testCase:   tc.id,
          expected:   tc.expected,
          area:       tc.area || "Frontend"
        });
      }
    } catch (err) {
      console.log(`💥 ERROR — ${err.message}`);
      await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "error", actual: err.message });
    }
  }

  // Step 5: Save run summary
  const summary = {
    passed,
    failed:  testCases.length - passed,
    total:   testCases.length,
    sprint:  SPRINT_NAME,
    story:   USER_STORY.slice(0, 120)
  };
  saveRunResult(domain, SPRINT_NAME, RUN_ID, [], summary);

  // Step 5b: Screenshot ALL tests (pass + fail) and post to dashboard
  const allTests = testCases.map(tc => ({
    id:       tc.id,
    title:    tc.name || tc.id,
    area:     tc.area || "Frontend",
    selector: tc.elementId ? `#${tc.elementId}` : null,
    status:   failures.find(f => f.id === tc.id) ? "fail" : "pass",
    errorValue: failures.find(f => f.id === tc.id)?.errorValue || null
  }));

  const shots = await captureAllShots(TARGET_URL, allTests, RUN_ID);

  for (const t of allTests) {
    t.screenshot = shots[t.id] || null;
    if (t.screenshot) {
      await postResult({
        id: t.id, name: t.title, area: t.area,
        status: t.status,
        actual: t.errorValue || null,
        screenshot: t.screenshot
      });
    }
  }
  // Update failures list with screenshots
  for (const f of failures) {
    f.screenshot = shots[f.id] || null;
  }

  // Step 6: AI classify failures → duplicate check → email tester → Jira
  let jiraCount = 0;
  if (failures.length > 0) {
    for (const f of failures) await postResult({ id: f.id, name: f.title, status: "classifying" });
    try {
      const results = await runBatchAutomation(failures, async (r) => {
        const failure = failures.find(f => f.id === r.id);
        await postResult({
          id: r.id, name: failure?.title || r.id, area: failure?.area,
          status: "fail", actual: failure?.errorValue,
          category: r.category, reason: r.reason, jiraUrl: r.jiraUrl,
          reviewStatus: r.reviewStatus, duplicate: r.duplicate, duplicateKey: r.duplicateKey,
          screenshot: failure?.screenshot || null
        });
      });
      jiraCount = results.filter(r => r.logged).length;
    } catch (err) {
      console.log(`\n💥 AI Error — ${err.message}\n`);
    }
  }

  await postResult({ id: "__done__", runFinished: true });

  console.log("\n" + "═".repeat(60));
  console.log(`   ✅ Passed       : ${passed}`);
  console.log(`   ❌ Failed       : ${testCases.length - passed}`);
  console.log(`   🎫 Jira tickets : ${jiraCount} created`);
  console.log(`   💾 Saved to     : test-suites/${domain}/${SPRINT_NAME}/`);
  console.log("═".repeat(60) + "\n");
}

main().catch(err => {
  console.error("[Story Runner Error]", err.message);
  process.exit(1);
});
