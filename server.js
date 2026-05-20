require("dotenv").config();
const http              = require("http");
const fs                = require("fs");
const path              = require("path");
const Sentry            = require("@sentry/node");
const { runAutomation } = require("./automation");

const PORT = 3000;

// ── Sentry (server-side) ─────────────────────────────────────────────────────
Sentry.init({
  dsn:         process.env.SENTRY_DSN,
  environment: "development",
  tracesSampleRate: 1.0
});

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {

  // ── 1. Sentry webhook — called by Sentry when a new issue is created ───────
  if (req.method === "POST" && req.url === "/sentry-webhook") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", async () => {
      res.writeHead(200);
      res.end("ok");

      try {
        const payload = JSON.parse(body);
        console.log("\n[SENTRY WEBHOOK] New issue received:", payload.data?.issue?.title || "unknown");
        await runAutomation(payload);
      } catch (err) {
        console.error("[SENTRY WEBHOOK] Failed to process:", err.message);
        Sentry.captureException(err);
      }
    });
    return;
  }

  // ── 2. Bug log from frontend — terminal + Sentry + full automation ──────────
  if (req.method === "POST" && req.url === "/log-bug") {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try {
        const { field, message, data } = JSON.parse(body);
        const timestamp = new Date().toLocaleTimeString();

        // Print to terminal
        console.error(
          `\n[${timestamp}] ISSUE DETECTED\n` +
          `  Field   : ${field}\n` +
          `  Error   : ${message}\n` +
          `  Value   : ${data}\n`
        );

        // Send to Sentry dashboard
        Sentry.withScope(scope => {
          scope.setTag("field", field);
          scope.setExtra("value", data);
          scope.setLevel("warning");
          Sentry.captureMessage(`${field}: ${message}`);
        });

        // Run full automation: Gemini → Jira → Email
        runAutomation({
          data: {
            issue: {
              title:     `${field}: ${message}`,
              level:     "error",
              culprit:   field,
              firstSeen: new Date().toISOString(),
              metadata:  { type: field, value: data },
              project:   { name: "Sports Registration App" }
            }
          }
        }).catch(err => console.error("[Automation Error]", err.message));

      } catch (_) {}
      res.writeHead(200);
      res.end();
    });
    return;
  }

  // ── 3. Serve shop.html ─────────────────────────────────────────────────────
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
  console.log(`   Browser  : http://localhost:${PORT}`);
  console.log(`   Sentry   : ${process.env.SENTRY_DSN ? "connected" : "not configured (add SENTRY_DSN to .env)"}`);
  console.log(`   Gemini   : ${process.env.GEMINI_API_KEY ? "connected" : "not configured (add GEMINI_API_KEY to .env)"}`);
  console.log(`   Jira     : ${process.env.JIRA_BASE_URL ? "connected" : "not configured (add JIRA_BASE_URL to .env)"}`);
  console.log(`   Email    : via Jira notifications (automatic)`);
  console.log("========================================\n");

  const { exec } = require("child_process");
  exec(`start http://localhost:${PORT}`);
});
