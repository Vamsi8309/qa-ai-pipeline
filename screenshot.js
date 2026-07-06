// screenshot.js — capture screenshots for ALL test cases (pass + fail).
require("dotenv").config();
const fs   = require("fs");
const path = require("path");

const SHOTS_ROOT = path.join(__dirname, "screenshots");

// tests: [{ id, selector?, status }]   status = "pass" | "fail"
// returns: { [id]: "/screenshots/<runId>/<id>.png" }
async function captureAllShots(targetUrl, tests, runId) {
  const out = {};
  if (!Array.isArray(tests) || tests.length === 0) return out;

  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch { console.log("   📸 Screenshots skipped — Playwright not installed"); return out; }

  // Always point to shop.html — localhost:3000 serves dashboard.html, not the shop
  const base = (targetUrl || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
  const url  = /localhost|127\.0\.0\.1/.test(base) ? `${base}/shop.html` : base;
  const dir = path.join(SHOTS_ROOT, runId);
  fs.mkdirSync(dir, { recursive: true });

  console.log(`\n   📸 Capturing screenshots for ${tests.length} test(s) on ${url}…`);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try { await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }); }
    catch (_) { try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }); } catch (_) {} }
    await page.waitForTimeout(2000);

    for (const t of tests) {
      const file = path.join(dir, `${t.id}.png`);
      try {
        // For failures: highlight the missing/broken element in red
        // For passes: highlight the element in green
        if (t.selector) {
          const color = t.status === "pass" ? "#3fb950" : "#f85149";
          const shadow = t.status === "pass"
            ? "0 0 0 6px rgba(63,185,80,.35)"
            : "0 0 0 6px rgba(248,81,73,.35)";
          await page.evaluate(({ sel, color, shadow }) => {
            const el = document.querySelector(sel);
            if (el) {
              el.scrollIntoView({ block: "center", inline: "center" });
              el.dataset._origOutline = el.style.outline;
              el.style.outline   = `3px solid ${color}`;
              el.style.boxShadow = shadow;
            }
          }, { sel: t.selector, color, shadow }).catch(() => {});
          await page.waitForTimeout(200);
        }

        await page.screenshot({ path: file, fullPage: true });
        out[t.id] = `/screenshots/${runId}/${t.id}.png`;
        console.log(`   📸 ${t.id} (${t.status}) → ${out[t.id]}`);

        // Remove highlight before next shot
        if (t.selector) {
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) { el.style.outline = el.dataset._origOutline || ""; el.style.boxShadow = ""; }
          }, t.selector).catch(() => {});
        }
      } catch (err) {
        console.log(`   ⚠️  Screenshot failed for ${t.id}: ${(err.message || "").split("\n")[0]}`);
      }
    }
  } catch (err) {
    console.log(`   ⚠️  Screenshot browser error: ${(err.message || "").split("\n")[0]}`);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }

  return out;
}

// Keep old export for compatibility
async function captureFailureShots(targetUrl, failures, runId) {
  return captureAllShots(targetUrl, failures.map(f => ({ ...f, status: "fail" })), runId);
}

module.exports = { captureAllShots, captureFailureShots };
