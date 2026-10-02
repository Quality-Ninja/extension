// Execute end to end: the installed extension replays a test in a window it drives through chrome.debugger, against a
// double of the Execute API (tests/server.cjs). No real API, model or website is involved.
const { test, expect, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
let context, worker, panel, dir;
const executablePath = process.env.CHROME_EXTENSION_EXECUTABLE;
const BASE = 'http://127.0.0.1:8765';
const SECRET = 'correct-horse-battery-staple-42';

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaninja-executor-test-'));
  const source = path.resolve(__dirname, '..');
  for (const name of ['manifest.json', 'background.js', 'session.js', 'store.js', 'xpath.js', 'dom.js', 'inspector.js', 'snapshot.js', 'content.js',
    'sidebar.js', 'sidebar.css', 'sidebar.html', 'login.js', 'login.html', 'browser-polyfill.min.js', 'icons', 'fonts', 'dist']) {
    fs.cpSync(path.join(source, name), path.join(dir, name), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'config.js'), `const CONFIG = {API_BASE_URL:'${BASE}',APP_BASE_URL:'${BASE}',CLERK_PUBLISHABLE_KEY:'pk_test_mock',CLERK_SYNC_HOST:'http://127.0.0.1'};`);
  fs.copyFileSync(path.join(__dirname, 'clerk-double.js'), path.join(dir, 'dist/auth.js'));
  context = await chromium.launchPersistentContext('', { ...(executablePath ? { executablePath } : { channel: 'chromium' }), headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--silent-debugger-extension-api'] });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidebar.html`);
  await panel.setViewportSize({ width: 360, height: 780 });
  await worker.evaluate(async () => {
    await NinjaStore.put('settings', { token: 'paid-test-token', subject: 'user_1', sessionId: 'sess_user_1' }, 'test_clerk');
    await refreshAuth(true);
  });
});
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && panel && !panel.isClosed()) {
    await info.attach('panel-state', { body: await panel.locator('body').innerText(), contentType: 'text/plain' });
    await info.attach('api-log', { body: JSON.stringify(await (await fetch(`${BASE}/_exec/log`)).json(), null, 2), contentType: 'application/json' });
  }
  await context?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function scenario(body) {
  await fetch(`${BASE}/_exec/scenario`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const log = async () => (await fetch(`${BASE}/_exec/log`)).json();
function spec(steps, extra = {}) {
  return { version: 1, test: { id: 7, name: 'Checkout', schema_version: 2 }, mode: 'assisted', brain: 'managed', start_url: `${BASE}/shop`,
    allowed_origins: [BASE], steps: steps.map((step, index) => ({ index, id: `s${index}`, label: '', url: `${BASE}/shop`, xpath: '', locators: null,
      override: null, value: null, value_ref: null, key: null, frame_url: null, screenshot: null, screenshot_artifact_id: null, ...step })),
    replaying_trace: false, inputs: {}, secrets: [], assertions: [], goal: '', expected_outcome: '', viewport: { width: 1000, height: 700 },
    budgets: { max_seconds: 900 }, ...extra };
}
async function openExecute() {
  await panel.locator('#mode-execute').evaluate(node => node.click());
  await expect(panel.locator('#execute-tools')).toBeVisible();
  await expect(panel.locator('#exec-test option')).toHaveCount(1);
  if (await panel.locator('#exec-consent').isVisible()) await panel.locator('#exec-consent-accept').click();
  await expect(panel.locator('#exec-consent')).toBeHidden();
}
async function finished() {
  await expect.poll(async () => (await log()).finish, { timeout: 30000 }).not.toBeNull();
  return log();
}
const runPage = async () => {
  await expect.poll(() => context.pages().find(page => /\/(shop|login)$/.test(page.url())), { timeout: 15000 }).toBeTruthy();
  return context.pages().find(page => /\/(shop|login)$/.test(page.url()));
};

test('replays recorded steps with trusted input and keeps secrets in the browser', async () => {
  await scenario({ script: 'none', spec: spec([
    { action_type: 'click', label: 'Add to cart', xpath: "//*[@id='add']" },
    { action_type: 'navigate', url: `${BASE}/login` },
    { action_type: 'fill', label: 'Email', xpath: "//*[@id='email']", value: 'qa@example.com', url: `${BASE}/login` },
    { action_type: 'fill', label: 'Password', xpath: "//*[@id='password']", value_ref: { kind: 'secret', name: 'password_1' }, url: `${BASE}/login` },
    { action_type: 'click', label: 'Sign in', xpath: "//*[@id='submit']", url: `${BASE}/login` },
  ], { brain: 'none', mode: 'replay', secrets: [{ name: 'password_1', label: 'Password' }], assertions: [{ type: 'text_visible', value: 'Welcome qa@example.com' }] }) });
  await openExecute();
  await panel.locator('#exec-brain').selectOption('none');
  await expect(panel.locator('#exec-secret-fields input')).toHaveCount(1);
  await panel.locator('#exec-secret-fields input').fill(SECRET);
  await panel.locator('#exec-start').click();
  const page = await runPage();
  const result = await finished();
  expect(result.finish).toMatchObject({ status: 'completed', verdict: 'PASSED' });
  expect(result.steps.map(step => step.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed']);
  // The password reached the page (its length shows it was typed), but never any request to QA Ninja.
  expect(await page.evaluate(() => window.passwordLength)).toBe(SECRET.length);
  expect(JSON.stringify(result.requests)).not.toContain(SECRET);
  expect(result.artifacts).toBeGreaterThanOrEqual(5);
  await expect(panel.locator('#exec-run-status')).toHaveText('Run passed');
  await expect(panel.locator('#exec-run-steps li')).toHaveCount(5);
});

test('the agent heals a step that no longer replays, and the fix is reported with its locator', async () => {
  await scenario({ script: 'heal', spec: spec([
    { action_type: 'click', label: 'Add to cart', xpath: "//*[@id='add']" },
    { action_type: 'click', label: 'Place order', xpath: "//*[@id='place-order']" },
  ]) });
  await openExecute();
  await panel.locator('#exec-start').click();
  const page = await runPage();
  const result = await finished();
  expect(result.finish).toMatchObject({ status: 'completed', verdict: 'PASSED' });
  const [start, followUp] = result.turns;
  expect(start.episode).toMatchObject({ kind: 'recover', step_index: 1, reason: 'locator_not_found' });
  expect(start.observation.snapshot).toMatch(/button "Buy now" \[ref_\d+\]/);
  expect(followUp.results[0]).toMatchObject({ tool_use_id: 'toolu_1', ok: true });
  const healed = result.steps.find(step => step.step_index === 1);
  expect(healed).toMatchObject({ status: 'healed', resolution: 'agent' });
  // Clicks were real input events, so the page saw them as trusted.
  expect(await page.evaluate(() => window.trusted)).toEqual([['add', true], ['buy', true]]);
  await expect(page.locator('#done')).toBeVisible();
});

test('navigation off the allowed origins is refused, and the agent is told why', async () => {
  await scenario({ script: 'navigate', spec: spec([{ action_type: 'click', label: 'Gone', xpath: "//*[@id='gone']" }]) });
  await openExecute();
  await panel.locator('#exec-start').click();
  const result = await finished();
  const reply = result.turns[1].results[0];
  expect(reply.ok).toBe(false);
  expect(reply.text).toContain('not on an allowed origin');
  expect(result.finish).toMatchObject({ verdict: 'BLOCKED', blocked_reason: 'navigation_blocked' });
  expect(context.pages().some(page => page.url().startsWith('http://127.0.0.1:8764'))).toBe(false);
});

test('Stop ends a run while it is replaying, and the API hears it was cancelled', async () => {
  await scenario({ script: 'none', spec: spec([{ action_type: 'click', label: 'Never appears', xpath: "//*[@id='never']" }], { brain: 'none', mode: 'replay' }) });
  await openExecute();
  await panel.locator('#exec-brain').selectOption('none');
  await panel.locator('#exec-start').click();
  await expect(panel.locator('#exec-stop')).toBeVisible();
  await expect(panel.locator('#exec-run-status')).toContainText('Replaying step 1 of 1');
  await panel.locator('#exec-stop').click();
  const result = await finished();
  expect(result.finish).toMatchObject({ status: 'cancelled' });
  await expect(panel.locator('#exec-run-status')).toHaveText('Run stopped');
});

test('the web app can start a run on this computer, but only for the account signed in here', async () => {
  await scenario({ script: 'none', spec: spec([{ action_type: 'click', label: 'Add to cart', xpath: "//*[@id='add']" }], { brain: 'none', mode: 'replay' }) });
  const extensionId = new URL(worker.url()).hostname;
  const app = await context.newPage();
  await app.goto(`${BASE}/fixture`);
  const send = message => app.evaluate(([id, message]) => new Promise(resolve => chrome.runtime.sendMessage(id, message, resolve)), [extensionId, message]);
  expect(await send({ type: 'QANINJA_PING' })).toMatchObject({ ok: true, signedIn: true, subject: 'user_1', execute: true });
  expect(await send({ type: 'QANINJA_RUN', runId: 'run_' + 'a'.repeat(32), subject: 'user_9', consent: true })).toMatchObject({ ok: false, error: 'account_mismatch' });
  expect(await send({ type: 'QANINJA_RUN', runId: 'run_' + 'a'.repeat(32), subject: 'user_1', consent: true })).toEqual({ ok: true });
  const result = await finished();
  expect(result.requests.some(item => item.url.endsWith('/claim'))).toBe(true);
  expect(result.finish).toMatchObject({ status: 'completed', verdict: 'PASSED' });
});
