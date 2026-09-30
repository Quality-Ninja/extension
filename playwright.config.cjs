const { defineConfig } = require('@playwright/test');
// The extension tests need only the Node mock server; the web app's tests (in app/) run against the real API.
module.exports = defineConfig({
  testDir: './tests', timeout: 30000, workers: 1,
  use: { headless: true, viewport: { width: 900, height: 800 },
    launchOptions: process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {} },
  webServer: [
    { command: 'node tests/server.cjs', port: 8765, reuseExistingServer: false }
  ],
});
