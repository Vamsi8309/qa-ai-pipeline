// setup-jira.js — run once to auto-set JIRA_ACCOUNT_ID in .env
require("dotenv").config();
const https = require("https");
const fs    = require("fs");

const auth = Buffer.from(
  `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
).toString("base64");

const base = new URL(process.env.JIRA_BASE_URL);

console.log(`\n🔍 Fetching your Jira account ID from ${base.hostname}...\n`);

const req = https.request({
  hostname:           base.hostname,
  port:               443,
  path:               "/rest/api/3/myself",
  method:             "GET",
  headers:            { "Authorization": `Basic ${auth}`, "Accept": "application/json" },
  rejectUnauthorized: false
}, (res) => {
  let data = "";
  res.on("data", c => (data += c));
  res.on("end", () => {
    if (res.statusCode !== 200) {
      console.log(`❌ Failed (${res.statusCode}): ${data.slice(0, 200)}`);
      return;
    }

    const user = JSON.parse(data);
    const accountId = user.accountId;

    console.log(`✅ Found:`);
    console.log(`   Name       : ${user.displayName}`);
    console.log(`   Email      : ${user.emailAddress}`);
    console.log(`   Account ID : ${accountId}\n`);

    // Auto-update JIRA_ACCOUNT_ID in .env
    let env = fs.readFileSync(".env", "utf8");
    env = env.replace(/^JIRA_ACCOUNT_ID=.*$/m, `JIRA_ACCOUNT_ID=${accountId}`);
    fs.writeFileSync(".env", env, "utf8");

    console.log(`✅ JIRA_ACCOUNT_ID saved to .env`);
    console.log(`\nNow run:  pm2 restart qa-pipeline\n`);
    console.log(`All future bug tickets will be assigned to: ${user.displayName}`);
  });
});

req.on("error", err => console.log(`❌ Network error: ${err.message}`));
req.end();
