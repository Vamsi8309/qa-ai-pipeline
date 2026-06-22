require("dotenv").config();
const http               = require("http");
const fs                 = require("fs");
const path               = require("path");
const { runAutomation, createTicketForReview } = require("./automation");
const { handleChat }     = require("./chat-agent");
const { listSites, listSprints, listRuns } = require("./storage");
const reviewStore        = require("./review-store");

const PORT = process.env.PORT || 3000;   // hosts (Render/Railway) inject PORT

// ── Confirmation page shown after a tester clicks Accept / Decline ────────────
function resultPage(title, message, color) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:Segoe UI,system-ui,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:40px;max-width:520px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.4)">
    <div style="width:60px;height:60px;border-radius:50%;background:${color};margin:0 auto 20px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:30px">${color === "#238636" ? "✓" : (color === "#da3633" ? "!" : "ℹ")}</div>
    <h2 style="margin:0 0 12px;color:#f0f6fc">${title}</h2>
    <p style="color:#8b949e;font-size:15px;line-height:1.6;margin:0">${message}</p>
    <p style="color:#6e7681;font-size:12px;margin-top:28px">QA AI Pipeline — Test Failure Review</p>
  </div>
</body></html>`;
}

// ── SSE state ─────────────────────────────────────────────────────────────────
const sseClients = [];
let   currentRun = { id: null, tests: [], started: null, finished: false };

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => { try { c.write(msg); } catch (_) {} });
}

// Live-update one test row in the current run (used when a tester accepts /
// declines a review AFTER the run has finished) and push it to the dashboard.
function updateDashboardRow(testId, patch) {
  if (!currentRun || !Array.isArray(currentRun.tests)) return;
  const t = currentRun.tests.find(t => t.id === testId);
  if (!t) return;
  Object.assign(t, patch);
  broadcast(currentRun);
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {

  // ── 0. Tester Accept / Decline links (human-in-the-loop review) ─────────────
  const reviewMatch = req.method === "GET" && req.url.match(/^\/review\/([^/?]+)\/(accept|decline)(?:\?(.*))?$/);
  if (reviewMatch) {
    const [, id, action, query] = reviewMatch;
    const params = new URLSearchParams(query || "");
    const review = reviewStore.getById(id);

    const page = (title, message, color) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(resultPage(title, message, color));
    };

    if (!review || review.token !== params.get("token")) {
      page("Invalid link", "This review link is invalid or has expired.", "#8b949e");
      return;
    }

    if (review.status !== "pending") {
      const note = review.status === "accepted"
        ? `Already accepted — Jira ticket <strong>${review.jiraUrl ? (review.jiraUrl.split("/browse/")[1] || "created") : "created"}</strong>.`
        : "Already declined. No Jira ticket was created.";
      page("Already reviewed", note, "#8b949e");
      return;
    }

    if (action === "decline") {
      reviewStore.decide(id, { status: "declined", declineReason: params.get("reason") || "not-a-bug" });
      // Reflect on the dashboard: this test was reviewed and rejected.
      updateDashboardRow(review.testCaseId, { reviewStatus: "declined" });
      console.log(`   ✕ Review ${id} declined by tester — no Jira ticket created`);
      page("Declined", "Recorded as <strong>not a real bug</strong>. No Jira ticket was created.", "#da3633");
      return;
    }

    // action === "accept" → duplicate-check, then create the Jira ticket
    createTicketForReview(review)
      .then((result) => {
        const { jiraUrl, duplicate, duplicateKey } = result;
        const key = duplicateKey || jiraUrl.split("/browse/")[1] || "created";
        reviewStore.decide(id, { status: "accepted", jiraUrl, duplicate: !!duplicate, duplicateKey: duplicateKey || null });
        updateDashboardRow(review.testCaseId, { reviewStatus: "accepted", jiraUrl, duplicate: !!duplicate, duplicateKey: duplicateKey || null });
        if (duplicate) {
          console.log(`   🔁 Review ${id} accepted — duplicate of ${key}, no new ticket created`);
          page("Duplicate bug 🔁", `This is already in the backlog as <strong>${key}</strong> — no new ticket was created.<br><br><a href="${jiraUrl}" style="color:#58a6ff">${jiraUrl}</a>`, "#d29922");
        } else {
          console.log(`   ✓ Review ${id} accepted by tester — Jira ticket ${key} created`);
          page("Bug accepted ✓", `Logged to the Jira backlog as <strong>${key}</strong>.<br><br><a href="${jiraUrl}" style="color:#58a6ff">${jiraUrl}</a>`, "#238636");
        }
      })
      .catch((err) => {
        console.log(`   ⚠️  Accept → Jira create failed for ${id}: ${err.message}`);
        page("Could not create Jira ticket", err.message, "#da3633");
      });
    return;
  }

  // ── 0c. Serve failure screenshots saved by screenshot.js ────────────────────
  if (req.method === "GET" && req.url.startsWith("/screenshots/")) {
    const rel      = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    const filePath = path.normalize(path.join(__dirname, rel));
    const shotsDir = path.join(__dirname, "screenshots");
    if (!filePath.startsWith(shotsDir)) { res.writeHead(403); res.end("forbidden"); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
      res.end(data);
    });
    return;
  }

  // ── 0b. Pending reviews feed (for dashboards / debugging) ───────────────────
  if (req.method === "GET" && req.url === "/reviews") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(reviewStore.getAll()));
    return;
  }

  // ── 1. Bug log from frontend → Gemini classify → Jira ──────────────────────
  if (req.method === "POST" && req.url === "/log-bug") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try {
        const { field, message, data } = JSON.parse(body);
        const timestamp = new Date().toLocaleTimeString();

        // Print to terminal
        console.log(
          `\n[${timestamp}] ISSUE DETECTED\n` +
          `  Field   : ${field}\n` +
          `  Error   : ${message}\n` +
          `  Value   : ${data}\n`
        );

        // Gemini classify → Jira
        runAutomation({
          data: {
            issue: {
              title:     `${field}: ${message}`,
              level:     "error",
              culprit:   field,
              firstSeen: new Date().toISOString(),
              metadata:  { type: field, value: data },
              project:   { name: "DemoShop" }
            }
          }
        }).catch(err => console.error("[Automation Error]", err.message));

      } catch (_) {}
      res.writeHead(200);
      res.end();
    });
    return;
  }

  // ── 2. AI Chat Agent ──────────────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/chat") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });

      let { message } = JSON.parse(body || "{}");
      if (!message) { res.end(); return; }

      handleChat(message, (chunk) => {
        try {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          if (chunk.type === "done") res.end();
        } catch (_) {}
      }).catch(() => { try { res.end(); } catch (_) {} });
    });
    return;
  }

  // ── 3. Receive test result from runners → broadcast to dashboard ───────────
  if (req.method === "POST" && req.url === "/test-result") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try {
        const result = JSON.parse(body);
        if (!currentRun.id || result.runId !== currentRun.id) {
          currentRun = { id: result.runId, tests: [], started: new Date().toISOString(), finished: false };
        }
        if (result.runFinished) {
          currentRun.finished = true;
        } else {
          const idx = currentRun.tests.findIndex(t => t.id === result.id);
          if (idx >= 0) Object.assign(currentRun.tests[idx], result);
          else currentRun.tests.push(result);
        }
        broadcast(currentRun);
      } catch (_) {}
      res.writeHead(200); res.end();
    });
    return;
  }

  // ── Gemini Bearer token test ─────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/test-bearer") {
    const https  = require("https");
    const body   = JSON.stringify({ contents: [{ parts: [{ text: "Say OK" }] }] });
    const greq   = https.request({
      hostname: "generativelanguage.googleapis.com",
      port: 443,
      path: "/v1beta/models/gemini-2.0-flash:generateContent",
      method: "POST",
      headers: {
        "Authorization":  `Bearer ${process.env.GEMINI_API_KEY}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      rejectUnauthorized: false
    }, (gres) => {
      let data = "";
      gres.on("data", c => (data += c));
      gres.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: gres.statusCode, body: data.slice(0, 300) }));
      });
    });
    greq.on("error", err => { res.writeHead(200); res.end(JSON.stringify({ error: err.message })); });
    greq.write(body);
    greq.end();
    return;
  }

  // ── Gemini API key test ──────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/test-gemini") {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    model.generateContent("Say OK in one word")
      .then(r => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: `✅ Gemini working: ${r.response.text().trim()}`, key: process.env.GEMINI_API_KEY?.slice(0,10) + "..." }));
      })
      .catch(err => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: `❌ Gemini error: ${err.message}`, key: process.env.GEMINI_API_KEY?.slice(0,10) + "..." }));
      });
    return;
  }

  // ── 3a. Email test ───────────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/test-email") {
    const { Resend } = require("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    const to     = process.env.EMAIL_TO || process.env.EMAIL_FROM;
    resend.emails.send({
      from:    "QA AI Pipeline <onboarding@resend.dev>",
      to,
      subject: "✅ QA Pipeline — Email Test",
      html:    `<h2>Email is working!</h2><p>Sent at: ${new Date().toLocaleString()}</p>`
    }).then(({ data, error }) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (error) {
        res.end(JSON.stringify({ ok: false, message: `❌ Resend error: ${JSON.stringify(error)}`, to }));
      } else {
        res.end(JSON.stringify({ ok: true, message: `✅ Email sent to ${to}`, id: data?.id }));
      }
    }).catch(err => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: `❌ Email failed: ${err.message}`, to }));
    });
    return;
  }

  // ── 3a. Jira connectivity test ───────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/test-jira") {
    const https = require("https");
    const auth  = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString("base64");
    const base  = new URL(process.env.JIRA_BASE_URL);

    const jreq = https.request({
      hostname: base.hostname, port: 443,
      path: "/rest/api/3/myself", method: "GET",
      headers: { "Authorization": `Basic ${auth}`, "Accept": "application/json" },
      rejectUnauthorized: false
    }, (jres) => {
      let body = "";
      jres.on("data", c => (body += c));
      jres.on("end", () => {
        const ok = jres.statusCode === 200;
        let name = "unknown";
        try { name = JSON.parse(body).displayName || JSON.parse(body).emailAddress; } catch (_) {}
        let accountId = "";
        try { accountId = JSON.parse(body).accountId || ""; } catch (_) {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status:    jres.statusCode,
          ok,
          message:   ok ? `✅ Connected as: ${name}` : `❌ Auth failed (${jres.statusCode}): ${body.slice(0, 200)}`,
          accountId: accountId,
          jiraUrl:   process.env.JIRA_BASE_URL
        }));
      });
    });
    jreq.on("error", (err) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: `❌ Network error: ${err.message}` }));
    });
    jreq.end();
    return;
  }

  // ── 3b. Test Suite History API ───────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/history") {
    try {
      const sites = listSites();
      const payload = sites.map(s => ({
        ...s,
        sprints: listSprints(s.domain).map(sp => ({
          ...sp,
          runs: listRuns(s.domain, sp.sprint).slice(0, 5)  // last 5 runs per sprint
        }))
      }));
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── 3. SSE stream for live dashboard ────────────────────────────────────────
  if (req.method === "GET" && req.url === "/stream") {
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive"
    });
    res.write(`data: ${JSON.stringify(currentRun)}\n\n`);
    sseClients.push(res);
    req.on("close", () => sseClients.splice(sseClients.indexOf(res), 1));
    return;
  }

  // ── 4. Serve dashboard ───────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/dashboard") {
    const filePath = path.join(__dirname, "dashboard.html");
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end("Dashboard not found"); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }

  // ── 5. Serve shop.html ──────────────────────────────────────────────────────
  if (req.method === "GET" && (req.url === "/" || req.url === "/shop" || req.url === "/shop.html")) {
    const filePath = path.join(__dirname, "shop.html");
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end("Error loading page"); return; }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log("\n========================================");
  console.log("         DemoShop — Running             ");
  console.log("========================================");
  console.log(`   Shop      : http://localhost:${PORT}`);
  console.log(`   Dashboard : http://localhost:${PORT}/dashboard`);
  console.log(`   Gemini  : ${process.env.GEMINI_API_KEY ? "connected" : "not configured"}`);
  console.log(`   Jira    : ${process.env.JIRA_BASE_URL  ? "connected" : "not configured"}`);
  const reviewBase = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
  console.log(`   Reviews : Accept/Decline links → ${reviewBase}`);
  if (!process.env.APP_BASE_URL) {
    console.log(`             ⚠️  localhost links only work on THIS PC. For a phone/other`);
    console.log(`             device, run 'ngrok http 3000' and set APP_BASE_URL in .env.`);
  }
  console.log("========================================\n");

  // Auto-open the browser only on a local Windows machine (never on a host).
  if (!process.env.RENDER && process.platform === "win32") {
    require("child_process").exec(`start http://localhost:${PORT}`);
  }
});
