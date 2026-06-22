require("dotenv").config();
const Groq                   = require("groq-sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Resend }             = require("resend");
const nodemailer             = require("nodemailer");
const https                  = require("https");
const reviewStore            = require("./review-store");

const groq  = new Groq({ apiKey: process.env.GROQ_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModels = [
  genAI.getGenerativeModel({ model: "gemini-2.0-flash" }),
  genAI.getGenerativeModel({ model: "gemini-2.0-flash-001" }),
];

// ── Pure Node.js HTTPS for Jira (works on Linux/Render + Windows) ─────────────
// Auth is computed inside the function so env vars are always fresh (important on Render)
function jiraRequest(apiPath, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const base    = new URL(process.env.JIRA_BASE_URL);
    const auth    = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString("base64");
    const bodyStr = body ? JSON.stringify(body) : null;

    const headers = {
      "Authorization": `Basic ${auth}`,
      "Accept":        "application/json",
      "Content-Type":  "application/json"
    };
    // Content-Length is required — Jira Cloud rejects chunked POST requests
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr, "utf8");

    const opts = {
      hostname:           base.hostname,
      port:               443,
      path:               apiPath,
      method,
      headers,
      rejectUnauthorized: false   // bypass corporate SSL proxy
    };

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          // Log the real Jira error so we can debug it
          console.log(`   ❌ Jira ${method} ${apiPath} → HTTP ${res.statusCode}`);
          try {
            const err = JSON.parse(data);
            const msgs = err.errors ? Object.values(err.errors).join(", ") : "";
            const errs = err.errorMessages?.join(", ") || msgs || data.slice(0, 200);
            console.log(`   ❌ Jira error detail: ${errs}`);
          } catch (_) {
            console.log(`   ❌ Jira raw response: ${data.slice(0, 200)}`);
          }
        }
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Jira request timed out")); });
    req.on("error", (err) => {
      console.log(`   ❌ Jira network error: ${err.message}`);
      reject(err);
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function postJira(fields) {
  const res = await jiraRequest("/rest/api/3/issue", "POST", { fields });
  if (res.status >= 400) throw new Error(`${res.status}::${res.body}`);
  const parsed = JSON.parse(res.body);
  if (!parsed.key) throw new Error(`No key in response: ${res.body.slice(0, 100)}`);
  return parsed.key;
}

// ── Unified email sender ──────────────────────────────────────────────────────
// EMAIL_PROVIDER=smtp  → Gmail/SMTP via nodemailer (can email ANY recipient, but
//                        needs a network that allows outbound SMTP 465/587).
// EMAIL_PROVIDER=resend (default) → Resend HTTP API (works through corporate
//                        proxies, but the sandbox sender only delivers to the
//                        Resend account owner until a domain is verified).
let _smtpTransport = null;
function smtpTransport() {
  if (_smtpTransport) return _smtpTransport;
  const port = parseInt(process.env.SMTP_PORT || "465", 10);
  _smtpTransport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure: port === 465,                       // 465 = SSL, 587 = STARTTLS
    auth: {
      user: process.env.SMTP_USER || process.env.EMAIL_FROM,
      pass: (process.env.SMTP_PASS || process.env.EMAIL_APP_PASSWORD || "").replace(/\s+/g, "")
    },
    tls: { rejectUnauthorized: false },         // tolerate corporate proxy certs
    connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 15000,
    family: 4                                   // force IPv4
  });
  return _smtpTransport;
}

async function sendMail({ to, subject, html }) {
  if (!to) return { status: "failed", error: "no recipient" };
  const provider = (process.env.EMAIL_PROVIDER || "resend").toLowerCase();

  if (provider === "smtp") {
    const user = process.env.SMTP_USER || process.env.EMAIL_FROM;
    const pass = (process.env.SMTP_PASS || process.env.EMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
    if (!user || !pass || pass === "your_gmail_app_password_here") {
      console.log("   📧 SMTP not configured — set EMAIL_FROM + EMAIL_APP_PASSWORD in .env");
      return { status: "skipped" };
    }
    try {
      const info = await smtpTransport().sendMail({ from: `"QA AI Pipeline" <${user}>`, to, subject, html });
      console.log(`   📧 [SMTP] sent → ${to} (${info.messageId})`);
      return { status: "sent", to, id: info.messageId };
    } catch (err) {
      console.log(`   ⚠️  [SMTP] send failed → ${to}: ${(err.message || "").split("\n")[0]}`);
      return { status: "failed", to, error: err.message };
    }
  }

  // default → Resend (HTTP)
  if (!process.env.RESEND_API_KEY) {
    console.log("   📧 Email skipped — RESEND_API_KEY not set in .env");
    return { status: "skipped" };
  }
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM || "QA AI Pipeline <onboarding@resend.dev>",
      to, subject, html
    });
    if (error) {
      const msg = error.message || JSON.stringify(error);
      console.log(`   ⚠️  [Resend] rejected → ${to}: ${msg}`);
      return { status: "failed", to, error: msg };
    }
    console.log(`   📧 [Resend] sent → ${to} (${data?.id})`);
    return { status: "sent", to, id: data?.id };
  } catch (err) {
    console.log(`   ⚠️  [Resend] failed → ${to}: ${err.message}`);
    return { status: "failed", to, error: err.message };
  }
}

