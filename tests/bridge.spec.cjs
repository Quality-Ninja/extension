// The MCP bridge from the extension's side: a fake bridge (standing in for npx @qaninja/mcp) pairs with the panel's code,
// asks for a run, waits for the person's approval, and fixes a broken step as the coding agent would.
const { test, expect, chromium } = require('@playwright/test');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
let context, worker, panel, dir, bridge;
const executablePath = process.env.CHROME_EXTENSION_EXECUTABLE;
const BASE = 'http://127.0.0.1:8765';
const CODE = 'ABCD-2345';
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest('hex');

// A minimal bridge: the real one is the @qaninja/mcp package. Same handshake and messages.
function fakeBridge() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 47821 });
  const state = { socket: null, origin: '', secret: null, pending: new Map(), seq: 0, failures: 0 };
  server.on('connection', (socket, request) => {
    state.origin = request.headers.origin;
    let extNonce, bridgeNonce, mode;
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'hello') {
        extNonce = message.nonce; mode = message.mode; bridgeNonce = crypto.randomBytes(16).toString('hex');
        const key = mode === 'pair' ? Buffer.from(CODE.replace('-', '')) : Buffer.from(state.secret || '', 'hex');
        socket.send(JSON.stringify({ type: 'challenge', nonce: bridgeNonce, proof: hmac(key, `bridge|${extNonce}|${bridgeNonce}`), bridge_id: 'bridge-1', agent: 'claude-code' }));
        state.key = key;
      } else if (message.type === 'proof') {
        if (message.proof !== hmac(state.key, `ext|${bridgeNonce}|${extNonce}`)) { state.failures++; socket.send(JSON.stringify({ type: 'error', code: 'bad_proof' })); socket.close(); return; }
        state.socket = socket;
        if (mode === 'pair') { state.secret = crypto.randomBytes(32).toString('hex'); socket.send(JSON.stringify({ type: 'paired', secret: state.secret, bridge_id: 'bridge-1' })); }
        else socket.send(JSON.stringify({ type: 'ready', bridge_id: 'bridge-1' }));
      } else if (message.type === 'response') {
        state.pending.get(message.id)?.(message); state.pending.delete(message.id);
      }
    });
  });
  state.request = (method, params = {}) => new Promise(resolve => {
    const id = String(++state.seq);
    state.pending.set(id, resolve);
    state.socket.send(JSON.stringify({ type: 'request', id, method, params }));
  });
  state.close = () => new Promise(resolve => { for (const client of server.clients) client.terminate(); server.close(resolve); });
  return state;
}

