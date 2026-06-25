// script-runner.js — REAL Playwright test-script generation + execution.
//
// Given a scenario + URL, the AI writes actual browser steps (goto/fill/click/
// assert), which we (a) render into a readable Playwright .spec.js saved to
// generated-tests/, (b) execute in a real Chromium browser, and (c) feed any
// failures into the existing pipeline (screenshot → tester review email → Jira).
require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const Groq = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { runBatchAutomation } = require("./automation");
const { saveRunResult }      = require("./storage");

const groq  = new Groq({ apiKey: process.env.GROQ_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModels = [
  genAI.getGenerativeModel({ model: "gemini-2.0-flash" }),
  genAI.getGenerativeModel({ model: "gemini-2.0-flash-001" }),
];

const arg = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
const TARGET_URL = arg("--url") || "https://automationexercise.com/";
const STORY      = arg("--story")  || "";
const SPRINT     = arg("--sprint") || `run-${new Date().toISOString().split("T")[0]}`;
const COUNT      = arg("--count") ? parseInt(arg("--count")) : 5;
const RUN_ID     = `script-run-${Date.now()}`;
const PORT       = process.env.PORT || 3000;
const SHOTS_DIR  = path.join(__dirname, "screenshots", RUN_ID);
const SPEC_DIR   = path.join(__dirname, "generated-tests", SPRINT);

async function postResult(data) {
  try {
    await fetch(`http://localhost:${PORT}/test-result`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, runId: RUN_ID }), signal: AbortSignal.timeout(3000)
    });
  } catch (_) {}
}

// ── AI: generate Playwright steps (Groq → Gemini) ─────────────────────────────
async function aiGenerate(prompt) {
  try {
    const r = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile", temperature: 0.1, response_format: { type: "json_object" }
    });
    console.log("   🟢 Provider: Groq (Llama 3.3 70B)");
    return r.choices[0].message.content;
  } catch (e) {
    const blocked = e.status === 403 || /403|blocked/.test(e.message || "");
    console.log(`   ⚠️  Groq unavailable (${blocked ? "blocked by network" : (e.message || "").slice(0, 40)}) — falling back to Gemini…`);
  }
  for (let m = 0; m < geminiModels.length; m++) {
    try {
      const r = await geminiModels[m].generateContent(prompt);
      console.log("   🔵 Provider: Gemini (fallback)");
      return r.response.text();
    } catch (e) {
      const q = /quota|RESOURCE_EXHAUSTED|429/.test(e.message || "");
      console.log(`   ⚠️  Gemini ${q ? "quota exhausted" : "error"} — ${m < geminiModels.length - 1 ? "next model…" : "giving up"}`);
    }
  }
  return null;
}

function buildPrompt() {
  return `You are a senior SDET. Write an executable browser test for this scenario as a sequence of steps.

SCENARIO: "${STORY || "Smoke test the site loads and key elements are present"}"
TARGET URL: ${TARGET_URL}

Produce EXACTLY ${COUNT} independent test cases (each must set up its own state — start with a "goto").
Use ONLY these step actions:
- { "action": "goto", "url": "<absolute url>" }
- { "action": "fill", "selector": "<css>", "value": "<text>" }
- { "action": "click", "selector": "<css>" }
- { "action": "press", "selector": "<css>", "value": "Enter" }
- { "action": "waitFor", "selector": "<css>" }
- { "action": "expectVisible", "selector": "<css>" }
- { "action": "expectText", "selector": "<css>", "value": "<expected substring>" }
- { "action": "expectUrlContains", "value": "<substring>" }
- { "action": "expectTitleContains", "value": "<substring>" }

Placeholders you may use in values (filled at runtime): {{email}} (unique), {{password}}, {{name}}.
Use REAL, robust CSS selectors (prefer [name=...], [data-qa=...], [type=...], id, or visible text-based attributes).

Return ONLY valid JSON:
{
  "tests": [
    { "id": "TC-01", "name": "short name", "expected": "what success looks like",
      "steps": [ { "action": "goto", "url": "..." }, ... ] }
  ]
}`;
}