// ── Bug notification email (sent after a ticket is created on Accept) ──────────
async function sendBugEmail({ bugTitle, category, area, jiraUrl, reason, fixes, actual, expected }) {
  const to    = process.env.EMAIL_TO || process.env.EMAIL_FROM;
  const emoji = { Security:"🔴", Backend:"🟠", Frontend:"🟡", Performance:"🔵", Trivial:"⚪" }[category] || "🐛";
  const fixList = (fixes || []).map((f, i) => `<li style="margin:4px 0">${i + 1}. ${f}</li>`).join("");

  const html = `
  <div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:0 auto;background:#0d1117;color:#c9d1d9;border-radius:8px;overflow:hidden">
    <div style="background:#161b22;padding:20px 28px;border-bottom:2px solid #f85149">
      <h2 style="margin:0;color:#f0f6fc">${emoji} Bug Assigned to You</h2>
      <p style="margin:6px 0 0;color:#8b949e;font-size:14px">QA AI Pipeline — Automated Bug Report</p>
    </div>
    <div style="padding:24px 28px">
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <tr><td style="padding:8px 12px;background:#161b22;color:#8b949e;width:140px;border:1px solid #30363d;font-size:13px">Bug Title</td>
            <td style="padding:8px 12px;background:#0d1117;color:#f0f6fc;border:1px solid #30363d;font-size:13px;font-weight:600">${bugTitle}</td></tr>
        <tr><td style="padding:8px 12px;background:#161b22;color:#8b949e;border:1px solid #30363d;font-size:13px">Category</td>
            <td style="padding:8px 12px;background:#0d1117;color:#f0f6fc;border:1px solid #30363d;font-size:13px">${emoji} ${category}</td></tr>
        <tr><td style="padding:8px 12px;background:#161b22;color:#8b949e;border:1px solid #30363d;font-size:13px">Area</td>
            <td style="padding:8px 12px;background:#0d1117;color:#f0f6fc;border:1px solid #30363d;font-size:13px">${area || category}</td></tr>
        <tr><td style="padding:8px 12px;background:#161b22;color:#8b949e;border:1px solid #30363d;font-size:13px">Expected</td>
            <td style="padding:8px 12px;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;font-size:13px">${expected || "—"}</td></tr>
        <tr><td style="padding:8px 12px;background:#161b22;color:#8b949e;border:1px solid #30363d;font-size:13px">Actual</td>
            <td style="padding:8px 12px;background:#2a0f0f;color:#f85149;border:1px solid #30363d;font-size:13px">${actual || "—"}</td></tr>
      </table>

      <div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:16px;margin-bottom:16px">
        <p style="margin:0 0 8px;color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:1px">🤖 AI Classification Reason</p>
        <p style="margin:0;color:#c9d1d9;font-size:14px">${reason || "—"}</p>
      </div>

      <div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:16px;margin-bottom:20px">
        <p style="margin:0 0 10px;color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:1px">✅ Suggested Fixes</p>
        <ul style="margin:0;padding-left:16px;color:#c9d1d9;font-size:14px">${fixList || "<li>Review and fix the identified issue</li>"}</ul>
      </div>

      ${jiraUrl ? `<a href="${jiraUrl}" style="display:inline-block;background:#1f6feb;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">🎫 View Jira Ticket</a>` : ""}
    </div>
    <div style="padding:14px 28px;background:#161b22;border-top:1px solid #30363d;font-size:12px;color:#6e7681">
      Auto-generated by QA AI Pipeline · ${new Date().toLocaleString()}
    </div>
  </div>`;

  return sendMail({
    to,
    subject: `${emoji} [${String(category).toUpperCase()}] Bug Assigned: ${bugTitle}`,
    html
  });
}

