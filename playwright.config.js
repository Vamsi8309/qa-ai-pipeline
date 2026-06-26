// Playwright config — runs the AI-generated test scripts.
// Run all generated scripts:  npx playwright test   (or npm run test:e2e)
// In Visual Studio Code: install the "Playwright Test for VSCode" extension,
// then the generated specs appear in the Test Explorer to run/debug visually.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './generated-scripts',     // where script-generator.js saves the .spec.js files
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    headless: true,
    ignoreHTTPSErrors: true,          // tolerate corporate proxy certs
    actionTimeout: 15000,
    navigationTimeout: 30000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
