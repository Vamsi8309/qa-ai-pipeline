// review-store.js — file-backed store for tester "accept / decline" reviews.
//
// The test runner (testrunner.js, story-runner.js, …) runs as a SEPARATE
// process from server.js. The runner creates the pending reviews; the server
// resolves them when the tester clicks Accept/Decline in the email. They can
// only share state through disk, so reviews are persisted to a JSON file.
require("dotenv").config();
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const STORE_FILE = path.join(__dirname, "pending-reviews.json");

function loadAll() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); }
  catch (_) { return {}; }
}

function saveAll(map) {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(map, null, 2), "utf8"); }
  catch (err) { console.log(`   ⚠️  Could not persist reviews: ${err.message}`); }
}

// Create a pending review and return it (with a secret token used in the links).
// `data` carries everything needed to build the Jira ticket later on Accept.
function createReview(data) {
  const map   = loadAll();
  const id    = `rv-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const token = crypto.randomBytes(16).toString("hex");
  const review = {
    id,
    token,
    status:        "pending",   // pending | accepted | declined
    createdAt:     new Date().toISOString(),
    decidedAt:     null,
    declineReason: null,
    jiraUrl:       null,
    ...data
  };
  map[id] = review;
  saveAll(map);
  return review;
}

function getById(id) {
  return loadAll()[id] || null;
}

// Apply a decision (status + any extra fields) and stamp the decision time.
function decide(id, patch) {
  const map = loadAll();
  if (!map[id]) return null;
  map[id] = { ...map[id], ...patch, decidedAt: new Date().toISOString() };
  saveAll(map);
  return map[id];
}

// Everything except the secret token (safe to expose to a dashboard).
function getAll() {
  return Object.values(loadAll()).map(({ token, ...rest }) => rest);
}

module.exports = { createReview, getById, decide, getAll };