// ── Base URL used to build the Accept / Decline links in review emails ────────
// Must be reachable from wherever the tester opens the email. For local demos
// this is localhost; set APP_BASE_URL in .env when deploying (e.g. on Render).
function appBaseUrl() {
  return (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
}

// ── Resend email asking the tester to APPROVE or REJECT a failed test case ────
// Contains two buttons: Accept → server creates the Jira ticket; Decline →
// server discards it. No Jira ticket exists until the tester accepts.
async function sendReviewEmail(review) {
  const to    = review.recipient || process.env.TESTER_EMAIL || process.env.EMAIL_TO || process.env.EMAIL_FROM;
  const emoji = (CATEGORY_CONFIG[review.category] || {}).emoji || "🐛";

  const base       = `${appBaseUrl()}/review/${review.id}`;
  const acceptUrl  = `${base}/accept?token=${review.token}`;
  const declineUrl = `${base}/decline?token=${review.token}`;

  const fixList = (review.fixes || []).map((f, i) => `<li style="margin:4px 0">${i + 1}. ${f}</li>`).join("");

  const html = `
  <div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:0 auto;background:#0d1117;color:#c9d1d9;border-radius:8px;overflow:hidden">
    <div style="background:#161b22;padding:20px 28px;border-bottom:2px solid #d29922">
      <h2 style="margin:0;color:#f0f6fc">${emoji} Failed Test — Your Review Needed</h2>
      <p style="margin:6px 0 0;color:#8b949e;font-size:14px">QA AI Pipeline — approve to log this bug in Jira</p>
    </div>
    <div style="padding:24px 28px">
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <tr><td style="padding:8px 12px;background:#161b22;color:#8b949e;width:140px;border:1px solid #30363d;font-size:13px">Test Case</td>
            <td style="padding:8px 12px;background:#0d1117;color:#f0f6fc;border:1px solid #30363d;font-size:13px;font-weight:600">${review.testCaseId || "—"} — ${review.title}</td></tr>
        <tr><td style="padding:8px 12px;background:#161b22;color:#8b949e;border:1px solid #30363d;font-size:13px">Category</td>
            <td style="padding:8px 12px;background:#0d1117;color:#f0f6fc;border:1px solid #30363d;font-size:13px">${emoji} ${review.category}</td></tr>
        <tr><td style="padding:8px 12px;background:#161b22;color:#8b949e;border:1px solid #30363d;font-size:13px">Expected</td>
            <td style="padding:8px 12px;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;font-size:13px">${review.expected || "—"}</td></tr>
        <tr><td style="padding:8px 12px;background:#161b22;color:#8b949e;border:1px solid #30363d;font-size:13px">Actual</td>
            <td style="padding:8px 12px;background:#2a0f0f;color:#f85149;border:1px solid #30363d;font-size:13px">${review.actual || "—"}</td></tr>
      </table>

      <div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:16px;margin-bottom:16px">
        <p style="margin:0 0 8px;color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:1px">🤖 AI Classification Reason</p>
        <p style="margin:0;color:#c9d1d9;font-size:14px">${review.reason || "—"}</p>
      </div>

      <div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:16px;margin-bottom:24px">
        <p style="margin:0 0 10px;color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:1px">✅ Suggested Fixes</p>
        <ul style="margin:0;padding-left:16px;color:#c9d1d9;font-size:14px">${fixList || "<li>Review and fix the identified issue</li>"}</ul>
      </div>

      <p style="margin:0 0 14px;color:#c9d1d9;font-size:14px">Is this a real bug that should be logged in the Jira backlog?</p>
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="padding-right:12px">
          <a href="${acceptUrl}" style="display:inline-block;background:#238636;color:#fff;text-decoration:none;padding:12px 26px;border-radius:6px;font-size:15px;font-weight:700">✓ Accept — Log to Jira</a>
        </td>
        <td>
          <a href="${declineUrl}" style="display:inline-block;background:#da3633;color:#fff;text-decoration:none;padding:12px 26px;border-radius:6px;font-size:15px;font-weight:700">✕ Decline — Not a Bug</a>
        </td>
      </tr></table>
    </div>
    <div style="padding:14px 28px;background:#161b22;border-top:1px solid #30363d;font-size:12px;color:#6e7681">
      Auto-generated by QA AI Pipeline · ${new Date().toLocaleString()} · No Jira ticket is created until you click Accept.
    </div>
  </div>`;

  const result = await sendMail({ to, subject: `${emoji} [REVIEW NEEDED] ${review.title}`, html });
  if (result.status === "sent") {
    console.log(`   📧 Review email → ${to} (Accept / Decline)`);
  }
  return result;
}

// ── Category config ───────────────────────────────────────────────────────────
const CATEGORY_CONFIG = {
  Security:    { priority: "Highest", emoji: "🔴", logToJira: true,  dueDays: 3,  storyPoints: 8 },
  Backend:     { priority: "High",    emoji: "🟠", logToJira: true,  dueDays: 7,  storyPoints: 5 },
  Frontend:    { priority: "Medium",  emoji: "🟡", logToJira: true,  dueDays: 14, storyPoints: 3 },
  Performance: { priority: "Medium",  emoji: "🔵", logToJira: true,  dueDays: 14, storyPoints: 3 },
  Trivial:     { priority: "Low",     emoji: "⚪", logToJira: false, dueDays: 30, storyPoints: 1 }
};

// ── Fetch Jira context (assignee + active sprint) ────────────────────────────
let _jiraAccountId   = process.env.JIRA_ACCOUNT_ID || null;
let _jiraSprintId    = null;
let _jiraContextDone = false;

async function loadJiraContext() {
  if (_jiraContextDone && _jiraAccountId) return;  // retry if accountId missing

  // Step 1: use env var if already set
  if (process.env.JIRA_ACCOUNT_ID) {
    _jiraAccountId = process.env.JIRA_ACCOUNT_ID;
    console.log(`   👤 Jira assignee (from env): ${_jiraAccountId}`);
  }

  // Step 2: auto-fetch from /myself if not set
  if (!_jiraAccountId) {
    try {
      const res = await jiraRequest("/rest/api/3/myself");
      if (res.status === 200) {
        const me = JSON.parse(res.body);
        _jiraAccountId = me.accountId;
        console.log(`   👤 Jira assignee (auto): ${me.displayName} → ${_jiraAccountId}`);
      }
    } catch (_) {}
  }

  // Step 3: fallback — search by email
  if (!_jiraAccountId && process.env.JIRA_EMAIL) {
    try {
      const email = encodeURIComponent(process.env.JIRA_EMAIL);
      const res   = await jiraRequest(`/rest/api/3/user/search?query=${email}`);
      if (res.status === 200) {
        const users = JSON.parse(res.body);
        if (users.length > 0) {
          _jiraAccountId = users[0].accountId;
          console.log(`   👤 Jira assignee (by email): ${users[0].displayName} → ${_jiraAccountId}`);
        }
      }
    } catch (_) {}
  }

  if (!_jiraAccountId) {
    console.log(`   ⚠️  Could not resolve Jira account ID — tickets will be unassigned`);
  }

  _jiraContextDone = true;

  // Step 4: get active sprint
  try {
    const res = await jiraRequest("/rest/agile/1.0/board/1/sprint?state=active&maxResults=1");
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      if (data.values?.length > 0) {
        _jiraSprintId = data.values[0].id;
        console.log(`   🏃 Active sprint: ${_jiraSprintId}`);
      }
    }
  } catch (_) {}
}

