// list-models.js — shows all Gemini models available for your API key
require("dotenv").config();
const https = require("https");

const key = process.env.GEMINI_API_KEY;

console.log("\n🔍 Fetching available Gemini models for your API key...\n");

https.get(
  `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
  { rejectUnauthorized: false },
  (res) => {
    let data = "";
    res.on("data", c => (data += c));
    res.on("end", () => {
      const models = JSON.parse(data).models || [];
      const usable = models.filter(m =>
        m.supportedGenerationMethods?.includes("generateContent")
      );
      console.log(`✅ Models that support generateContent:\n`);
      usable.forEach(m => {
        const name = m.name.replace("models/", "");
        console.log(`   "${name}"  →  ${m.displayName}`);
      });
      console.log(`\nTotal: ${usable.length} models available\n`);
    });
  }
).on("error", err => console.log(`❌ Error: ${err.message}`));
