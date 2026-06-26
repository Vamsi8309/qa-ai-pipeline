require("dotenv").config();
const fs                     = require("fs");
const path                   = require("path");
const Groq                   = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { runBatchAutomation } = require("./automation");
const { getHtml, stripHtml, runCheck: execCheck } = require("./utils");
const { saveTestCases, saveRunResult } = require("./storage");

const groq         = new Groq({ apiKey: process.env.GROQ_API_KEY });
const genAI        = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModels = [
  genAI.getGenerativeModel({ model: "gemini-2.0-flash" }),
  genAI.getGenerativeModel({ model: "gemini-2.0-flash-001" }),
];

const RUN_ID = `ai-run-${Date.now()}`;

// ── CLI args ──────────────────────────────────────────────────────────────────
// node generate-tests.js --url https://flipkart.com --count 4 --sprint Sprint-23
const arg = (flag) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : null; };

const TARGET_URL   = arg("--url");
const TEST_COUNT   = arg("--count") ? parseInt(arg("--count")) : null;
const SPRINT_NAME  = arg("--sprint") || `run-${new Date().toISOString().split("T")[0]}`;
const SOURCE_LABEL = TARGET_URL || "shop.html";

async function postResult(data) {
  try {
    await fetch(`http://localhost:${process.env.PORT || 3000}/test-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, runId: RUN_ID }),
      signal: AbortSignal.timeout(2000)
    });
  } catch (_) {}
}

// ── Rule-based generator (no AI) — used when Groq + Gemini are both unavailable
// Scans the fetched HTML for common e-commerce features and builds basic,
// runnable HTML checks so the pipeline never hard-crashes when AI is down.
function ruleBasedGenerate(html, count) {
  const lc = html.toLowerCase();
  const max = count || 8;
  const cases = [];
  const push = (c) => { if (cases.length < max) cases.push({ id: `RB-${String(cases.length + 1).padStart(2, "0")}`, ...c }); };

  if (/type=["']password["']/i.test(html)) {
    push({ area: "Security", name: "Password fields use type=password", check: "html_contains", value: 'type="password"', expected: "Password inputs are masked" });
  } else if (lc.includes("password")) {
    push({ area: "Security", name: "Password field should be masked", check: "html_contains", value: 'type="password"', expected: "A masked password input should exist" });
  }
  if (/login|log in|sign in|signin/.test(lc))         push({ area: "Frontend", name: "Login option is present",        check: "html_contains", value: "login",  expected: "Login / Sign-in is available" });
  if (/signup|sign up|register/.test(lc))             push({ area: "Frontend", name: "Registration/Signup is present", check: "html_contains", value: "register", expected: "User registration is available" });
  if (lc.includes("search"))                          push({ area: "Frontend", name: "Search is present",              check: "html_contains", value: "search", expected: "Search functionality exists" });
  if (/cart|basket/.test(lc))                         push({ area: "Frontend", name: "Cart is present",                check: "html_contains", value: "cart",   expected: "Cart / basket is available" });
  if (/checkout|payment|card/.test(lc))               push({ area: "Backend",  name: "Checkout/payment is present",    check: "html_contains", value: "checkout", expected: "Checkout / payment flow exists" });
  if (/type=["']email["']/i.test(html))               push({ area: "Frontend", name: "Email field uses type=email",    check: "html_contains", value: 'type="email"', expected: "Email inputs use type=email" });
  if (lc.includes("<form"))                           push({ area: "Frontend", name: "Page contains a form",           check: "html_contains", value: "<form", expected: "At least one form exists" });
  push({ area: "Security", name: "Password input is never plain text", check: "html_not_contains", value: 'name="password" type="text"', expected: "Password is never type=text" });

  if (cases.length === 0) {
    push({ area: "Frontend", name: "Page renders with a title", check: "html_contains", value: "<title", expected: "Page has a <title>" });
    push({ area: "Frontend", name: "Page has body content",     check: "html_contains", value: "<body",  expected: "Page has a <body>" });
  }
  return cases;
}

// ── Step 1: Ask AI to generate test cases from the HTML ───────────────────────
async function generateTestCases(html) {
  const stripped = stripHtml(html, 80000);  // from utils.js

  const prompt = `
You are a senior QA engineer analyzing an e-commerce HTML page for bugs.

Analyze the HTML and generate test cases that check for issues detectable from the HTML source only.
Focus on:
- Input field types (password fields → type="password", phone → type="tel", email → type="email")
- Presence of validation attributes (pattern, required, maxlength, min, max)
- Form security (no credentials in plaintext inputs)
- Correct element attributes for accessibility and validation

Use EXACTLY one of these check types per test case:

1. attribute_value — check a specific input's attribute
   Required extra fields: "elementId", "attribute", "expectedValue"
   Only use this if the element has a clear, unique id attribute in the HTML.

2. html_contains — the HTML source must contain this exact string
   Required extra fields: "value"

3. html_not_contains — the HTML source must NOT contain this exact string
   Required extra fields: "value"

Return a JSON object with a "testCases" array of EXACTLY ${TEST_COUNT || "8–12"} test cases in this exact format:
{
  "testCases": [
    {
      "id": "AI-01",
      "area": "Security|Backend|Frontend|Performance",
      "name": "Short test name",
      "expected": "What correct behaviour looks like",
      "check": "attribute_value",
      "elementId": "element-id-without-hash",
      "attribute": "type",
      "expectedValue": "password"
    }
  ]
}

HTML:
${stripped}`;

  console.log(`\n🤖 Sending ${SOURCE_LABEL} to AI for test case generation…\n`);

  let rawText;
  try {
    const response = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
      response_format: { type: "json_object" }
    });
    console.log("   🟢 Provider: Groq (Llama 3.3 70B)");
    rawText = response.choices[0].message.content;
  } catch (groqErr) {
    const blocked = groqErr.status === 403 || groqErr.message?.includes("403") || groqErr.message?.includes("blocked");
    console.log(`   ⚠️  Groq unavailable (${blocked ? "blocked by network" : groqErr.message}) — falling back to Gemini…`);

    const modelNames = ["Gemini 2.5 Flash", "Gemini 2.0 Flash Lite"];
    for (let m = 0; m < geminiModels.length; m++) {
      const model = geminiModels[m];
      const modelName = modelNames[m];
      let succeeded = false;

      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const result = await model.generateContent(prompt);
          console.log(`   🔵 Provider: ${modelName} (fallback)`);
          rawText = result.response.text();
          succeeded = true;
          break;
        } catch (gemErr) {
          const isQuota = gemErr.message?.includes("quota") || gemErr.message?.includes("RESOURCE_EXHAUSTED");
          if (isQuota) {
            console.log(`   ⚠️  ${modelName} quota exhausted — switching to next model…`);
            break;
          }
          const retryable = gemErr.message?.includes("503") || gemErr.message?.includes("429");
          if (!retryable || attempt === 4) throw gemErr;
          const match  = gemErr.message.match(/retry in (\d+(?:\.\d+)?)s/i);
          const wait   = gemErr.message?.includes("503") ? 15000 : (match ? Math.ceil(parseFloat(match[1])) * 1000 + 1000 : 30000);
          console.log(`   ⏳ ${modelName} busy — waiting ${Math.ceil(wait / 1000)}s then retrying (${attempt}/4)…`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
      if (succeeded) break;
    }
  }

  // All AI providers unavailable (Groq blocked + Gemini quota) → don't crash;
  // fall back to a rule-based generator so the run still produces test cases.
  if (!rawText) {
    console.log("   ⚠️  All AI models unavailable (Groq blocked / Gemini quota) — using rule-based generator (no AI)…");
    const fallbackCases = ruleBasedGenerate(html, TEST_COUNT);
    const domainFb = TARGET_URL ? new URL(TARGET_URL).hostname : "DemoShop";
    saveTestCases(domainFb, SPRINT_NAME, fallbackCases, { source: "url-rulebased", url: TARGET_URL });
    fs.writeFileSync(path.join(__dirname, "ai-testcases.json"), JSON.stringify(fallbackCases, null, 2));
    console.log(`✅ Generated ${fallbackCases.length} rule-based test cases (AI was unavailable)\n`);
    return fallbackCases;
  }

  rawText = rawText.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const parsed    = JSON.parse(rawText);
  const testCases = parsed.testCases ?? parsed;

  // Save to organised folder: test-suites/{domain}/{sprint}/testcases.json
  const domain = TARGET_URL ? new URL(TARGET_URL).hostname : "DemoShop";
  saveTestCases(domain, SPRINT_NAME, testCases, { source: "url", url: TARGET_URL });

  // Also keep flat file for backward compat (testrunner.js reads it)
  fs.writeFileSync(path.join(__dirname, "ai-testcases.json"), JSON.stringify(testCases, null, 2));

  console.log(`✅ AI generated ${testCases.length} test cases\n`);
  return testCases;
}

// ── Step 2 + 3: Run generated tests → batch AI classify → Jira ───────────────
async function runGeneratedTests(testCases, html) {
  const domain   = TARGET_URL ? new URL(TARGET_URL).hostname : "DemoShop";
  const failures = [];
  let passed = 0;

  console.log("═".repeat(54));
  console.log(`   ${domain} — AI Generated Test Runner`);
  console.log(`   Sprint : ${SPRINT_NAME}`);
  console.log("═".repeat(54) + "\n");

  // Phase 1: run all checks
  for (const tc of testCases) {
    process.stdout.write(`  ${tc.id}... `);
    await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "running" });

    try {
      const result = execCheck(html, tc);   // from utils.js
      if (result.passed) {
        console.log("✅ PASS");
        passed++;
        await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "pass" });
      } else {
        console.log(`❌ FAIL — ${result.actual}`);
        await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "fail", actual: result.actual });
        failures.push({
          id: tc.id, title: `${tc.id} — ${tc.name}`,
          errorType: tc.name, errorValue: result.actual,
          culprit: tc.id, testCase: tc.id, expected: tc.expected, area: tc.area || ""
        });
      }
    } catch (err) {
      console.log(`💥 ERROR — ${err.message}`);
      await postResult({ id: tc.id, name: tc.name, area: tc.area, status: "error", actual: err.message });
    }
  }

  // Save run results to storage
  const summary = { passed, failed: testCases.length - passed, total: testCases.length, sprint: SPRINT_NAME };
  saveRunResult(domain, SPRINT_NAME, RUN_ID, [], summary);

  // Phase 2: batch AI classify failures → Jira
  let jiraCount = 0;
  if (failures.length > 0) {
    for (const f of failures) await postResult({ id: f.id, name: f.title, status: "classifying" });
    try {
      const batchResults = await runBatchAutomation(failures, async (r) => {
        const failure = failures.find(f => f.id === r.id);
        await postResult({
          id: r.id, name: failure?.title || r.id, area: failure?.area,
          status: "fail", actual: failure?.errorValue,
          category: r.category, reason: r.reason, jiraUrl: r.jiraUrl,
          reviewStatus: r.reviewStatus, duplicate: r.duplicate, duplicateKey: r.duplicateKey
        });
      });
      jiraCount = batchResults.filter(r => r.logged).length;
    } catch (err) {
      console.log(`\n💥 Batch AI Error — ${err.message}\n`);
    }
  }

  await postResult({ id: "__done__", runFinished: true });

  console.log("\n" + "═".repeat(54));
  console.log(`   ✅ Passed       : ${passed}`);
  console.log(`   ❌ Failed       : ${testCases.length - passed}`);
  console.log(`   🎫 Jira tickets : ${jiraCount} created`);
  console.log(`   💾 Saved to     : test-suites/${domain}/${SPRINT_NAME}/`);
  console.log("═".repeat(54) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const html      = await getHtml(TARGET_URL);
  const testCases = await generateTestCases(html);
  await runGeneratedTests(testCases, html);
}

main().catch(err => {
  console.error("[Generate Error]", err.message);
  process.exit(1);
});