// ── Rich ADF description builder ──────────────────────────────────────────────
function buildADF({ title, testCase, area, category, expected, actual, classificationReason, brokenCode, fixes }) {
  const emoji = (CATEGORY_CONFIG[category] || {}).emoji || "🐛";

  const p  = (txt) => ({ type: "paragraph", content: [{ type: "text", text: String(txt || "—") }] });
  const h  = (lvl, txt) => ({ type: "heading", attrs: { level: lvl }, content: [{ type: "text", text: txt }] });
  const hr = () => ({ type: "rule" });
  const row = (label, value) => ({
    type: "tableRow",
    content: [
      { type: "tableHeader", attrs: {}, content: [p(label)] },
      { type: "tableCell",   attrs: {}, content: [p(value)] }
    ]
  });
  const table = (rows) => ({
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: rows
  });
  const bullets = (items) => ({
    type: "bulletList",
    content: (items || []).map(item => ({
      type: "listItem",
      content: [p(item)]
    }))
  });

  return {
    type: "doc", version: 1,
    content: [
      h(2, `${emoji} ${title}`),
      hr(),
      h(3, "📋 Test Details"),
      table([
        row("Test Case ID",         testCase  || "—"),
        row("Area",                 area      || category || "—"),
        row("Severity",             "🔴 ERROR"),
        row("Category",             `${emoji} ${category}`),
        row("Expected Behaviour",   expected  || "—"),
        row("Actual Behaviour",     actual    || "—"),
      ]),
      h(3, "🤖 AI Classification"),
      p(classificationReason || "—"),
      h(3, "🔧 Root Cause"),
      p(brokenCode || "—"),
      h(3, "✅ Suggested Fixes"),
      bullets(fixes && fixes.length ? fixes : ["Review and fix the identified issue."]),
      hr(),
      p(`Auto-detected by DemoShop AI Bug Pipeline on ${new Date().toLocaleString()}`)
    ]
  };
}

// ── Jira ticket creator ───────────────────────────────────────────────────────
async function createJiraTicket({ title, adfDescription, priority, labels, category, dueDays, storyPoints }) {
  await loadJiraContext();

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + (dueDays || 14));
  const dueDateStr = dueDate.toISOString().split("T")[0];

  // Build field sets from most detailed → simplest, each a clean object (no undefined keys)
  const core = {
    project:     { key: process.env.JIRA_PROJECT_KEY },
    summary:     title,
    description: adfDescription,
    issuetype:   { name: "Bug" }
  };

  const withAll = {
    ...core,
    priority:          { name: priority },
    duedate:           dueDateStr,
    labels,
    customfield_10016: storyPoints || 3
  };
  if (_jiraAccountId) withAll.assignee         = { accountId: _jiraAccountId };
  // Jira's create-issue API expects the Sprint field as a bare numeric id,
  // NOT an object — { id: n } triggers "Specify a valid value for Sprint" (400).
  if (_jiraSprintId)  withAll.customfield_10020 = _jiraSprintId;

  const withPriority   = { ...core, priority: { name: priority }, labels };
  const withLabels     = { ...core, labels };
  const minimal        = { ...core };
  const asTask         = { ...minimal, issuetype: { name: "Task" } };

  const attempts = [ withAll, withPriority, withLabels, minimal, asTask ];

  let lastErr = "";
  for (let i = 0; i < attempts.length; i++) {
    try {
      const key = await postJira(attempts[i]);
      const ticketUrl = `${process.env.JIRA_BASE_URL}/browse/${key}`;
      console.log(`   🎫 Jira ticket created: ${key} → ${ticketUrl}`);
      return ticketUrl;
    } catch (err) {
      lastErr = err.message;
      const status = parseInt(lastErr.split("::")[0]);
      if (status === 401 || status === 403) {
        console.log(`   ❌ Jira auth failed (${status}) — check JIRA_EMAIL and JIRA_API_TOKEN`);
        throw new Error(`Jira auth failed — ${status}`);
      }
      if (i < attempts.length - 1) console.log(`   ↩️  Attempt ${i + 1} failed, trying simpler fields…`);
    }
  }

  throw new Error(`Jira failed after all attempts — ${lastErr.slice(0, 200)}`);
}

function getAgingInfo(firstSeen, level) {
  const daysOld = Math.floor((Date.now() - new Date(firstSeen)) / 86400000);
  const isUrgent = (level === "error" || level === "fatal") && daysOld >= 15;
  return { daysOld, isUrgent };
}