test.beforeEach(async () => {
  bridge = fakeBridge();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaninja-bridge-test-'));
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
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).hostname}/sidebar.html`);
  await panel.setViewportSize({ width: 360, height: 780 });
  await worker.evaluate(async () => {
    await NinjaStore.put('settings', { token: 'paid-test-token', subject: 'user_1', sessionId: 'sess_user_1' }, 'test_clerk');
    await refreshAuth(true);
  });
});
test.afterEach(async () => { await context?.close(); await bridge?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('pairs with a code, asks before running, and lets the coding agent fix a step', async () => {
  await fetch(`${BASE}/_exec/scenario`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script: 'none', spec: {
    version: 1, test: { id: 7, name: 'Checkout', schema_version: 2 }, mode: 'assisted', brain: 'mcp', start_url: `${BASE}/shop`, allowed_origins: [BASE],
    steps: [
      { index: 0, id: 's0', action_type: 'click', label: 'Add to cart', url: `${BASE}/shop`, xpath: "//*[@id='add']", locators: null, override: null, value: null, value_ref: null, key: null, frame_url: null },
      { index: 1, id: 's1', action_type: 'click', label: 'Place order', url: `${BASE}/shop`, xpath: "//*[@id='place-order']", locators: null, override: null, value: null, value_ref: null, key: null, frame_url: null },
    ], replaying_trace: false, inputs: {}, secrets: [], assertions: [], goal: '', expected_outcome: '', viewport: { width: 1000, height: 700 }, budgets: {} } }) });
  await panel.locator('#mode-execute').evaluate(node => node.click());
  await expect(panel.locator('#bridge-pair')).toBeVisible();
  // A wrong code is refused by the extension's own check of the bridge's proof.
  await panel.locator('#bridge-code').fill('WXYZ-9999');
  await panel.locator('#bridge-pair-button').click();
  await expect(panel.locator('#notice')).toContainText("code does not match");
  await panel.locator('#bridge-code').fill(CODE.toLowerCase());
  await panel.locator('#bridge-pair-button').click();
  await expect(panel.locator('#bridge-status')).toHaveText('Connected to claude-code');
  expect(bridge.origin).toMatch(/^chrome-extension:\/\//);
  expect((await bridge.request('status')).result).toMatchObject({ signed_in: true, approved: false });
  // Running needs the person's approval in the panel.
  const started = bridge.request('run_test', { test_id: 7, mode: 'assisted' });
  await expect(panel.locator('#bridge-approval')).toBeVisible();
  await panel.locator('#bridge-allow').click();
  const needs = (await started).result;
  expect(needs).toMatchObject({ status: 'needs_agent', needs: { kind: 'recover', step_index: 1, reason: 'locator_not_found', step: { label: 'Place order' } } });
  const ref = needs.snapshot.match(/button "Buy now" \[(ref_\d+)\]/)[1];
  const clicked = (await bridge.request('act', { action: 'left_click', input: { target: { type: 'ref', ref } } })).result;
  expect(clicked).toMatchObject({ ok: true });
  const shot = (await bridge.request('screenshot')).result;
  expect(Buffer.from(shot.image, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  const finished = (await bridge.request('step_done', { step_index: 1, ref, summary: 'Clicked "Buy now", the renamed Place order button.' })).result;
  expect(finished).toMatchObject({ status: 'finished', verdict: 'PASSED' });
  const log = await (await fetch(`${BASE}/_exec/log`)).json();
  expect(log.requests.find(item => item.url === '/execute/runs' && item.method === 'POST').body).toContain('"origin":"mcp_local"');
  expect(log.steps.find(step => step.step_index === 1)).toMatchObject({ status: 'healed' });
  // Forgetting the agent removes the pairing.
  await panel.locator('#bridge-forget').click();
  await expect(panel.locator('#bridge-pair')).toBeVisible();
});

test('a slow replay answers "running" so the agent can wait, and Stop ends a run that waits on the agent', async () => {
  await fetch(`${BASE}/_exec/scenario`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script: 'none', spec: {
    version: 1, test: { id: 7, name: 'Checkout', schema_version: 2 }, mode: 'assisted', brain: 'mcp', start_url: `${BASE}/shop`, allowed_origins: [BASE],
    steps: [
      { index: 0, id: 's0', action_type: 'click', label: 'Never appears', url: `${BASE}/shop`, xpath: "//*[@id='never']", locators: null, override: null, value: null, value_ref: null, key: null, frame_url: null },
    ], replaying_trace: false, inputs: {}, secrets: [], assertions: [], goal: '', expected_outcome: '', viewport: { width: 1000, height: 700 }, budgets: {} } }) });
  await panel.locator('#mode-execute').evaluate(node => node.click());
  await panel.locator('#bridge-code').fill(CODE);
  await panel.locator('#bridge-pair-button').click();
  await expect(panel.locator('#bridge-status')).toHaveText('Connected to claude-code');
  // Requests answer within this limit (45 seconds in use), even while the run is still replaying.
  await worker.evaluate(() => NinjaExecutor.bridgeAnswerWithin(1500));
  const started = bridge.request('run_test', { test_id: 7 });
  await panel.locator('#bridge-allow').click();
  const running = (await started).result;
  expect(running).toMatchObject({ status: 'running', run_id: expect.stringMatching(/^run_[0-9a-f]{32}$/) });
  let state = running;
  for (let attempt = 0; attempt < 20 && state.status === 'running'; attempt++) state = (await bridge.request('wait')).result;
  expect(state).toMatchObject({ status: 'needs_agent', run_id: running.run_id, needs: { kind: 'recover', step_index: 0 } });
  expect(state.seq).toBeGreaterThan(running.seq);
  // The person stops the run while it waits for the agent; the agent hears it finished.
  const waiting = bridge.request('wait');
  await panel.locator('#exec-stop').click();
  expect((await waiting).result).toMatchObject({ status: 'finished', run_id: running.run_id });
  await expect.poll(async () => (await (await fetch(`${BASE}/_exec/log`)).json()).finish).toMatchObject({ status: 'cancelled' });
  await expect(panel.locator('#exec-run-status')).toHaveText('Run stopped');
});
