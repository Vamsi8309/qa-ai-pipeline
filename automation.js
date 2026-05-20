require("dotenv").config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const JIRA_AUTH = Buffer.from(
  `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
).toString("base64");

async function createJiraTicket({ title, description, priority, labels }) {
  const url = `${process.env.JIRA_BASE_URL}/rest/api/3/issue`;

  const body = {
    fields: {
      project:     { key: process.env.JIRA_PROJECT_KEY },
      summary:     title,
      description: {
        type: "doc", version: 1,
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: description }]
        }]
      },
      issuetype: { name: "Bug" },
      priority:  { name: priority },
      labels,
      assignee:  { accountId: process.env.JIRA_ACCOUNT_ID }
    }
  };

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Authorization": `Basic ${JIRA_AUTH}`,
      "Content-Type":  "application/json",
      "Accept":        "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Jira ${res.status}: ${err}`);
  }

  const data = await res.json();
  const ticketUrl = `${process.env.JIRA_BASE_URL}/browse/${data.key}`;
  console.log(`   🎫 Jira ticket created: ${data.key} → ${ticketUrl}`);
  return ticketUrl;
}

function buildSentryUrl(issueId) {
  return `https://${process.env.SENTRY_ORG_SLUG}.sentry.io/issues/${issueId}/`;
}

function getAgingInfo(firstSeen, level) {
  const daysOld = Math.floor((Date.now() - new Date(firstSeen)) / 86400000);
  const isUrgent = (level === "error" || level === "fatal") && daysOld >= 15;
  return { daysOld, isUrgent };
}

async function runAutomation(sentryPayload) {
  const issue      = sentryPayload.data?.issue || sentryPayload;
  const errorTitle = issue.title       || "Unknown Error";
  const errorLevel = issue.level       || "error";
  const culprit    = issue.culprit     || "Unknown location";
  const firstSeen  = issue.firstSeen   || new Date().toISOString();
  const issueId    = issue.id          || "";
  const sentryUrl  = issue.permalink   || buildSentryUrl(issueId);
  const errorType  = issue.metadata?.type  || errorTitle;
  const errorValue = issue.metadata?.value || "";
  const project    = issue.project?.name   || "DemoShop";

  const { daysOld, isUrgent } = getAgingInfo(firstSeen, errorLevel);

  // ── Gemini analysis ──────────────────────────────────────
  const prompt = `
You are a senior software engineer reviewing a bug report.

Project: ${project}
Error: ${errorType} — ${errorValue}
Location: ${culprit}
Severity: ${errorLevel}
Open for: ${daysOld} day(s)

Reply ONLY with valid JSON (no markdown, no code fences):
{
  "brokenCode": "One sentence describing what code is broken and why",
  "fixes": ["Fix 1", "Fix 2", "Fix 3"],
  "emailBody": "Professional 3-sentence summary for the dev team"
}`;

  let ai = {
    brokenCode: `Error in ${culprit}: ${errorValue || errorTitle}`,
    fixes: [
      "Review and add input validation at the culprit location",
      "Add try/catch error handling around the failing operation",
      "Write a unit test to cover this edge case"
    ],
    emailBody: `A ${errorLevel}-level error "${errorTitle}" was detected in ${project} at ${culprit}. The issue has been open for ${daysOld} day(s). Please review the Jira ticket for full context and suggested fixes.`
  };

  try {
    const result  = await model.generateContent(prompt);
    const rawText = result.response.text().trim()
      .replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    ai = JSON.parse(rawText);
  } catch (_) {
    // Gemini unavailable — fallback values used silently
  }

  // ── Create Jira ticket ───────────────────────────────────
  const priority = isUrgent ? "Highest" : errorLevel === "fatal" ? "High" : "Medium";
  const labels   = isUrgent ? ["bug", "sentry", "URGENT"] : ["bug", "sentry"];

  const jiraDesc =
    `SENTRY ISSUE: ${errorTitle}\n\n` +
    `Error     : ${errorValue}\n` +
    `Location  : ${culprit}\n` +
    `Severity  : ${errorLevel.toUpperCase()}\n` +
    `First seen: ${firstSeen} (${daysOld} days ago)\n` +
    `Sentry URL: ${sentryUrl}\n\n` +
    `GEMINI ANALYSIS — Broken Code:\n${ai.brokenCode}\n\n` +
    `SUGGESTED FIXES:\n${ai.fixes.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;

  try {
    await createJiraTicket({
      title:       `[${errorLevel.toUpperCase()}] ${errorTitle}`,
      description: jiraDesc,
      priority,
      labels
    });
  } catch (_) {
    // Jira unavailable — ticket creation skipped silently
  }
}

module.exports = { runAutomation };