// ── AI call: Groq primary → Gemini fallback ───────────────────────────────────
async function generateWithRetry(prompt, maxRetries = 4) {
  // Try Groq first (higher quota, faster)
  try {
    const response = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
      response_format: { type: "json_object" }
    });
    console.log("   🟢 Provider: Groq (Llama 3.3 70B)");
    return response.choices[0].message.content;
  } catch (groqErr) {
    const blocked = groqErr.status === 403 || groqErr.message?.includes("403") || groqErr.message?.includes("blocked");
    const groqMsg = blocked ? "blocked by network" : groqErr.message;
    console.log(`   ⚠️  Groq unavailable (${groqMsg}) — falling back to Gemini…`);
  }

  // Fallback: try gemini-2.0-flash first, then gemini-2.0-flash-001 if quota exceeded
  const modelNames = ["Gemini 2.5 Flash", "Gemini 1.5 Flash"];
  for (let m = 0; m < geminiModels.length; m++) {
    const model = geminiModels[m];
    const modelName = modelNames[m];

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        console.log(`   🔵 Provider: ${modelName} (fallback)`);
        return result.response.text().trim()
          .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
      } catch (err) {
        const isQuota   = err.message?.includes("quota") || err.message?.includes("RESOURCE_EXHAUSTED");
        const is429     = err.message?.includes("429");
        const is503     = err.message?.includes("503");
        const isRetryable = (is429 || is503) && !isQuota;

        if (isQuota) {
          console.log(`   ⚠️  ${modelName} quota exhausted — switching to next model…`);
          break;
        }

        if (!isRetryable || attempt === maxRetries) {
          console.log(`   ❌ ${modelName} failed (attempt ${attempt}): ${err.message}`);
          if (m === geminiModels.length - 1) throw err;
          break;
        }

        const match  = err.message.match(/retry in (\d+(?:\.\d+)?)s/i);
        const waitMs = is503 ? 15000 : (match ? Math.ceil(parseFloat(match[1])) * 1000 + 1000 : 30000);
        console.log(`   ⏳ ${modelName} ${is503 ? "overloaded" : "rate limited"} — waiting ${Math.ceil(waitMs / 1000)}s then retrying (${attempt}/${maxRetries})…`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  throw new Error("All Gemini models exhausted");
}

// ── Rule-based fallback classifier (works without any AI/internet) ────────────
function ruleBasedClassify(failure) {
  const text = `${failure.title} ${failure.errorValue} ${failure.expected}`.toLowerCase();

  let category = "Frontend";
  let reason   = "UI-related issue detected in test case.";
  let fixes    = ["Review the failing component", "Fix the identified issue", "Add proper validation"];

  if (text.match(/password|auth|login|credential|token|secret|encrypt|mask/)) {
    category = "Security";
    reason   = "Security issue — password or authentication related bug.";
    fixes    = ["Mask password fields with type='password'", "Never store credentials in plaintext", "Add proper authentication validation"];
  } else if (text.match(/payment|credit.?card|card.?number|cvv|billing|stripe/)) {
    category = "Security";
    reason   = "Security issue — payment data handling bug.";
    fixes    = ["Validate card number format", "Use PCI-compliant payment handling", "Add input masking for card fields"];
  } else if (text.match(/price|sort|calculat|total|sum|shipping|tax|discount|math|nan|division|numeric/)) {
    category = "Backend";
    reason   = "Backend logic error — calculation or sorting issue.";
    fixes    = ["Use numeric comparison instead of string comparison", "Fix the calculation formula", "Add input validation before calculations"];
  } else if (text.match(/performance|slow|timeout|load.?time|render|memory|speed/)) {
    category = "Performance";
    reason   = "Performance issue detected.";
    fixes    = ["Optimize the algorithm", "Add caching", "Reduce unnecessary re-renders"];
  } else if (text.match(/pattern|validation|required|format|regex|email|phone|tel/)) {
    category = "Backend";
    reason   = "Input validation missing or incorrect.";
    fixes    = ["Add proper input validation", "Set correct input type attribute", "Add pattern attribute for validation"];
  }

  return {
    category,
    classificationReason: reason,
    brokenCode: `Issue found in: ${failure.testCase || failure.id}`,
    fixes,
    emailBody: `Bug detected: ${failure.title}. ${reason}`
  };
}

// ── BATCH pipeline — ONE Groq call for ALL failures ──────────────────────────
// failures: [{ id, title, errorType, errorValue, culprit, expected, area, testCase }]
// onResult(result) is called immediately after each ticket is created/skipped
async function runBatchAutomation(failures, onResult = null) {
  if (failures.length === 0) return [];

  console.log(`\n🤖 Sending ${failures.length} failure(s) to Groq AI for batch classification…\n`);

  const prompt = `
You are a senior QA engineer. Classify ALL of these failing test cases from a DemoShop e-commerce app in ONE response.

Categories:
- Security    → password exposure, card data issues, auth bypass, data leaks
- Backend     → wrong calculations, logic errors, missing validation
- Frontend    → UI display bugs, broken labels, wrong counts, case-sensitivity
- Performance → inefficient algorithms, wrong sort methods
- Trivial     → cosmetic issues, minor text errors

Test cases to classify:
${failures.map((f, i) => `
[${i + 1}] ID: ${f.id}
    Name    : ${f.title}
    Expected: ${f.expected}
    Actual  : ${f.errorValue}
    Location: ${f.culprit}
`).join("")}

Reply ONLY with a valid JSON object containing a "results" array:
{
  "results": [
    {
      "id": "TC-XX",
      "category": "Security|Backend|Frontend|Performance|Trivial",
      "classificationReason": "One sentence explaining why",
      "brokenCode": "One sentence describing the broken code",
      "fixes": ["Fix 1", "Fix 2", "Fix 3"],
      "emailBody": "Professional 2-sentence summary for the dev team"
    }
  ]
}`;

  let classifications;
  try {
    const rawText = (await generateWithRetry(prompt)).trim()
      .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(rawText);
    classifications = parsed.results ?? parsed;
    console.log(`   🤖 AI classified ${classifications.length} failure(s)\n`);
  } catch (aiErr) {
    console.log(`   ⚠️  AI unavailable (${aiErr.message.slice(0, 60)}) — using rule-based classifier…\n`);
    classifications = failures.map(f => ({ id: f.id, ...ruleBasedClassify(f) }));
  }

  const output = [];

  for (const ai of classifications) {
    const failure = failures.find(f => f.id === ai.id);
    if (!failure) continue;

    if (!CATEGORY_CONFIG[ai.category]) ai.category = "Frontend";
    const catConfig = CATEGORY_CONFIG[ai.category];

    console.log(`   ${catConfig.emoji} ${ai.id} → ${ai.category}: ${ai.classificationReason}`);

    if (!catConfig.logToJira) {
      console.log(`   ⏭️  ${ai.id}: Trivial — skipping Jira but sending email`);
      await sendBugEmail({
        bugTitle:  failure.title,
        category:  ai.category,
        area:      failure.area || ai.category,
        jiraUrl:   null,
        reason:    ai.classificationReason,
        fixes:     ai.fixes,
        actual:    failure.errorValue,
        expected:  failure.expected
      });
      const item = { id: ai.id, logged: false, category: ai.category, reason: ai.classificationReason, jiraUrl: null };
      output.push(item);
      if (onResult) await onResult(item);
      continue;
    }

    // ── Human-in-the-loop: create a PENDING review and email the tester ─────
    // No Jira ticket is created here. The tester clicks Accept (→ server logs
    // it to Jira) or Decline (→ discarded) in the email. See server.js.
    const review = reviewStore.createReview({
      testCaseId:  failure.testCase || failure.id,
      title:       failure.title,
      ticketTitle: `[${ai.category.toUpperCase()}] ${failure.title}`,
      category:    ai.category,
      area:        failure.area || ai.category,
      expected:    failure.expected,
      actual:      failure.errorValue,
      reason:      ai.classificationReason,
      brokenCode:  ai.brokenCode,
      fixes:       ai.fixes,
      priority:    catConfig.priority,
      dueDays:     catConfig.dueDays,
      storyPoints: catConfig.storyPoints,
      recipient:   process.env.TESTER_EMAIL || process.env.EMAIL_TO || process.env.EMAIL_FROM
    });

    console.log(`   📨 ${ai.id}: sent to tester for approval (review ${review.id}) — no Jira ticket yet`);
    const mail = await sendReviewEmail(review);

    const item = {
      id:           ai.id,
      logged:       false,           // nothing in Jira until the tester accepts
      pendingReview: true,
      reviewId:     review.id,
      reviewStatus: "pending",
      emailStatus:  mail.status,
      category:     ai.category,
      reason:       ai.classificationReason,
      jiraUrl:      null,
      fixes:        ai.fixes
    };
    output.push(item);
    if (onResult) await onResult(item);
  }

  return output;
}

// ════════════════════════════════════════════════════════════════════════════
//  Semantic duplicate detection — does this bug already exist in the backlog?
// ════════════════════════════════════════════════════════════════════════════

// Pull the currently-open bugs from the Jira backlog (key + summary only).
async function fetchOpenBacklogBugs(maxResults = 50) {
  const jql = `project = "${process.env.JIRA_PROJECT_KEY}" AND statusCategory != Done ORDER BY created DESC`;
  const enc = encodeURIComponent(jql);
  // Try the new "enhanced search" endpoint first, then the legacy one.
  const paths = [
    `/rest/api/3/search/jql?jql=${enc}&maxResults=${maxResults}&fields=summary`,
    `/rest/api/3/search?jql=${enc}&maxResults=${maxResults}&fields=summary`
  ];
  for (const p of paths) {
    try {
      const res = await jiraRequest(p, "GET");
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (Array.isArray(data.issues)) {
          return data.issues.map(i => ({ key: i.key, summary: i.fields?.summary || "" }));
        }
      }
    } catch (_) { /* try next */ }
  }
  console.log("   ⚠️  Could not read Jira backlog for duplicate check — proceeding without it");
  return [];
}

