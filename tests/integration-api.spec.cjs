// The extension against the real API (../api), not the double: upload a v2 recording, run it from the panel, and read
// the run back from the API. Skipped when the API checkout or its virtualenv is missing.
const { test, expect, chromium } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const API_DIR = process.env.QANINJA_API_DIR || path.resolve(__dirname, '..', '..', 'api');
const PYTHON = process.env.PYTHON_EXECUTABLE || path.join(API_DIR, 'venv', 'bin', 'python');
const API = 'http://127.0.0.1:8799';
const SITE = 'http://127.0.0.1:8765';
const available = fs.existsSync(path.join(API_DIR, 'tests', 'browser_server.py')) && fs.existsSync(PYTHON);
let server, context, worker, panel, dir;

test.skip(!available, 'needs the API checkout and its virtualenv');

test.beforeAll(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'qaninja-integration-api-'));
  // browser_server.py configures local sign-in and seeds user 1 with a Basic plan; run it on a port of our own.
  // The QA Ninja Agent's model is scripted: it reads the brief the API built and acts on the page the extension saw.
  const script = `import sys, re, pathlib, uvicorn
import browser_server, src.db.database as database, src.db.private_storage as private_storage
from src.agent import brain
from src.agent.providers.anthropic_provider import AnthropicAdapter, CLAUDE_MODELS
from src.agent.providers.base import CallUsage, ModelTurn, ToolCall
class Scripted(AnthropicAdapter):
    def __init__(self):
        self.provider, self.model, self.capabilities = 'anthropic', 'claude-opus-5-5', CLAUDE_MODELS['claude-opus-5-5']
    def call(self, messages, *, effort, loader):
        brief = messages[0]['content'][-1]['text']
        done = any(message['role'] == 'assistant' for message in messages)
        ref = re.search(r'button "Buy now" \\[(ref_\\d+)\\]', brief).group(1)
        step = int(re.search(r'step_index=(\\d+)', brief).group(1))
        call = ToolCall('toolu_done' if done else 'toolu_click', 'report_step_done' if done else 'left_click',
                        {'step_index': step, 'ref': ref, 'summary': 'Clicked Buy now'} if done else {'target': {'type': 'ref', 'ref': ref}}, toolset=not done)
        block = {'type': 'tool_use', 'id': call.id, 'name': call.name, 'input': call.input, **({'toolset_name': 'browser'} if call.toolset else {})}
        return ModelTurn(stop='tool_use', tool_calls=[call], notes='', assistant={'role': 'assistant', 'content': [block]},
                         usage=CallUsage(model=self.model, input_tokens=1000, output_tokens=50, cost_micros=5000))
brain.make_adapter = lambda conn, run: Scripted()
# conftest (imported by browser_server) clears the managed key for unit tests; this server offers the scripted agent.
import os
from src.execute.settings import execute_settings
os.environ['ANTHROPIC_API_KEY'] = 'sk-ant-integration-not-used'
execute_settings.cache_clear()
database.DB_NAME = sys.argv[1] + '/test.db'
private_storage.PRIVATE = pathlib.Path(sys.argv[1], 'private').resolve()
private_storage.BASE = pathlib.Path(sys.argv[1])
uvicorn.run(browser_server.app, host='127.0.0.1', port=8799, log_level='warning')`;
  server = spawn(PYTHON, ['-c', script, data], { cwd: path.join(API_DIR, 'tests'),
    env: { ...process.env, PYTHONPATH: API_DIR, EXECUTE_ENABLED: '1', CONNECTIONS_ENCRYPTION_KEYS: 'k1:' + 'A'.repeat(43), ANTHROPIC_API_KEY: 'sk-ant-integration-not-used' }, stdio: 'inherit' });
  await expect.poll(async () => (await fetch(`${API}/healthz`).catch(() => null))?.ok, { timeout: 30000 }).toBe(true);
});
test.afterAll(() => server?.kill());