// Rule-based fallback when AI is unavailable: a basic smoke test.
function fallbackTests() {
  return [{
    id: "TC-01", name: "Page loads and renders", expected: "Page returns a non-empty document with a <body>",
    steps: [
      { action: "goto", url: TARGET_URL },
      { action: "expectVisible", selector: "body" }
    ]
  }];
}

// ── Render steps into a readable Playwright .spec.js (the artifact) ───────────
function renderSpec(tests) {
  const esc = s => String(s).replace(/'/g, "\\'");
  const line = (st) => {
    switch (st.action) {
      case "goto":               return `    await page.goto('${esc(st.url)}', { waitUntil: 'domcontentloaded' });`;
      case "fill":               return `    await page.fill('${esc(st.selector)}', '${esc(st.value)}');`;
      case "click":              return `    await page.click('${esc(st.selector)}');`;
      case "press":              return `    await page.press('${esc(st.selector)}', '${esc(st.value)}');`;
      case "waitFor":            return `    await page.waitForSelector('${esc(st.selector)}');`;
      case "expectVisible":      return `    await expect(page.locator('${esc(st.selector)}')).toBeVisible();`;
      case "expectText":         return `    await expect(page.locator('${esc(st.selector)}')).toContainText('${esc(st.value)}');`;
      case "expectUrlContains":  return `    await expect(page).toHaveURL(/${esc(st.value)}/);`;
      case "expectTitleContains":return `    await expect(page).toHaveTitle(/${esc(st.value)}/);`;
      default:                   return `    // unknown step: ${esc(JSON.stringify(st))}`;
    }
  };
  const blocks = tests.map(t =>
`  test('${esc(t.id)} — ${esc(t.name)}', async ({ page }) => {
${(t.steps || []).map(line).join("\n")}
  });`).join("\n\n");

  return `const { test, expect } = require('@playwright/test');

// Auto-generated by QA AI Pipeline from scenario:
// "${esc(STORY)}"
test.describe('${esc(TARGET_URL)}', () => {
${blocks}
});
`;
}

// ── Execute one test's steps in a real browser ───────────────────────────────
async function execTest(browser, t, fillers) {
  const ctx  = await browser.newContext();
  const page = await ctx.newPage();
  const sub  = (s) => String(s == null ? "" : s)
    .replace(/\{\{email\}\}/g, fillers.email)
    .replace(/\{\{password\}\}/g, fillers.password)
    .replace(/\{\{name\}\}/g, fillers.name);
  try {
    for (const st of (t.steps || [])) {
      switch (st.action) {
        case "goto":         await page.goto(sub(st.url), { waitUntil: "domcontentloaded", timeout: 30000 }); break;
        case "fill":         await page.fill(st.selector, sub(st.value), { timeout: 10000 }); break;
        case "click":        await page.click(st.selector, { timeout: 10000 }); break;
        case "press":        await page.press(st.selector, sub(st.value), { timeout: 10000 }); break;
        case "waitFor":      await page.waitForSelector(st.selector, { timeout: 10000 }); break;
        case "expectVisible": {
          await page.waitForSelector(st.selector, { state: "visible", timeout: 10000 }); break;
        }
        case "expectText": {
          const el = await page.waitForSelector(st.selector, { timeout: 10000 });
          const txt = (await el.textContent()) || "";
          if (!txt.toLowerCase().includes(sub(st.value).toLowerCase()))
            throw new Error(`expected text "${sub(st.value)}" not found (got "${txt.trim().slice(0, 60)}")`);
          break;
        }
        case "expectUrlContains":
          if (!page.url().includes(sub(st.value))) throw new Error(`URL "${page.url()}" missing "${sub(st.value)}"`); break;
        case "expectTitleContains": {
          const ti = await page.title();
          if (!ti.includes(sub(st.value))) throw new Error(`title "${ti}" missing "${sub(st.value)}"`); break;
        }
        default: throw new Error(`unknown action: ${st.action}`);
      }
    }
    await ctx.close();
    return { passed: true };
  } catch (err) {
    // screenshot the failure
    let shot = null;
    try {
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      const f = path.join(SHOTS_DIR, `${t.id}.png`);
      await page.screenshot({ path: f, fullPage: true });
      shot = `/screenshots/${RUN_ID}/${t.id}.png`;
    } catch (_) {}
    await ctx.close();
    return { passed: false, actual: (err.message || "step failed").split("\n")[0], screenshot: shot };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(60));
  console.log("   🎭 Real Playwright Test-Script Runner");
  console.log(`   Site   : ${TARGET_URL}`);
  console.log(`   Scenario: ${STORY.slice(0, 90)}${STORY.length > 90 ? "…" : ""}`);
  console.log("═".repeat(60) + "\n");

  // 1) Generate steps via AI (fallback to a smoke test if AI is down)
  console.log("🤖 Asking AI to write the Playwright test script…\n");
  let tests;
  const raw = await aiGenerate(buildPrompt());
  if (raw) {
    try {
      const parsed = JSON.parse(raw.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
      tests = parsed.tests || parsed;
    } catch (_) { tests = null; }
  }
  if (!tests || !tests.length) {
    console.log("   ⚠️  AI unavailable or invalid output — using a basic smoke test instead.\n");
    tests = fallbackTests();
  }

  // 2) Render + save the readable .spec.js artifact, and print it to the chat
  const spec = renderSpec(tests);
  fs.mkdirSync(SPEC_DIR, { recursive: true });
  const specPath = path.join(SPEC_DIR, `${RUN_ID}.spec.js`);
  fs.writeFileSync(specPath, spec, "utf8");
  console.log("📝 Generated Playwright test script:\n");
  console.log("────────────────────────────────────────────────────────");
  console.log(spec);
  console.log("────────────────────────────────────────────────────────");
  console.log(`💾 Saved → generated-tests/${SPRINT}/${RUN_ID}.spec.js\n`);

  // 3) Execute the script in a real browser
  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch { console.log("❌ Playwright not installed — cannot execute. Run: npx playwright install chromium"); process.exit(1); }

  const fillers = { email: `qa_${Date.now()}@example.com`, password: "Test@12345", name: "QA Tester" };
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const failures = [];
  let passed = 0;

  console.log("▶ Executing in a real Chromium browser…\n");
  for (const t of tests) {
    process.stdout.write(`  ${t.id} — ${t.name}… `);
    await postResult({ id: t.id, name: t.name, status: "running" });
    const r = await execTest(browser, t, fillers);
    results.push({ id: t.id, name: t.name, ...r });
    if (r.passed) {
      console.log("✅ PASS");
      passed++;
      await postResult({ id: t.id, name: t.name, status: "pass" });
    } else {
      console.log(`❌ FAIL — ${r.actual}`);
      await postResult({ id: t.id, name: t.name, status: "fail", actual: r.actual, screenshot: r.screenshot });
      failures.push({
        id: t.id, title: `${t.id} — ${t.name}`, errorType: t.name, errorValue: r.actual,
        culprit: t.id, testCase: t.id, expected: t.expected || "See scenario", area: "Frontend",
        screenshot: r.screenshot
      });
    }
  }
  await browser.close();

  saveRunResult(new URL(TARGET_URL).hostname, SPRINT, RUN_ID, results, { passed, failed: tests.length - passed, total: tests.length, sprint: SPRINT });

  // 4) Failures → AI classify → tester review email → Jira (existing pipeline)
  if (failures.length > 0) {
    for (const f of failures) await postResult({ id: f.id, name: f.title, status: "classifying" });
    try {
      await runBatchAutomation(failures, async (r) => {
        const f = failures.find(x => x.id === r.id);
        await postResult({
          id: r.id, name: f?.title || r.id, status: "fail", actual: f?.errorValue,
          category: r.category, reason: r.reason, jiraUrl: r.jiraUrl,
          reviewStatus: r.reviewStatus, screenshot: f?.screenshot || null
        });
      });
    } catch (err) { console.log(`\n💥 Pipeline error — ${err.message}\n`); }
  }

  await postResult({ id: "__done__", runFinished: true });

  console.log("\n" + "═".repeat(60));
  console.log(`   ✅ Passed : ${passed}    ❌ Failed : ${tests.length - passed}`);
  console.log(`   📝 Script : generated-tests/${SPRINT}/${RUN_ID}.spec.js`);
  console.log("═".repeat(60) + "\n");
}

main().catch(err => { console.error("[Script Runner Error]", err.message); process.exit(1); });