// Keyword-overlap fallback used when the AI is unavailable.
function heuristicDuplicate(review, existing) {
  const norm = s => (s || "").toLowerCase()
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^[a-z]+-[\d-]+\s*[—-]\s*/i, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const newTokens = new Set(norm(review.title).split(" ").filter(w => w.length > 3));
  if (!newTokens.size) return null;
  let best = null;
  for (const b of existing) {
    const bt = new Set(norm(b.summary).split(" ").filter(w => w.length > 3));
    let common = 0; newTokens.forEach(t => { if (bt.has(t)) common++; });
    const score = common / newTokens.size;
    if (score >= 0.6 && (!best || score > best.confidence)) best = { key: b.key, confidence: score, reason: "keyword overlap (AI unavailable)" };
  }
  return best;
}

// Ask the LLM whether the new bug is the SAME defect as any existing one,
// even if worded differently. Falls back to the keyword heuristic on failure.
async function findDuplicateBug(review, existing) {
  if (!existing.length) return null;

  const list = existing.map((b, i) => `${i + 1}. [${b.key}] ${b.summary}`).join("\n");
  const prompt = `You are a senior QA triager. Decide whether the NEW bug describes the SAME underlying defect as any EXISTING backlog bug — even if the wording is completely different.

NEW BUG:
  Title   : ${review.title}
  Expected: ${review.expected}
  Actual  : ${review.actual}

EXISTING BACKLOG BUGS:
${list}

Reply with ONLY valid JSON (no markdown):
{ "duplicateKey": "<the matching KEY, or null if none>", "confidence": 0.0-1.0, "reason": "one short sentence" }
Only set duplicateKey when you are genuinely confident it is the same defect.`;

  try {
    const raw = (await generateWithRetry(prompt)).trim()
      .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(raw);
    if (parsed.duplicateKey && parsed.confidence >= 0.7 && existing.some(b => b.key === parsed.duplicateKey)) {
      return { key: parsed.duplicateKey, confidence: parsed.confidence, reason: parsed.reason || "AI semantic match" };
    }
    return null;
  } catch (_) {
    return heuristicDuplicate(review, existing);
  }
}

