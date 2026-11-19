const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launchPersistentContext('./user-data', {
    headless: false
  });

  const page = await browser.newPage();
  await page.goto('https://app.asana.com');

  console.log("Login manually, then press Enter...");
  process.stdin.once('data', async () => {
    await browser.close();
    process.exit();
  });
})();