test.beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaninja-integration-ext-'));
  const source = path.resolve(__dirname, '..');
  for (const name of ['manifest.json', 'background.js', 'session.js', 'store.js', 'xpath.js', 'dom.js', 'inspector.js', 'snapshot.js', 'content.js',
    'sidebar.js', 'sidebar.css', 'sidebar.html', 'login.js', 'login.html', 'browser-polyfill.min.js', 'icons', 'fonts', 'dist']) {
    fs.cpSync(path.join(source, name), path.join(dir, name), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'config.js'), `const CONFIG = {API_BASE_URL:'${API}',APP_BASE_URL:'${SITE}',CLERK_PUBLISHABLE_KEY:'pk_test_mock',CLERK_SYNC_HOST:'http://127.0.0.1'};`);
  fs.copyFileSync(path.join(__dirname, 'clerk-double.js'), path.join(dir, 'dist/auth.js'));
  const executablePath = process.env.CHROME_EXTENSION_EXECUTABLE;
  context = await chromium.launchPersistentContext('', { ...(executablePath ? { executablePath } : { channel: 'chromium' }), headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`, '--silent-debugger-extension-api'] });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).hostname}/sidebar.html`);
  await panel.setViewportSize({ width: 360, height: 780 });
});
test.afterEach(async () => { await context?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('a v2 recording uploaded to the API replays from the panel and its run reads back from the API', async () => {
  await fetch(`${API}/_test/reset`, { method: 'POST' });
  const { token } = await (await fetch(`${API}/_test/session?user_id=1`)).json();
  const auth = { Authorization: `Bearer ${token}` };
  const id = crypto.randomUUID();
  const recording = { schema_version: 2, id, name: 'Shop', start_url: `${SITE}/shop`, inputs: [], secrets: [{ name: 'password_1', label: 'Password' }],
    steps: [
      { id: 's1', url: `${SITE}/shop`, xpath: "//*[@id='add']", action_type: 'click', label: 'Add to cart' },
      { id: 's2', url: `${SITE}/login`, xpath: '', action_type: 'navigate', label: 'login' },
      { id: 's3', url: `${SITE}/login`, xpath: "//*[@id='email']", action_type: 'fill', label: 'Email', value: 'qa@example.com' },
      { id: 's4', url: `${SITE}/login`, xpath: "//*[@id='password']", action_type: 'fill', label: 'Password', value: '', sensitive: true, value_ref: { kind: 'secret', name: 'password_1' } },
      { id: 's5', url: `${SITE}/login`, xpath: "//*[@id='submit']", action_type: 'click', label: 'Sign in' },
    ] };
  const form = new FormData();
  form.append('metadata', JSON.stringify({ client_id: id, name: 'Shop' }));
  form.append('files', new Blob([JSON.stringify(recording)], { type: 'application/json' }), 'recording.json');
  const uploaded = await (await fetch(`${API}/workflows`, { method: 'POST', headers: auth, body: form })).json();
  expect(uploaded.id).toBeGreaterThan(0);
  const saved = await fetch(`${API}/execute/tests/${uploaded.id}/settings`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ assertions: [{ type: 'text_visible', value: 'Welcome qa@example.com' }], default_mode: 'replay', default_brain: 'none' }) });
  expect(saved.status).toBe(200);
  await worker.evaluate(async token => {
    await NinjaStore.put('settings', { token, subject: 'user_1', sessionId: 'sess_1' }, 'test_clerk');
    await refreshAuth(true);
  }, token);
  await panel.locator('#mode-execute').evaluate(node => node.click());
  await expect(panel.locator('#exec-test option', { hasText: 'Shop' })).toHaveCount(1);
  await panel.locator('#exec-test').selectOption({ label: 'Shop' });
  await panel.locator('#exec-consent-accept').click();
  await expect(panel.locator('#exec-brain')).toHaveValue('none');
  await panel.locator('#exec-secret-fields input').fill('s3cret-value-for-test');
  await panel.locator('#exec-start').click();
  await expect(panel.locator('#exec-run-status')).toHaveText('Run passed', { timeout: 60000 });
  const runs = await (await fetch(`${API}/execute/runs?workflow_id=${uploaded.id}`, { headers: auth })).json();
  const run = await (await fetch(`${API}/execute/runs/${runs.data[0].id}`, { headers: auth })).json();
  expect(run).toMatchObject({ status: 'completed', verdict: 'PASSED', origin: 'extension', brain: 'none', steps_passed: 5, steps_total: 5 });
  expect(run.steps.map(step => step.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed']);
  expect(run.artifacts.length).toBeGreaterThanOrEqual(5);
  expect(run.events.some(event => event.message.includes('text_visible'))).toBe(true);
  const image = await fetch(`${API}/execute/runs/${run.id}/artifacts/${run.artifacts[0].id}`, { headers: auth });
  expect(image.headers.get('content-type')).toBe('image/jpeg');
  expect(JSON.stringify(run)).not.toContain('s3cret-value-for-test');
});

async function upload(auth, steps, name) {
  const id = crypto.randomUUID();
  const form = new FormData();
  form.append('metadata', JSON.stringify({ client_id: id, name }));
  form.append('files', new Blob([JSON.stringify({ schema_version: 2, id, name, start_url: steps[0].url, steps })], { type: 'application/json' }), 'recording.json');
  return (await (await fetch(`${API}/workflows`, { method: 'POST', headers: auth, body: form })).json()).id;
}

test('the QA Ninja Agent heals a renamed button through the real API brain', async () => {
  await fetch(`${API}/_test/reset`, { method: 'POST' });
  const { token } = await (await fetch(`${API}/_test/session?user_id=1`)).json();
  const auth = { Authorization: `Bearer ${token}` };
  const workflowId = await upload(auth, [
    { id: 'a', url: `${SITE}/shop`, xpath: "//*[@id='add']", action_type: 'click', label: 'Add to cart' },
    { id: 'b', url: `${SITE}/shop`, xpath: "//*[@id='place-order']", action_type: 'click', label: 'Place order' },
  ], 'Order');
  await worker.evaluate(async token => {
    await NinjaStore.put('settings', { token, subject: 'user_1', sessionId: 'sess_1' }, 'test_clerk');
    await refreshAuth(true);
  }, token);
  await panel.locator('#mode-execute').evaluate(node => node.click());
  await expect(panel.locator('#exec-test option', { hasText: 'Order' })).toHaveCount(1);
  await panel.locator('#exec-test').selectOption({ label: 'Order' });
  await panel.locator('#exec-consent-accept').click();
  await panel.locator('#exec-brain').selectOption('managed');
  await panel.locator('#exec-mode').selectOption('assisted');
  await panel.locator('#exec-start').click();
  await expect(panel.locator('#exec-run-status')).toHaveText('Run passed', { timeout: 60000 });
  const runs = await (await fetch(`${API}/execute/runs?workflow_id=${workflowId}`, { headers: auth })).json();
  const run = await (await fetch(`${API}/execute/runs/${runs.data[0].id}`, { headers: auth })).json();
  expect(run).toMatchObject({ verdict: 'PASSED', brain: 'managed', healed_steps: 1, model_calls: 2 });
  expect(run.steps[1]).toMatchObject({ status: 'healed', resolution: 'agent' });
  expect(run.steps[1].locator).toMatchObject({ role: 'button', name: 'Buy now' });
  const transcript = await (await fetch(`${API}/execute/runs/${run.id}/transcript`, { headers: auth })).json();
  expect(transcript[0]).toMatchObject({ kind: 'recover', step_index: 1, status: 'step_done' });
  expect(transcript[0].entries.find(entry => entry.type === 'result')).toMatchObject({ error: false });
  const caps = await (await fetch(`${API}/me/capabilities`, { headers: auth })).json();
  expect(caps.execute_managed_used).toBe(1);
  // Accepting the fix makes the agent's locator the step's first choice next time.
  const accepted = await fetch(`${API}/execute/tests/${workflowId}/heals`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id: run.id, step_index: 1 }) });
  expect((await accepted.json()).healed_steps).toBe(1);
});