// Add a comment to an existing Jira issue noting the duplicate.
async function addJiraComment(key, text) {
  try {
    await jiraRequest(`/rest/api/3/issue/${key}/comment`, "POST", {
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
    });
  } catch (_) { /* non-fatal */ }
}

// Email the tester: this bug already exists in the backlog (no new ticket made).
async function sendDuplicateEmail(review, dup) {
  const to      = review.recipient || process.env.TESTER_EMAIL || process.env.EMAIL_TO || process.env.EMAIL_FROM;
  const emoji   = (CATEGORY_CONFIG[review.category] || {}).emoji || "🐛";
  const jiraUrl = `${process.env.JIRA_BASE_URL}/browse/${dup.key}`;
  const pct     = Math.round((dup.confidence || 0) * 100);

  const html = `
  <div style="font-family:Segoe UI,sans-serif;max-width:600px;margin:0 auto;background:#0d1117;color:#c9d1d9;border-radius:8px;overflow:hidden">
    <div style="background:#161b22;padding:20px 28px;border-bottom:2px solid #d29922">
      <h2 style="margin:0;color:#f0f6fc">🔁 Already in the Backlog — No New Ticket Created</h2>
      <p style="margin:6px 0 0;color:#8b949e;font-size:14px">QA AI Pipeline — duplicate bug detected</p>
    </div>
    <div style="padding:24px 28px">
      <p style="margin:0 0 16px;font-size:14px">The failure you reviewed is already tracked in Jira, so no duplicate ticket was created.</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <tr><td style="padding:8px 12px;background:#161b22;color:#8b949e;width:150px;border:1px solid #30363d;font-size:13px">Your test case</td>
            <td style="padding:8px 12px;background:#0d1117;color:#f0f6fc;border:1px solid #30363d;font-size:13px">${review.testCaseId || "—"} — ${review.title}</td></tr>
        <tr><td style="padding:8px 12px;background:#161b22;color:#8b949e;border:1px solid #30363d;font-size:13px">Category</td>
            <td style="padding:8px 12px;background:#0d1117;color:#f0f6fc;border:1px solid #30363d;font-size:13px">${emoji} ${review.category}</td></tr>
        <tr><td style="padding:8px 12px;background:#161b22;color:#8b949e;border:1px solid #30363d;font-size:13px">Existing ticket</td>
            <td style="padding:8px 12px;background:#0d1117;color:#f0f6fc;border:1px solid #30363d;font-size:13px;font-weight:600">${dup.key}</td></tr>
        <tr><td style="padding:8px 12px;background:#161b22;color:#8b949e;border:1px solid #30363d;font-size:13px">Match confidence</td>
            <td style="padding:8px 12px;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;font-size:13px">${pct}% — ${dup.reason || "semantic match"}</td></tr>
      </table>
      <a href="${jiraUrl}" style="display:inline-block;background:#d29922;color:#0d1117;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:700">🎫 View existing ${dup.key}</a>
    </div>
    <div style="padding:14px 28px;background:#161b22;border-top:1px solid #30363d;font-size:12px;color:#6e7681">
      Auto-detected by QA AI Pipeline · ${new Date().toLocaleString()}
    </div>
  </div>`;

  const result = await sendMail({ to, subject: `🔁 [DUPLICATE] Already logged as ${dup.key} — ${review.title}`, html });
  if (result.status === "sent") console.log(`   📧 Duplicate notice → ${to} (already exists as ${dup.key})`);
  return result;
}

// ── Called by the server when a tester ACCEPTS a review → create Jira ticket ──
// First checks the backlog for a semantic duplicate. If found, links to the
// existing ticket instead of creating a new one. Otherwise creates the ticket
// and emails a confirmation. Returns { jiraUrl, duplicate, duplicateKey }.
async function createTicketForReview(review) {
  // 1) Semantic duplicate check against the live Jira backlog
  console.log(`   🔎 Checking backlog for duplicates of "${review.title}"…`);
  const existing = await fetchOpenBacklogBugs();
  const dup = await findDuplicateBug(review, existing);
  if (dup) {
    const jiraUrl = `${process.env.JIRA_BASE_URL}/browse/${dup.key}`;
    console.log(`   🔁 Duplicate — ${review.testCaseId} matches ${dup.key} (${Math.round(dup.confidence * 100)}%): ${dup.reason}. No new ticket created.`);
    await addJiraComment(dup.key, `BugLens: tester-approved failure "${review.title}" (${review.testCaseId}) was detected as a duplicate of this issue (confidence ${Math.round(dup.confidence * 100)}%) — ${dup.reason}`);
    await sendDuplicateEmail(review, dup);   // notify the tester it already exists
    return { jiraUrl, duplicate: true, duplicateKey: dup.key, confidence: dup.confidence };
  }

  // 2) No duplicate → create the new ticket as before
  const jiraUrl = await createJiraTicket({
    title:          review.ticketTitle || `[${String(review.category || "BUG").toUpperCase()}] ${review.title}`,
    adfDescription: buildADF({
      title:                review.title,
      testCase:             review.testCaseId,
      area:                 review.area || review.category,
      category:             review.category,
      expected:             review.expected,
      actual:               review.actual,
      classificationReason: review.reason,
      brokenCode:           review.brokenCode,
      fixes:                review.fixes
    }),
    priority:    review.priority,
    labels:      ["bug", "demoshop", String(review.category || "").toLowerCase(), "tester-approved"],
    category:    review.category,
    dueDays:     review.dueDays,
    storyPoints: review.storyPoints
  });

  // Confirmation email (the original "bug assigned" style email, now with the link)
  await sendBugEmail({
    bugTitle: review.title,
    category: review.category,
    area:     review.area || review.category,
    jiraUrl,
    reason:   review.reason,
    fixes:    review.fixes,
    actual:   review.actual,
    expected: review.expected
  });

  return { jiraUrl, duplicate: false, duplicateKey: null };
}

