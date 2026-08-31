const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const baseUrl = process.env.COVERAGE_BASE_URL || 'http://127.0.0.1:3000';
const artifacts = path.join(root, 'coverage-artifacts');

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(baseUrl)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`TravelTrust did not start at ${baseUrl}`);
}

function filesFromCoverage(rawCoverage) {
  const origin = new URL(baseUrl).origin;
  return rawCoverage.filter((script) => script.url && new URL(script.url).origin === origin).map((script) => {
    const functions = script.functions.map((fn, index) => ({
      name: fn.functionName || (fn.ranges.some((range) => range.startOffset === 0) ? 'Top-level script initialization' : `Anonymous callback ${index}`),
      covered: fn.ranges.some((range) => range.count > 0),
      location: String(fn.ranges[0]?.startOffset ?? index),
    }));
    return { url: script.url, functions, totalFunctions: functions.length, coveredFunctions: functions.filter((fn) => fn.covered).length };
  });
}

async function run() {
  const server = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'inherit' });
  try {
    await waitForServer();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

    await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
    await page.locator('[data-login-tab="admin"]').click();
    await page.locator('#admin-login-panel [name="username"]').fill('admin');
    await page.locator('#admin-login-panel [name="password"]').fill('admin123');
    await page.getByRole('button', { name: /log in as admin/i }).click();
    await page.waitForURL(/\/admin\/claims/);

    await page.goto(`${baseUrl}/contact`, { waitUntil: 'networkidle' });
    await page.getByLabel('Name').fill('CI Coverage');
    await page.getByLabel('Email').fill('ci@example.com');
    await page.getByLabel('Message').fill('This automated test exercises the contact form coverage flow.');
    await page.getByRole('button', { name: /send message/i }).click();

    const rawCoverage = await cdp.send('Profiler.takePreciseCoverage');
    await cdp.send('Profiler.stopPreciseCoverage');
    await cdp.send('Profiler.disable');
    await browser.close();
    fs.mkdirSync(artifacts, { recursive: true });
    const timestamp = new Date().toISOString();
    fs.writeFileSync(path.join(artifacts, 'ci-coverage.json'), JSON.stringify({
      testName: 'CI regression coverage', testSuite: 'CI', environment: 'GitHub Actions',
      buildVersion: process.env.GITHUB_SHA || process.env.BUILD_VERSION || 'local', siteOrigin: baseUrl,
      startedAt: timestamp, stoppedAt: timestamp, coverage: rawCoverage.result, files: filesFromCoverage(rawCoverage.result),
    }, null, 2));
  } finally { server.kill(); }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
