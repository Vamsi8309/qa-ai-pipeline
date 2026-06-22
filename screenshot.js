// screenshot.js — capture screenshots of the web app for FAILING test cases.
//
// Uses Playwright to render the page, highlight the failing element (when a
// CSS selector is known), and save a PNG into ./screenshots/<runId>/<id>.png.
// The server exposes these at /screenshots/... so the dashboard can show them.
require("dotenv").config();
const fs   = require("fs");
const path = require("path");

const SHOTS_ROOT = path.join(__dirname, "screenshots");

// failures: [{ id, selector? }]
// returns: { [id]: "/screenshots/<runId>/<id>.png" } for the ones captured
async function captureFailureShots(targetUrl, failures, runId) {
  const out = {};
  if (!Array.isArray(failures) || failures.length === 0) return out;

  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch { console.log("   📸 Screenshots skipped — Playwright not installed"); return out; }

  const url = targetUrl || `http://localhost:${process.env.PORT || 3000}/shop.html`;
  const dir = path.join(SHOTS_ROOT, runId);
  fs.mkdirSync(dir, { recursive: true });

  console.log(`\n   📸 Capturing screenshots of ${url} for ${failures.length} failure(s)…`);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); }
    catch (_) { /* still try to screenshot whatever rendered */ }
    await page.waitForTimeout(1500);

    for (const f of failures) {
      const file = path.join(dir, `${f.id}.png`);
      try {
        // Outline the failing element so the screenshot points at the problem.
        if (f.selector) {
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) {
              el.scrollIntoView({ block: "center", inline: "center" });
              el.dataset._origOutline = el.style.outline;
              el.style.outline   = "3px solid #f85149";
              el.style.boxShadow = "0 0 0 6px rgba(248,81,73,.35)";
            }
          }, f.selector).catch(() => {});
          await page.waitForTimeout(250);
        }

        await page.screenshot({ path: file, fullPage: true });
        out[f.id] = `/screenshots/${runId}/${f.id}.png`;
        console.log(`   📸 ${f.id} → ${out[f.id]}`);

        // Remove the highlight before the next shot.
        if (f.selector) {
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) { el.style.outline = el.dataset._origOutline || ""; el.style.boxShadow = ""; }
          }, f.selector).catch(() => {});
        }
      } catch (err) {
        console.log(`   ⚠️  Screenshot failed for ${f.id}: ${(err.message || "").split("\n")[0]}`);
      }
    }
  } catch (err) {
    console.log(`   ⚠️  Screenshot browser error: ${(err.message || "").split("\n")[0]}`);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }

  return out;
}

module.exports = { captureFailureShots };