// ── Single pipeline (used by playwright-runner & generate-tests) ──────────────
async function runAutomation(payload) {
  const issue      = payload.data?.issue || payload;
  const errorTitle = issue.title       || "Unknown Error";
  const errorLevel = issue.level       || "error";
  const culprit    = issue.culprit     || "Unknown location";
  const firstSeen  = issue.firstSeen   || new Date().toISOString();
  const errorType  = issue.metadata?.type  || errorTitle;
  const errorValue = issue.metadata?.value || "";
  const project    = issue.project?.name   || "DemoShop";

  const { daysOld, isUrgent } = getAgingInfo(firstSeen, errorLevel);

  const prompt = `
You are a senior QA engineer reviewing a bug report from an e-commerce app.

Project : ${project}
Error   : ${errorType} — ${errorValue}
Location: ${culprit}
Severity: ${errorLevel}
Open for: ${daysOld} day(s)

Classify this bug into EXACTLY one of these categories:
- Security    → password exposure, card data issues, auth bypass, data leaks
- Backend     → wrong calculations, logic errors, missing validation on server
- Frontend    → UI display bugs, broken labels, wrong counts, case-sensitivity
- Performance → inefficient algorithms, wrong sort methods, unnecessary recalculations
- Trivial     → cosmetic issues, minor text errors, low-impact UI glitches

Reply ONLY with valid JSON (no markdown, no code fences):
{
  "category": "Security|Backend|Frontend|Performance|Trivial",
  "classificationReason": "One sentence explaining why this category was chosen",
  "brokenCode": "One sentence describing what code is broken and why",
  "fixes": ["Fix 1", "Fix 2", "Fix 3"],
  "emailBody": "Professional 2-sentence summary of this bug for the dev team"
}`;

  const rawText = (await generateWithRetry(prompt)).trim()
    .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const parsed  = JSON.parse(rawText);

  if (!CATEGORY_CONFIG[parsed.category]) parsed.category = "Frontend";
  const ai = parsed;
  console.log(`   🤖 AI classification complete`);

  const catConfig = CATEGORY_CONFIG[ai.category] || CATEGORY_CONFIG.Frontend;
  console.log(`   ${catConfig.emoji} Category : ${ai.category}`);
  console.log(`   📋 Reason   : ${ai.classificationReason}`);

  if (!catConfig.logToJira) {
    console.log(`   ⏭️  Skipping Jira — Trivial bug`);
    return { logged: false, category: ai.category, reason: ai.classificationReason, jiraUrl: null };
  }

  const priority = isUrgent ? "Highest" : catConfig.priority;
  const labels   = ["bug", "demoshop", ai.category.toLowerCase(), ...(isUrgent ? ["URGENT"] : [])];

  // ── Create Jira ticket (best effort) ──────────────────────────────────────
  let jiraUrl = null;
  try {
    jiraUrl = await createJiraTicket({
      title:          `[${ai.category.toUpperCase()}] ${errorTitle}`,
      adfDescription: buildADF({
        title:                errorTitle,
        testCase:             issue.metadata?.testCase || culprit,
        area:                 issue.metadata?.area || ai.category,
        category:             ai.category,
        expected:             issue.metadata?.expected || "See test case",
        actual:               errorValue,
        classificationReason: ai.classificationReason,
        brokenCode:           ai.brokenCode,
        fixes:                ai.fixes
      }),
      priority,
      labels,
      category:    ai.category,
      dueDays:     catConfig.dueDays,
      storyPoints: catConfig.storyPoints
    });
  } catch (err) {
    console.log(`   ⚠️  Jira error: ${err.message}`);
  }

  // ── Send email regardless of whether Jira succeeded ───────────────────────
  await sendBugEmail({
    bugTitle:  errorTitle,
    category:  ai.category,
    area:      issue.metadata?.area || ai.category,
    jiraUrl,
    reason:    ai.classificationReason,
    fixes:     ai.fixes,
    actual:    errorValue,
    expected:  issue.metadata?.expected || "See test case"
  });

  return { logged: !!jiraUrl, category: ai.category, reason: ai.classificationReason, jiraUrl, fixes: ai.fixes };
}

module.exports = { runAutomation, runBatchAutomation, createTicketForReview };
